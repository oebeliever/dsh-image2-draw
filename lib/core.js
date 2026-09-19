/**
 * image2-draw 共享核心：尺寸解析、multipart 组装、参考图读取、HTTP 层与端点故障转移。
 *
 * 本文件是 DSH 插件（lib/index.js）与 Claude Code skill（skills/image2-draw/scripts/gen.mjs）
 * 的共同实现 —— 只允许依赖 node 内置模块，不得引入 @deepseek-ai/* 或任何第三方包
 * （由 tests/plugin.test.mjs 守卫）。
 */

import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const DEFAULT_KEY_ENV = 'IMAGE2_API_KEY'
export const DEFAULT_MODEL = 'gpt-image-2'
export const DEFAULT_TIMEOUT_SECONDS = 180
export const DEFAULT_OUTPUT_DIR = 'outputs/image2'

export const MIN_TOTAL_PIXELS = 655_360
export const MAX_TOTAL_PIXELS = 8_294_400
export const MAX_EDGE = 3840
export const SIZE_MULTIPLE = 16
export const MAX_ASPECT_RATIO = 3.0
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
export const MAX_INPUT_BYTES = 4 * 1024 * 1024
export const MAX_INPUT_IMAGES = 8
export const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
export const MAX_JSON_RESPONSE_BYTES = 48 * 1024 * 1024
export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
export const MAX_ENDPOINTS = 8
export const DOWNLOAD_TIMEOUT_SECONDS = 120
export const MIN_TIMEOUT_SECONDS = 1
export const MAX_TIMEOUT_SECONDS = 3600
export const QUALITIES = ['low', 'medium', 'high', 'auto']

export const PORTRAIT_WORDS = ['竖版', '竖屏', '纵向', '手机壁纸', '人像', 'portrait', 'vertical', '9:16', '2:3']
export const LANDSCAPE_WORDS = ['横版', '横屏', '横幅', '桌面壁纸', '封面', 'landscape', 'horizontal', '16:9', '3:2']
export const SQUARE_WORDS = ['方图', '正方形', '头像', '图标', 'square', '1:1', 'avatar', 'icon']

// 预置尺寸映射：对齐 OpenAI Images（gpt-image 系）公开规格 ——
// 常见网关（如 OpenAI 兼容中转）只接受 auto 或 1024x1024 / 1536x1024 / 1024x1536 /
// 3840x2160 等列表内尺寸；旧的 768x1024 / 1024x768 会被部分网关 400 拒绝。
export const PRESET_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '3840x2160', '2160x3840']

export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/* ------------------------------------------------------------------ *
 * 常量与纯函数（可测试）
 * ------------------------------------------------------------------ */

export function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function isCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

export function httpUrl(value, label) {
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

/** settings → 端点数组：配了 endpoints 用它，否则把旧的单端点字段合成一个。
 *  这是唯一向后兼容单点：老配置零改动、行为零变化。 */
export function resolveEndpoints(settings) {
  const source = objectOf(settings)
  const list = Array.isArray(source.endpoints) ? source.endpoints : []
  const usable = list.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item))
  const rows = usable.length > 0 ? usable : [source]
  return rows.map(item => {
    const pick = key => {
      const raw = item[key]
      const text = typeof raw === 'string' ? raw.trim() : ''
      return text === '' ? undefined : text
    }
    return {
      name: typeof item.name === 'string' ? item.name.trim() : '',
      baseURL: typeof item.baseURL === 'string' ? item.baseURL.trim() : '',
      model: pick('model'),
      editURL: pick('editURL'),
      apiKey: pick('apiKey'),
      apiKeyEnv: pick('apiKeyEnv'),
    }
  })
}

/** 校验 settings.endpoints（仅在该字段存在时校验；单端点旧字段沿用 validateSettings）。 */
export function validateEndpoints(value) {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('endpoints 必须是数组')
  if (value.length > MAX_ENDPOINTS) throw new Error(`endpoints 最多 ${MAX_ENDPOINTS} 个`)
  value.forEach((item, index) => {
    const label = `endpoints[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} 必须是对象`)
    const baseURL = String(item.baseURL ?? '').trim()
    if (baseURL === '') throw new Error(`${label}.baseURL 不能为空`)
    normalizeGenerationsUrl(baseURL)
    if (item.editURL !== undefined && String(item.editURL).trim() !== '') {
      httpUrl(item.editURL, `${label}.editURL`)
    }
    if (item.apiKeyEnv !== undefined) {
      const ref = String(item.apiKeyEnv).trim()
      if (ref !== '' && !isCredentialRef(ref)) throw new Error(`${label}.apiKeyEnv 必须是环境变量式名称`)
    }
    if (item.name !== undefined) {
      const name = String(item.name)
      if (name.length > 40) throw new Error(`${label}.name 最长 40 字符`)
      if (/[\r\n]/.test(name)) throw new Error(`${label}.name 不能含换行`)
    }
  })
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

export function timestampNow(date) {
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

export function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/* ------------------------------------------------------------------ *
 * 运行期（需要 ctx）
 * ------------------------------------------------------------------ */

export function combinedSignal(signal, timeoutMs) {
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

export async function httpFetch(url, init, timeoutMs, execSignal, consume) {
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

export async function readResponseBodyLimited(response, maxBytes, label) {
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

export function errorFromHttp(status, body) {
  let detail = ''
  try {
    detail = JSON.stringify(JSON.parse(body.toString('utf8')), null, 0).slice(0, 500)
  } catch {
    detail = body.toString('utf8').slice(0, 500)
  }
  return new Error(`HTTP ${status}${detail ? `：${detail}` : ''}`)
}

export async function postJson(url, apiKey, payload, timeoutMs, execSignal) {
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

export async function postForm(url, apiKey, form, timeoutMs, execSignal) {
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

export async function downloadImage(url, execSignal) {
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

export function decodeBase64Image(value, maxBytes = MAX_DOWNLOAD_BYTES) {
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

export async function decodeImages(result, execSignal) {
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

export function readReferenceImages(refs, exec) {
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

/* ------------------------------------------------------------------ *
 * 会话图片附件直读（sha256:... → 本地对象文件）
 * 让 image2-edit 直接使用「对话中上传的图片附件 id」作为参考图：
 * 无需本地文件路径，也不需要任何识图/看图预处理。存储布局与
 * dsh-attachment-local 一致：<DSH_HOME>/attachments/v1/objects/<hex 前 2 位>/<hex>。
 * ------------------------------------------------------------------ */

export function attachmentIdHexOf(value) {
  const text = String(value ?? '').trim()
  const match = /^sha256:([a-f0-9]{64})$/i.exec(text)
  return match === null ? null : match[1].toLowerCase()
}

export function dshHomeOf() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

export function attachmentObjectPathOf(attachmentId, dshHome) {
  const hex = attachmentIdHexOf(attachmentId)
  if (hex === null) throw new Error('附件 id 不合法（应为 sha256:<64 位十六进制>）')
  return join(dshHome ?? dshHomeOf(), 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
}

/** 按会话附件 id 读取图片字节并嗅探真实格式（单张 ≤4MB，与上传参考图同一上限）。 */
export function readAttachmentImage(attachmentId, dshHome) {
  const path = attachmentObjectPathOf(attachmentId, dshHome)
  let bytes
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('不是普通文件')
    if (stat.size > MAX_INPUT_BYTES) throw new Error(`附件超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限`)
    bytes = readFileSync(path)
  } catch (error) {
    if (error instanceof Error && /附件 id 不合法/.test(error.message)) throw error
    throw new Error(`附件不可读（${attachmentId}）：${error instanceof Error ? error.message : String(error)}。附件 id 需来自当前 DSH 会话内上传的图片`)
  }
  let type
  try {
    type = detectedImageType(bytes)
  } catch {
    throw new Error(`附件格式不支持（${attachmentId}）：仅 PNG/JPEG/WebP 可直接图生图（GIF 请先转换）`)
  }
  return { bytes, name: `${attachmentId.slice(7, 19)}${type.extension}`, mime: type.mime }
}

/** 把 refs（本地路径与 sha256 附件 id 可混用）统一解析为上传 parts。 */
export function refsToParts(refs, exec, dshHome) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error('图生图至少需要一张参考图（本地路径或 sha256 附件 id）')
  if (refs.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  const fileRefs = []
  const attachRefs = []
  for (const ref of refs) {
    const text = String(ref ?? '').trim()
    if (text === '') throw new Error('参考图不能为空')
    if (attachmentIdHexOf(text) !== null) attachRefs.push(text)
    else fileRefs.push(text)
  }
  const parts = []
  let totalBytes = 0
  const pushPart = (part) => {
    if (part.bytes.length > MAX_INPUT_BYTES) {
      throw new Error(`参考图超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限`)
    }
    totalBytes += part.bytes.length
    if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
      throw new Error(`参考图总大小超过 ${MAX_TOTAL_INPUT_BYTES / 1024 / 1024}MB 上限`)
    }
    parts.push(part)
  }
  if (fileRefs.length > 0) {
    for (const part of readReferenceImages(fileRefs, exec)) pushPart(part)
  }
  for (const id of attachRefs) pushPart(readAttachmentImage(id, dshHome))
  return parts
}

/**
 * 组装 /images/edits 的 multipart 表单。
 * 兼容说明：OpenAI Images 图生图以「重复 image 字段」表达多张源图
 * （gpt-image 系支持一张或多张参考图；部分中转网关不接受非标准 image[] 字段）。
 */export function buildEditForm(settings, params, parts) {
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
