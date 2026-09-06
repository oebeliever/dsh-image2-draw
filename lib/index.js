/**
 * dsh-image2-draw — image2（gpt-image-2）生图插件（host 半）。
 *
 * 仿官方 `@deepseek-ai/dsh-web-search-deepseek` 的形态：
 *  - 配置统一为「API Key + 接口地址」：`installSettingsSection` 注册命名空间
 *    `image2-draw`（组合 entry 为 base 层，用户设置在设置页覆盖），provider
 *    每次调用从 `current()` 读当前值，改动即时生效；
 *  - 密钥走 `ctx.credentials`（默认引用 `IMAGE2_API_KEY`），绝不进设置文档；
 *  - 工具 `image2-generate`（文生图）/ `image2-edit`（图生图）；
 *  - 平台边界：第三方命名空间不在 apiproxy 白名单，客户端数据通道用插件自有
 *    webServer 路由（`/image2-draw/state` + `/image2-draw/mutate`）。
 *
 * 顶层零外部依赖（纯函数可 node 直接测试）；@deepseek-ai/* 均在 apply 内动态
 * 导入，`deps` 为测试注入点。
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const name = 'image2-draw'
export const inject = ['tools', 'credentials']

const NS = 'image2-draw'
const DEFAULT_KEY_ENV = 'IMAGE2_API_KEY'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_TIMEOUT_SECONDS = 180
const DEFAULT_OUTPUT_DIR = 'outputs/image2'

const MIN_TOTAL_PIXELS = 655_360
const MAX_TOTAL_PIXELS = 8_294_400
const MAX_EDGE = 3840
const SIZE_MULTIPLE = 16
const MAX_ASPECT_RATIO = 3.0
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
const MAX_INPUT_BYTES = 4 * 1024 * 1024
const MAX_INPUT_IMAGES = 8
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 48 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
const DOWNLOAD_TIMEOUT_SECONDS = 120
const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 3600
const QUALITIES = ['low', 'medium', 'high', 'auto']
const MUTABLE_SETTINGS_FIELDS = new Set(['baseURL', 'model', 'editURL', 'timeoutSeconds'])
const SAFE_SETTINGS_FIELDS = ['apiKeyEnv', 'baseURL', 'model', 'editURL', 'timeoutSeconds']

const PORTRAIT_WORDS = ['竖版', '竖屏', '纵向', '手机壁纸', '人像', 'portrait', 'vertical', '9:16', '2:3']
const LANDSCAPE_WORDS = ['横版', '横屏', '横幅', '桌面壁纸', '封面', 'landscape', 'horizontal', '16:9', '3:2']
const SQUARE_WORDS = ['方图', '正方形', '头像', '图标', 'square', '1:1', 'avatar', 'icon']

// 预置尺寸映射：对齐 OpenAI Images（gpt-image 系）公开规格 ——
// 常见网关（如 OpenAI 兼容中转）只接受 auto 或 1024x1024 / 1536x1024 / 1024x1536 /
// 3840x2160 等列表内尺寸；旧的 768x1024 / 1024x768 会被部分网关 400 拒绝。
const PRESET_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '3840x2160', '2160x3840']

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/* ------------------------------------------------------------------ *
 * 常量与纯函数（可测试）
 * ------------------------------------------------------------------ */

export function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function isCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

function httpUrl(value, label) {
  const text = String(value ?? '').trim()
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label}必须是合法的 http(s) URL（当前：${value}）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}必须是 http(s) URL（当前：${value}）`)
  }
  return parsed
}

/** 把 baseURL 规范化为完整的 `/images/generations` 端点；未配置时给出设置指引。 */
export function normalizeGenerationsUrl(baseUrl) {
  const text = String(baseUrl ?? '').trim()
  if (text === '') {
    throw new Error('未配置接口地址（baseURL），请到 设置 → 插件 → 插件配置 填写（格式如 https://example.com/v1）')
  }
  const parsed = httpUrl(text, '接口地址')
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = path.endsWith('/images/generations') ? path : `${path}/images/generations`
  return parsed.toString()
}

/** 图生图端点：优先显式 editURL，其次由 generations 端点推导。 */
export function editUrlOf(settings) {
  const explicit = String(settings?.editURL ?? '').trim()
  if (explicit !== '') return httpUrl(explicit, '图生图端点').toString()
  const generationsUrl = normalizeGenerationsUrl(settings?.baseURL)
  const parsed = new URL(generationsUrl)
  parsed.pathname = parsed.pathname.slice(0, -'/images/generations'.length) + '/images/edits'
  return parsed.toString()
}

/** 解析并限制 API 请求超时，避免负数、无穷值或异常长定时器。 */
export function timeoutMsOf(settings) {
  const seconds = settings?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (!Number.isInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds 必须是 ${MIN_TIMEOUT_SECONDS}~${MAX_TIMEOUT_SECONDS} 的整数`)
  }
  return seconds * 1000
}

/** 校验 schema 无法表达的配置约束。 */
export function validateSettings(value) {
  const settings = objectOf(value)
  if (settings.apiKeyEnv !== undefined) {
    const ref = String(settings.apiKeyEnv).trim()
    if (ref !== '' && !isCredentialRef(ref)) throw new Error('apiKeyEnv 必须是环境变量式名称')
  }
  if (String(settings.baseURL ?? '').trim() !== '') normalizeGenerationsUrl(settings.baseURL)
  if (String(settings.editURL ?? '').trim() !== '') httpUrl(settings.editURL, '图生图端点')
  timeoutMsOf(settings)
}

/** 依据提示词关键词选择竖版/横版/方图（返回网关通用尺寸）。 */
export function adaptiveSize(prompt, fallback) {
  const text = String(prompt ?? '').toLowerCase()
  if (PORTRAIT_WORDS.some(word => text.includes(word))) return '1024x1536'
  if (LANDSCAPE_WORDS.some(word => text.includes(word))) return '1536x1024'
  if (SQUARE_WORDS.some(word => text.includes(word))) return '1024x1024'
  return fallback
}

/** 解析尺寸：adaptive/auto/别名/WxH，校验与 image2.py 相同。 */
export function resolveSize(value, prompt, fallback) {
  const aliases = {
    portrait: '1024x1536',
    vertical: '1024x1536',
    landscape: '1536x1024',
    horizontal: '1536x1024',
    square: '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '1:1': '1024x1024',
  }
  let raw = String(value ?? 'adaptive').trim().toLowerCase()
  if (raw === 'auto') return 'auto'
  if (raw === 'adaptive') raw = adaptiveSize(prompt, fallback)
  raw = (aliases[raw] ?? raw).replaceAll('*', 'x')
  if (PRESET_SIZES.includes(raw)) return raw
  const match = /^(\d+)x(\d+)$/.exec(raw)
  if (!match) {
    throw new Error('非法尺寸，请用 adaptive、portrait、landscape、square 或 WIDTHxHEIGHT')
  }
  const width = Number(match[1])
  const height = Number(match[2])
  const errors = []
  if (width % SIZE_MULTIPLE || height % SIZE_MULTIPLE) errors.push(`两边都必须是 ${SIZE_MULTIPLE} 的倍数`)
  if (Math.max(width, height) > MAX_EDGE) errors.push(`最长边不能超过 ${MAX_EDGE}`)
  const pixels = width * height
  if (!(pixels >= MIN_TOTAL_PIXELS && pixels <= MAX_TOTAL_PIXELS)) {
    errors.push(`总像素必须在 [${MIN_TOTAL_PIXELS}, ${MAX_TOTAL_PIXELS}] 内`)
  }
  if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT_RATIO) {
    errors.push(`宽高比不能超过 ${MAX_ASPECT_RATIO}:1`)
  }
  if (errors.length > 0) throw new Error(`非法尺寸 ${width}x${height}：${errors.join('；')}`)
  return `${width}x${height}`
}

/** 组装文生图请求体（OpenAI images 兼容）。
 * 适配说明：仅发送标准 /v1/images/generations 字段（model/prompt/size/quality/n）；
 * 原实现的 output_format 不在 OpenAI Images 标准参数表内，部分网关会拒绝，已移除。
 */
export function buildGeneratePayload(settings, params) {
  return {
    model: settings?.model ?? DEFAULT_MODEL,
    prompt: params.prompt,
    size: params.size,
    quality: params.quality,
    n: 1,
  }
}

/** 解析密钥：字面 apiKey（组合层）优先，否则走 credentials 引用。 */
export async function resolveKey(ctx, settings) {
  const literal = String(settings?.apiKey ?? '').trim()
  if (literal !== '') return literal
  const ref = String(settings?.apiKeyEnv ?? DEFAULT_KEY_ENV).trim() || DEFAULT_KEY_ENV
  if (!isCredentialRef(ref)) throw new Error(`apiKeyEnv「${ref}」不合法（须为环境变量式名称，如 IMAGE2_API_KEY）`)
  const credential = await ctx.credentials.resolve(ref)
  if (!credential) {
    throw new Error(`未配置密钥（credentialRef=${ref}）。请到 设置 → 插件 → 插件配置 填写 API Key；若你的中转按分组隔离模型（如仅 openai/Image 分组提供图片模型），请使用其 Image/图片 分组的密钥`)
  }
  return credential.value
}

/** 魔数识别图片扩展名。 */
export function detectedImageType(blob) {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { extension: '.png', mime: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' }
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { extension: '.webp', mime: 'image/webp' }
  }
  throw new Error('返回数据不是可识别的 PNG/JPEG/WebP 图片')
}

export function detectedExtension(blob) {
  return detectedImageType(blob).extension
}

function timestampNow(date) {
  const d = date ?? new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 重名自动编号，不覆盖已有输出。 */
export function availablePath(path) {
  if (!existsSync(path)) return path
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.replace(/(\.[^./\\]+)?$/, `-${index}$1`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`无法为 ${path} 找到未占用的文件名`)
}

/** 保存图片字节到 outputDir 下 `image2-<时间戳>[-N].<ext>`（与 image2.py 命名一致）。 */
export function saveBlob(blob, outputDir, options = {}) {
  const extension = detectedExtension(blob)
  const count = options.count ?? 1
  const index = options.index ?? 1
  const suffix = count > 1 ? `-${index}` : ''
  const path = availablePath(join(resolve(outputDir), `image2-${timestampNow()}${suffix}${extension}`))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, blob)
  return path
}

async function saveConversationImage(ctx, blob, file) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return undefined
  const limit = attachments.imageLimits?.maxImageBytes
  if (Number.isFinite(limit) && blob.length > limit) {
    ctx.logger?.warn?.(`image2-draw: 图片 ${file} 超过会话附件上限，已保留本地文件但不在聊天中显示`)
    return undefined
  }
  try {
    const type = detectedImageType(blob)
    const ref = await attachments.saveImage({
      data: new Uint8Array(blob),
      mediaType: type.mime,
      name: basename(file),
    })
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
    }
  } catch (error) {
    ctx.logger?.warn?.(`image2-draw: 保存会话图片附件失败，已保留本地文件：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function attachmentMarkerOf(images) {
  const encoded = Buffer.from(JSON.stringify(images), 'utf8').toString('base64')
  return `<!-- image2-attachments-base64:${encoded} -->`
}

function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function outputBaseOf(exec) {
  return join(sessionCwdOf(exec), DEFAULT_OUTPUT_DIR)
}

/* ------------------------------------------------------------------ *
 * 运行期（需要 ctx）
 * ------------------------------------------------------------------ */

function combinedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) {
    onAbort()
  } else if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    },
  }
}

async function httpFetch(url, init, timeoutMs, execSignal, consume) {
  const combined = combinedSignal(execSignal, timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: combined.signal })
    return await consume(response)
  } catch (error) {
    if (execSignal?.aborted === true) throw new Error('cancelled')
    if (combined.timedOut()) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）；上游可能仍在生成，未自动重试`)
    }
    throw error
  } finally {
    combined.cleanup()
  }
}

async function readResponseBodyLimited(response, maxBytes, label) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label}超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 上限`)
  }
  if (response.body === null) return Buffer.alloc(0)

  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error(`${label}超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 上限`)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function errorFromHttp(status, body) {
  let detail = ''
  try {
    detail = JSON.stringify(JSON.parse(body.toString('utf8')), null, 0).slice(0, 500)
  } catch {
    detail = body.toString('utf8').slice(0, 500)
  }
  return new Error(`HTTP ${status}${detail ? `：${detail}` : ''}`)
}

async function postJson(url, apiKey, payload, timeoutMs, execSignal) {
  const body = await httpFetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'dsh-image2-draw/1.0',
    },
    body: JSON.stringify(payload),
  }, timeoutMs, execSignal, async (response) => {
    if (!response.ok || response.status >= 300) {
      const errorBody = await readResponseBodyLimited(response, MAX_ERROR_RESPONSE_BYTES, 'API 错误响应')
      const location = response.headers.get('location') ?? ''
      if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        throw new Error(
          location.includes('region-unavailable')
            ? '上游地区不可用（region-unavailable）：当前网络出口 IP 被该服务商限制（通常为中国大陆地区封锁）。请改用海外代理节点并重启 GUI，或更换支持当前地区的中转服务。'
            : `上游返回重定向 HTTP ${response.status} → ${location || '(无 Location 头)'}。请检查 baseURL 是否正确、是否需要登录或该地区是否受限。`
        )
      }
      throw errorFromHttp(response.status, errorBody)
    }
    return readResponseBodyLimited(response, MAX_JSON_RESPONSE_BYTES, 'API JSON 响应')
  })
  let value
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    const snippet = body.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
    throw new Error(`API 返回的不是合法 JSON（实际收到：${snippet || '空响应'}）。可能是网关错误页、地区拦截页或接口地址有误，请检查网络与 baseURL。`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('API 响应必须是 JSON 对象')
  return value
}

async function postForm(url, apiKey, form, timeoutMs, execSignal) {
  const body = await httpFetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'dsh-image2-draw/1.0',
    },
    body: form,
  }, timeoutMs, execSignal, async (response) => {
    if (!response.ok || response.status >= 300) {
      const errorBody = await readResponseBodyLimited(response, MAX_ERROR_RESPONSE_BYTES, 'API 错误响应')
      const location = response.headers.get('location') ?? ''
      if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        throw new Error(
          location.includes('region-unavailable')
            ? '上游地区不可用（region-unavailable）：当前网络出口 IP 被该服务商限制（通常为中国大陆地区封锁）。请改用海外代理节点并重启 GUI，或更换支持当前地区的中转服务。'
            : `上游返回重定向 HTTP ${response.status} → ${location || '(无 Location 头)'}。请检查 baseURL 是否正确、是否需要登录或该地区是否受限。`
        )
      }
      throw errorFromHttp(response.status, errorBody)
    }
    return readResponseBodyLimited(response, MAX_JSON_RESPONSE_BYTES, 'API JSON 响应')
  })
  let value
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    const snippet = body.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
    throw new Error(`API 返回的不是合法 JSON（实际收到：${snippet || '空响应'}）。可能是网关错误页、地区拦截页或接口地址有误，请检查网络与 baseURL。`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('API 响应必须是 JSON 对象')
  return value
}

async function downloadImage(url, execSignal) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('返回的图片 URL 必须使用 http(s)')
  return httpFetch(
    url,
    { headers: { 'User-Agent': 'dsh-image2-draw/1.0' } },
    DOWNLOAD_TIMEOUT_SECONDS * 1000,
    execSignal,
    async (response) => {
      if (!response.ok) {
        const body = await readResponseBodyLimited(response, MAX_ERROR_RESPONSE_BYTES, '图片下载错误响应')
        throw errorFromHttp(response.status, body)
      }
      return readResponseBodyLimited(response, MAX_DOWNLOAD_BYTES, '返回图片')
    },
  )
}

function decodeBase64Image(value, maxBytes = MAX_DOWNLOAD_BYTES) {
  const encoded = String(value)
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4
  if (encoded.length > maxEncodedLength) throw new Error(`返回图片超过下载上限 ${maxBytes} 字节`)
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('API 返回了非法 base64 图片数据')
  }
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length > maxBytes) throw new Error(`返回图片超过下载上限 ${maxBytes} 字节`)
  detectedImageType(blob)
  return blob
}

async function decodeImages(result, execSignal) {
  const images = []
  for (const item of Array.isArray(result?.data) ? result.data : []) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      images.push(decodeBase64Image(item.b64_json))
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      const blob = await downloadImage(item.url, execSignal)
      detectedImageType(blob)
      images.push(blob)
    }
  }
  if (images.length === 0) {
    throw new Error('API 未返回可识别的图片数据（data[].b64_json / data[].url 均为空）')
  }
  return images
}

async function generateOnce(ctx, settings, params, exec) {
  const payload = buildGeneratePayload(settings, params)
  const url = normalizeGenerationsUrl(settings?.baseURL)
  const apiKey = await resolveKey(ctx, settings)
  const timeoutMs = timeoutMsOf(settings)
  const result = await postJson(url, apiKey, payload, timeoutMs, exec?.signal)
  const blobs = await decodeImages(result, exec?.signal)
  if (blobs.length !== 1) throw new Error(`期望 n=1 返回一张图，实际收到 ${blobs.length} 张`)
  const file = saveBlob(blobs[0], outputBaseOf(exec), {})
  const image = await saveConversationImage(ctx, blobs[0], file)
  return {
    files: [file],
    images: image === undefined ? [] : [image],
    provider: 'image2',
    model: settings?.model ?? DEFAULT_MODEL,
    size: params.size,
    quality: params.quality,
  }
}

function readReferenceImages(refs, exec) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error('图生图至少需要一张参考图（refs）')
  if (refs.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  const parts = []
  let totalBytes = 0
  for (const ref of refs) {
    const text = String(ref ?? '').trim()
    if (text === '') throw new Error('参考图路径不能为空')
    const path = resolve(sessionCwdOf(exec), text)
    let bytes
    try {
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error('不是普通文件')
      if (stat.size > MAX_INPUT_BYTES) {
        throw new Error(`超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限；Node 端不缩放，请先缩小图片`)
      }
      totalBytes += stat.size
      if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new Error(`参考图总大小超过 ${MAX_TOTAL_INPUT_BYTES / 1024 / 1024}MB 上限`)
      }
      bytes = readFileSync(path)
    } catch (error) {
      throw new Error(`参考图不存在或不可读：${path}（${error.message}）`)
    }
    if (bytes.length > MAX_INPUT_BYTES) {
      throw new Error(`参考图超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限（${path}）；Node 端不缩放，请先缩小图片`)
    }
    const type = detectedImageType(bytes)
    const originalName = basename(path)
    const name = `${basename(originalName, extname(originalName))}${type.extension}`
    parts.push({ bytes, name, mime: type.mime, path })
  }
  return parts
}

/**
 * 组装 /images/edits 的 multipart 表单。
 * 兼容说明：OpenAI Images 图生图以「重复 image 字段」表达多张源图
 * （gpt-image 系支持一张或多张参考图；部分中转网关不接受非标准 image[] 字段）。
 */
export function buildEditForm(settings, params, parts) {
  const form = new FormData()
  for (const part of parts) {
    form.append('image', new Blob([part.bytes], { type: part.mime }), part.name)
  }
  form.append('model', settings?.model ?? DEFAULT_MODEL)
  form.append('prompt', params.prompt)
  form.append('size', params.size)
  form.append('quality', params.quality)
  form.append('n', '1')
  form.append('output_format', 'png')
  return form
}

/** 基于已解析的参考图 parts（{bytes,name,mime}）执行一次图生图。 */
async function editPartsOnce(ctx, settings, params, parts, exec) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('图生图至少需要一张参考图')
  if (parts.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  const url = editUrlOf(settings)
  const apiKey = await resolveKey(ctx, settings)
  const form = buildEditForm(settings, params, parts)
  const timeoutMs = timeoutMsOf(settings)
  const result = await postForm(url, apiKey, form, timeoutMs, exec?.signal)
  const blobs = await decodeImages(result, exec?.signal)
  if (blobs.length !== 1) throw new Error(`期望 n=1 返回一张图，实际收到 ${blobs.length} 张`)
  const file = saveBlob(blobs[0], outputBaseOf(exec), {})
  const image = await saveConversationImage(ctx, blobs[0], file)
  return {
    files: [file],
    images: image === undefined ? [] : [image],
    provider: 'image2',
    model: settings?.model ?? DEFAULT_MODEL,
    size: params.size,
    quality: params.quality,
  }
}

async function editOnce(ctx, settings, params, exec) {
  const parts = readReferenceImages(params.refs, exec)
  return editPartsOnce(ctx, settings, params, parts, exec)
}

/* ------------------------------------------------------------------ *
 * Studio（可视化生图工作台）引擎与文件服务
 *
 * 与对话工具的分工：
 *  - 对话工具（image2-generate / image2-edit）：结果保存到会话 outputs/image2；
 *  - 工作台（聊天输入区 dock）：结果统一保存到 ~/.dsh/storages/image2-draw/library，
 *    用短 token 经 /image2-draw/studio/file 取回展示（同 video 工作台的持久模式）；
 *  - 上传素材放系统临时目录（提交后即清理）；任务在 host 内存执行，不做会话附件注入。
 * ------------------------------------------------------------------ */

const STUDIO_LIB_NAME = 'image2-draw'
const STUDIO_TASK_MAX = 40
const STUDIO_TASK_EXPIRY_MS = 30 * 60 * 1000
const STUDIO_SAFE_NAME = /^[A-Za-z0-9._-]{1,160}$/

function studioSanitizeId(value) {
  const text = String(value ?? 'shared').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)
  return text === '' ? 'shared' : text
}

/** 工作台目录：素材上传在系统临时目录；生成结果在持久库目录。 */
export function studioDirsOf(sessionId) {
  const safe = studioSanitizeId(sessionId)
  const tmpRoot = join(tmpdir(), 'dsh-image2-draw', safe)
  return { tmpRoot, uploads: join(tmpRoot, 'uploads'), results: studioLibRoot() }
}

export function studioLibRoot() {
  return join(homedir() ?? tmpdir(), '.dsh', 'storages', STUDIO_LIB_NAME, 'library')
}

/** 保存一次上传：校验类型与大小，返回 { id, name, size }（id 为服务端随机名）。 */
export function studioStoreUpload(sessionId, bytes, originalName) {
  const { uploads } = studioDirsOf(sessionId)
  mkdirSync(uploads, { recursive: true })
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length === 0) throw new Error('上传内容为空')
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`单张图片超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限`)
  const detected = detectedImageType(bytes)
  const extension = detected.extension
  const original = String(originalName ?? '').replace(/[\\/]/g, '_').slice(0, 120) || 'image'
  const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}${extension}`
  writeFileSync(join(uploads, id), bytes)
  return { id, name: original, size: bytes.length }
}

export function studioCleanUploads(sessionId) {
  try {
    rmSyncSafe(studioDirsOf(sessionId).uploads)
  } catch {
    // 忽略清理失败
  }
}

/** 按上传 id 定位文件（服务端生成名，天然防穿越）。 */
export function studioUploadPathOf(sessionId, id) {
  const text = String(id ?? '')
  if (!STUDIO_SAFE_NAME.test(text)) throw new Error('素材 id 不合法')
  const path = join(studioDirsOf(sessionId).uploads, text)
  if (!existsSync(path)) throw new Error(`素材不存在或已过期：${text}`)
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('素材不是普通文件')
  return { path, size: stat.size }
}

/** 结果文件落库：library/<时间戳>-<随机>.ext。 */
export function studioSaveResult(bytes, sessionId) {
  const dir = studioDirsOf(sessionId).results
  mkdirSync(dir, { recursive: true })
  const detected = detectedImageType(bytes)
  const extension = detected.extension
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const name = `image2-${stamp}-${randomBytes(3).toString('hex')}${extension}`
  writeFileSync(join(dir, name), bytes)
  return { token: name, name, size: bytes.length }
}

export function studioResultPathOf(sessionId, token) {
  const text = String(token ?? '')
  if (!STUDIO_SAFE_NAME.test(text)) throw new Error('文件名不合法')
  const path = join(studioDirsOf(sessionId).results, text)
  if (!existsSync(path)) throw new Error('文件不存在或已过期')
  return path
}

function rmSyncSafe(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
}

function studioContentTypeOf(token) {
  const lower = String(token).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

export async function studioServeFile(sessionId, token, res) {
  let path
  try {
    path = studioResultPathOf(sessionId, token)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`文件不存在或已过期：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const stat = statSync(path)
  res.writeHead(200, {
    'content-type': studioContentTypeOf(token),
    'content-length': String(stat.size),
    'cache-control': 'private, max-age=3600',
    'content-disposition': `inline; filename="${encodeURIComponent(token)}"`,
  })
  await new Promise((resolveStream) => {
    const stream = createReadStream(path)
    stream.on('error', () => {
      try { res.destroy() } catch { /* noop */ }
      resolveStream()
    })
    res.on('close', () => stream.destroy())
    stream.on('end', resolveStream)
    stream.pipe(res)
  })
}

/* 工作台任务：内存态（GUI 重启即失效，客户端轮询失败会提示重试） */
const studioTasks = new Map()
let studioTaskSeq = 0

export function studioTaskCreate(mode, input) {
  studioTrimTasks()
  const id = `t${(++studioTaskSeq).toString(36)}${randomBytes(4).toString('hex')}`
  const task = {
    id,
    mode,
    status: 'queued',
    createdAt: Date.now(),
    input,
    result: undefined,
    error: undefined,
  }
  studioTasks.set(id, task)
  return task
}

export function studioTaskGet(id) {
  const task = studioTasks.get(String(id ?? ''))
  return task === undefined ? undefined : {
    id: task.id,
    mode: task.mode,
    status: task.status,
    error: task.error,
    result: task.result,
  }
}

function studioTrimTasks() {
  const now = Date.now()
  for (const [id, task] of studioTasks) {
    if (task.status !== 'running' && now - task.createdAt > STUDIO_TASK_EXPIRY_MS) studioTasks.delete(id)
  }
  const live = [...studioTasks.values()].filter(task => task.status === 'running').length
  let overflow = studioTasks.size - STUDIO_TASK_MAX
  if (overflow <= 0 && live <= 2) return
  const idle = [...studioTasks.values()]
    .filter(task => task.status !== 'running')
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const task of idle) {
    if (overflow <= 0 && live <= 2) break
    studioTasks.delete(task.id)
    overflow -= 1
  }
}

/** 工作台专用的一次生成（结果落库 + 短 token，不写会话附件/不落 outputs）。 */
async function studioGenerateOnce(ctx, settings, params, sessionId) {
  const payload = buildGeneratePayload(settings, params)
  const url = normalizeGenerationsUrl(settings?.baseURL)
  const apiKey = await resolveKey(ctx, settings)
  const timeoutMs = timeoutMsOf(settings)
  const result = await postJson(url, apiKey, payload, timeoutMs)
  const blobs = await decodeImages(result)
  if (blobs.length !== 1) throw new Error(`期望 n=1 返回一张图，实际收到 ${blobs.length} 张`)
  const saved = studioSaveResult(blobs[0], sessionId)
  return saved
}

/** 工作台专用图生图（多张源图 → 一次 edits，结果落库 + 短 token）。 */
async function studioEditOnce(ctx, settings, params, parts, sessionId) {
  const url = editUrlOf(settings)
  const apiKey = await resolveKey(ctx, settings)
  const form = buildEditForm(settings, params, parts)
  const timeoutMs = timeoutMsOf(settings)
  const result = await postForm(url, apiKey, form, timeoutMs)
  const blobs = await decodeImages(result)
  if (blobs.length !== 1) throw new Error(`期望 n=1 返回一张图，实际收到 ${blobs.length} 张`)
  return studioSaveResult(blobs[0], sessionId)
}

function studioValidatedBody(body, sessionId) {
  const mode = String(body?.mode ?? '').trim()
  if (mode !== 'generate' && mode !== 'edit') throw new Error('mode 必须是 generate 或 edit')
  const prompt = String(body?.prompt ?? '').trim()
  if (prompt === '') throw new Error('提示词不能为空')
  if (prompt.length > 30000) throw new Error('提示词最多 30,000 字符')
  const settingsLike = { baseURL: body?.baseURL, model: body?.model, editURL: body?.editURL, timeoutSeconds: body?.timeoutSeconds }
  const settings = objectOf(settingsLike)
  const size = resolveSize(body?.size, prompt, '1024x1024')
  const quality = String(body?.quality ?? 'low').trim() || 'low'
  if (!QUALITIES.includes(quality)) throw new Error(`quality 必须是 ${QUALITIES.join('/')}`)
  return { mode, prompt, size, quality }
}

function studioUploadsToParts(sessionId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('图生图至少需要一张参考图')
  if (ids.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  const parts = []
  let totalBytes = 0
  for (const id of ids) {
    const { path } = studioUploadPathOf(sessionId, id)
    const bytes = readFileSync(path)
    if (bytes.length > MAX_INPUT_BYTES) throw new Error(`参考图超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限`)
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_INPUT_BYTES) throw new Error(`参考图总大小超过 ${MAX_TOTAL_INPUT_BYTES / 1024 / 1024}MB 上限`)
    const type = detectedImageType(bytes)
    parts.push({ bytes, name: `${id}${type.extension}`, mime: type.mime })
  }
  return parts
}

/** 运行一个工作台任务（后台执行，不阻塞 HTTP 响应）。 */
export async function runStudioTask(ctx, task, current) {
  const sessionId = studioSanitizeId(task.sessionId ?? 'shared')
  try {
    task.status = 'running'
    const settings = objectOf(current())
    const input = task.input
    const params = { prompt: input.prompt, size: input.size, quality: input.quality }
    const saved = []
    if (task.mode === 'generate') {
      const count = Math.min(Math.max(Number(input.count) || 1, 1), 8)
      for (let index = 0; index < count; index += 1) {
        saved.push(await studioGenerateOnce(ctx, settings, params, sessionId))
      }
    } else {
      const parts = studioUploadsToParts(sessionId, input.images)
      saved.push(await studioEditOnce(ctx, settings, params, parts, sessionId))
    }
    task.status = 'done'
    task.result = {
      images: saved,
      model: settings?.model ?? DEFAULT_MODEL,
      size: input.size,
      quality: input.quality,
      mode: task.mode,
    }
  } catch (error) {
    task.status = 'failed'
    task.error = error instanceof Error ? error.message : String(error)
  } finally {
    studioCleanUploads(sessionId)
  }
}

/* ------------------------------------------------------------------ *
 * 插件自有 HTTP API（webServer /image2-draw 前缀路由）
 * ------------------------------------------------------------------ */

function respondJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function attachmentRefFromUrl(url) {
  const attachmentId = url.searchParams.get('id') ?? ''
  const mediaType = url.searchParams.get('mediaType') ?? ''
  const bytes = Number(url.searchParams.get('bytes'))
  const width = Number(url.searchParams.get('width'))
  const height = Number(url.searchParams.get('height'))
  if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw new Error('附件 id 不合法')
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new Error('附件类型不合法')
  if (![bytes, width, height].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('附件元数据不合法')
  }
  return { attachmentId, mediaType, bytes, width, height }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体超过 1MB 上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function safeSettingsValue(value) {
  const source = objectOf(value)
  const safe = {}
  for (const field of SAFE_SETTINGS_FIELDS) {
    if (Object.hasOwn(source, field)) safe[field] = source[field]
  }
  return safe
}

/** 命名空间当前视图：值 + revision + 可写性。 */
function currentDescriptor(ctx, current) {
  const settings = ctx.get('settings')
  const all = settings?.describe?.({ redactSecrets: true }) ?? []
  const descriptor = all.find(entry => String(entry?.ns) === NS)
  return {
    value: safeSettingsValue(descriptor?.value ?? current()),
    revision: descriptor?.revision ?? 0,
    writable: settings?.writable ?? true,
  }
}

function validateMutationBody(body) {
  if (!Number.isInteger(body?.expectedRevision) || body.expectedRevision < 0) {
    throw new Error('expectedRevision 必须是非负整数')
  }
  if (!Array.isArray(body?.ops) || body.ops.length === 0 || body.ops.length > 16) {
    throw new Error('ops 必须是包含 1~16 项的数组')
  }
  const fields = new Set()
  for (const operation of body.ops) {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('每个 op 都必须是对象')
    }
    if (operation.op !== 'set' && operation.op !== 'unset') throw new Error('op 只允许 set 或 unset')
    if (!Array.isArray(operation.path) || operation.path.length !== 1 || typeof operation.path[0] !== 'string') {
      throw new Error('path 必须是单段字段路径')
    }
    const field = operation.path[0]
    if (!MUTABLE_SETTINGS_FIELDS.has(field)) throw new Error(`字段 ${field} 不允许通过此接口修改`)
    if (fields.has(field)) throw new Error(`字段 ${field} 在一次请求中不能重复修改`)
    fields.add(field)
    if (operation.op === 'unset') continue

    if (field === 'timeoutSeconds') {
      timeoutMsOf({ timeoutSeconds: operation.value })
      continue
    }
    if (typeof operation.value !== 'string') throw new Error(`字段 ${field} 必须是字符串`)
    const value = operation.value.trim()
    if (value === '') throw new Error(`字段 ${field} 不能为空；清空请使用 unset`)
    if ((field === 'baseURL' || field === 'editURL') && value.length > 4096) throw new Error(`字段 ${field} 过长`)
    if (field === 'model' && value.length > 256) throw new Error('字段 model 过长')
    if (field === 'baseURL') normalizeGenerationsUrl(value)
    if (field === 'editURL') httpUrl(value, '图生图端点')
  }
}

/**
 * GET  /image2-draw/state    → 当前值 + revision + writable
 * POST /image2-draw/mutate   → body { ops, expectedRevision }
 */
export async function handleImage2Http(ctx, current, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh-image2-draw.local')
  try {
    if (req.method === 'GET' && url.pathname === '/image2-draw/attachment') {
      let ref
      try {
        ref = attachmentRefFromUrl(url)
      } catch (error) {
        respondJson(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        respondJson(res, 503, { ok: false, error: { code: 'unavailable', message: '附件服务不可用' } })
        return
      }
      let stored
      try {
        stored = await attachments.readImage(ref)
      } catch (error) {
        respondJson(res, 404, {
          ok: false,
          error: { code: 'attachment-not-found', message: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const data = Buffer.from(stored.data)
      res.writeHead(200, {
        'content-type': ref.mediaType,
        'content-length': String(data.length),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      res.end(data)
      return
    }
    if (req.method === 'POST' && url.pathname === '/image2-draw/studio/upload') {
      const sessionId = String(url.searchParams.get('session') ?? 'shared').trim()
      const originalName = String(url.searchParams.get('name') ?? '').trim()
      const chunks = []
      let size = 0
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_INPUT_BYTES + 1024) {
            respondJson(res, 413, { ok: false, error: { code: 'media_too_large', message: `单张图片超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限` } })
            return
          }
          chunks.push(chunk)
        }
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'upload-aborted', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      try {
        const stored = studioStoreUpload(sessionId, Buffer.concat(chunks, size), originalName)
        respondJson(res, 200, { ok: true, value: stored })
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'invalid-media', message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/image2-draw/studio/file') {
      const sessionId = String(url.searchParams.get('session') ?? 'shared').trim()
      const token = String(url.searchParams.get('name') ?? '').trim()
      if (token === '') {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 name' } })
        return
      }
      await studioServeFile(sessionId, token, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/image2-draw/studio/submit') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      const sessionId = String(body?.sessionId ?? 'shared').trim()
      let params
      try {
        params = studioValidatedBody(body, sessionId)
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      const input = { prompt: params.prompt, size: params.size, quality: params.quality }
      if (params.mode === 'edit') {
        if (!Array.isArray(body?.images) || body.images.length === 0) {
          respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: '图生图至少需要一张参考图' } })
          return
        }
        if (body.images.length > MAX_INPUT_IMAGES) {
          respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: `参考图最多 ${MAX_INPUT_IMAGES} 张` } })
          return
        }
        input.images = body.images.map(id => String(id))
      } else {
        input.count = Math.min(Math.max(Number(body?.count) || 1, 1), 8)
      }
      const task = studioTaskCreate(params.mode, input)
      task.sessionId = sessionId
      void runStudioTask(ctx, task, current).catch(() => {})
      respondJson(res, 200, { ok: true, value: { taskId: task.id, status: 'queued' } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/image2-draw/studio/status') {
      const task = studioTaskGet(String(url.searchParams.get('task') ?? '').trim())
      if (task === undefined) {
        respondJson(res, 200, { ok: true, value: { status: 'expired', error: '任务不存在或已过期（GUI 可能已重启），请重新提交' } })
        return
      }
      respondJson(res, 200, { ok: true, value: task })
      return
    }
    if (req.method === 'GET' && url.pathname === '/image2-draw/state') {
      respondJson(res, 200, { ok: true, value: currentDescriptor(ctx, current) })
      return
    }
    if (req.method === 'POST' && url.pathname === '/image2-draw/mutate') {
      let body
      try {
        body = await readJsonBody(req)
        validateMutationBody(body)
      } catch (error) {
        respondJson(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const settings = ctx.get('settings')
      if (settings === undefined) {
        respondJson(res, 500, { ok: false, error: { code: 'internal', message: 'settings 服务不可用' } })
        return
      }
      try {
        await settings.mutate(NS, body.ops, body.expectedRevision)
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'SETTINGS_CONFLICT') {
          respondJson(res, 200, {
            ok: false,
            error: {
              code: 'settings-conflict',
              message: error.message ?? '配置已被其他页面修改',
              details: { expected: error.expected, actual: error.actual },
            },
          })
          return
        }
        throw error
      }
      respondJson(res, 200, { ok: true, value: currentDescriptor(ctx, current) })
      return
    }
    respondJson(res, 404, { ok: false, error: { code: 'not-found', message: url.pathname } })
  } catch (error) {
    respondJson(res, 500, {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  }
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

/**
 * @param deps 测试注入点：{ Schema, defineTool, installSettingsSection }。
 */
export async function apply(ctx, config = {}, deps = {}) {
  const Schema = deps.Schema ?? (await import('@deepseek-ai/schemastery')).default
  const { defineTool } = deps.defineTool !== undefined
    ? { defineTool: deps.defineTool }
    : await import('@deepseek-ai/dsh-tools')
  const { installSettingsSection } = deps.installSettingsSection !== undefined
    ? { installSettingsSection: deps.installSettingsSection }
    : await import('@deepseek-ai/dsh-settings')

  const image2Schema = Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_KEY_ENV),
    baseURL: Schema.string(),
    model: Schema.string().default(DEFAULT_MODEL),
    editURL: Schema.string(),
    timeoutSeconds: Schema.number().default(DEFAULT_TIMEOUT_SECONDS),
  })

  let current = () => config
  installSettingsSection(ctx, NS, image2Schema, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
    validate: validateSettings,
  })

  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      images: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            name: { type: 'string' },
          },
        },
      },
      provider: { type: 'string' },
      model: { type: 'string' },
      size: { type: 'string' },
      quality: { type: 'string' },
      mode: { type: 'string' },
    },
  }

  const renderOutcome = (_args, value) => {
    const images = Array.isArray(value.images) ? value.images : []
    return [{
      type: 'text',
      text: `${value.mode === 'edit' ? '图生图' : '文生图'}完成：${value.provider} / ${value.model} · ${value.size} · ${value.quality}\n`
        + '图片已保存到 outputs/image2。请勿拼接完整路径或调用读取图片、文件工具验证结果。'
        + (images.length > 0 ? `\n${attachmentMarkerOf(images)}` : ''),
    }]
  }

  const commonParameters = {
    prompt: { type: 'string', required: true, description: '生图提示词，支持中文；可包含方向词（竖版/横版/方图等）以决定自适应尺寸' },
    size: { type: 'string', description: 'adaptive（默认，按提示词方向词自动） / auto / portrait / landscape / square，或 WIDTHxHEIGHT（16 的倍数、最长边 ≤3840、宽高比 ≤3:1）。提示：常见网关仅支持 auto、1024x1024、1536x1024、1024x1536、3840x2160 等列表内尺寸，自定义非列表尺寸可能被网关拒绝' },
    quality: { type: 'string', description: 'low / medium / high / auto；默认 low（高质量更慢更贵；同步代理约 120s 附近可能 524，不会自动重试）' },
  }

  ctx.tools.register(defineTool({
    name: 'image2-generate',
    description: '文生图：调用配置好的 image2 API（设置 → 插件 → 插件配置 统一配置 API Key 与接口地址）。结果会显示在聊天卡片并保存到会话工作目录 outputs/image2。文件名由结果卡片展示，最终回复不要重复输出文件名。不要拼接完整路径，也不要调用读取图片或文件工具检查结果；当前模型可能不支持图片输入。524/超时不会自动重试（上游可能仍在生成），如失败请把错误告诉用户确认后再试。',
    parameters: {
      ...commonParameters,
      count: { type: 'number', description: '生成张数 1~8，默认 1；多张按顺序逐个请求（n=1），不并发' },
    },
    output: { schema: outputSchema, render: renderOutcome },
    async execute(args, exec) {
      const settings = current()
      const size = resolveSize(args.size, args.prompt, '1024x1024')
      const quality = args.quality ?? 'low'
      if (!QUALITIES.includes(quality)) throw new Error(`quality 必须是 ${QUALITIES.join('/')}`)
      const count = args.count ?? 1
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('count 必须是 1~8 的整数')
      const params = { prompt: args.prompt, size, quality }
      const files = []
      const images = []
      let outcome
      for (let index = 1; index <= count; index += 1) {
        outcome = await generateOnce(ctx, settings, params, exec)
        files.push(...outcome.files)
        images.push(...outcome.images)
      }
      const value = { ...outcome, files, images, mode: 'generate', size, quality }
      return value
    },
  }))

  ctx.tools.register(defineTool({
    name: 'image2-edit',
    description: '图生图：基于 1~8 张参考图调用配置好的 image2 API 修改/重绘。传多张参考图时按 OpenAI 官方「多源图」语义发送（重复 image 字段）：适合「多张不同角度/视角的人物照 → 保持同一人物生成新图」这类角色一致性需求，请在图生图提示词里写清主体关系（如：以下参考图是同一人物的不同视角，请保持五官身材一致，生成…）。相对路径按会话工作目录解析；单张 ≤4MB、总计 ≤32MB，仅支持 PNG/JPEG/WebP（Node 端不自动缩放）。结果会显示在聊天卡片并保存到 outputs/image2。文件名由结果卡片展示，最终回复不要重复输出文件名。不要拼接完整路径，也不要调用读取图片或文件工具检查结果；当前模型可能不支持图片输入。',
    parameters: {
      ...commonParameters,
      refs: { type: 'array', items: { type: 'string' }, required: true, description: '参考图文件路径（1~8 个；相对路径基于会话工作目录）' },
    },
    output: { schema: outputSchema, render: renderOutcome },
    async execute(args, exec) {
      if (!Array.isArray(args.refs) || args.refs.length === 0) throw new Error('图生图至少需要一张参考图（refs）')
      if (args.refs.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
      const settings = current()
      const size = resolveSize(args.size, args.prompt, '1024x1024')
      const quality = args.quality ?? 'low'
      if (!QUALITIES.includes(quality)) throw new Error(`quality 必须是 ${QUALITIES.join('/')}`)
      const params = { prompt: args.prompt, size, quality, refs: args.refs }
      const outcome = await editOnce(ctx, settings, params, exec)
      const value = { ...outcome, mode: 'edit', size, quality }
      return value
    },
  }))

  // webServer 可能晚于插件挂载；用注入回调随服务生命周期注册/注销路由。
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'prefix',
      path: '/image2-draw',
      handler: (req, res) => handleImage2Http(ctx, current, req, res),
    }))
  })
}

export const __test = Object.freeze({
  combinedSignal,
  attachmentMarkerOf,
  attachmentRefFromUrl,
  buildEditForm,
  decodeBase64Image,
  downloadImage,
  readReferenceImages,
  readResponseBodyLimited,
  saveConversationImage,
  studioDirsOf,
  studioResultPathOf,
  studioSaveResult,
  studioStoreUpload,
  studioTaskCreate,
  studioUploadPathOf,
  studioValidatedBody,
  validateMutationBody,
})

export default { name, inject, apply }
