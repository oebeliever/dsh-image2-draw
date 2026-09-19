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

// 从 core.js 导入本文件仍在使用（及其超集）的符号：机械推导，多导入在 ESM 中惰性且无副作用，
// 漏导入会导致运行期 ReferenceError。末位 sessionCwdOf 是 readReferenceImages 的依赖。
import {
  DEFAULT_TIMEOUT_SECONDS, MIN_TOTAL_PIXELS, MAX_TOTAL_PIXELS, MAX_EDGE, SIZE_MULTIPLE,
  MAX_ASPECT_RATIO, MAX_INPUT_BYTES, MAX_INPUT_IMAGES, MAX_TOTAL_INPUT_BYTES, MAX_DOWNLOAD_BYTES,
  MAX_JSON_RESPONSE_BYTES, MAX_ERROR_RESPONSE_BYTES, DOWNLOAD_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS, QUALITIES, PRESET_SIZES, DEFAULT_MODEL, DEFAULT_KEY_ENV, DEFAULT_OUTPUT_DIR,
  PORTRAIT_WORDS, LANDSCAPE_WORDS, SQUARE_WORDS, CREDENTIAL_REF_PATTERN, objectOf, isCredentialRef,
  httpUrl, normalizeGenerationsUrl, editUrlOf, timeoutMsOf, validateSettings, adaptiveSize,
  resolveSize, buildGeneratePayload, detectedImageType, detectedExtension, timestampNow,
  availablePath, saveBlob, attachmentIdHexOf, dshHomeOf, attachmentObjectPathOf,
  readAttachmentImage, readReferenceImages, refsToParts, buildEditForm, combinedSignal, httpFetch,
  readResponseBodyLimited, errorFromHttp, postJson, postForm, downloadImage, decodeBase64Image,
  decodeImages, sessionCwdOf,
} from './core.js'

// 对外导出面保持与 v0.2.x 完全一致（测试与外部消费者按名导入）。
export * from './core.js'

export const name = 'image2-draw'
export const inject = ['tools', 'credentials']

const NS = 'image2-draw'

const MUTABLE_SETTINGS_FIELDS = new Set(['baseURL', 'model', 'editURL', 'timeoutSeconds'])
const SAFE_SETTINGS_FIELDS = ['apiKeyEnv', 'baseURL', 'model', 'editURL', 'timeoutSeconds']

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

function outputBaseOf(exec) {
  return join(sessionCwdOf(exec), DEFAULT_OUTPUT_DIR)
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

/* ------------------------------------------------------------------ *
 * 提示词库 / 功能库（presets）
 * 内置模板（人物设计图两套版式 prompt、逐套批量流程、着装清单）+ 用户
 * 自定义模板，持久化到 <DSH_HOME>/storages/image2-draw/presets.json，
 * 供工作台载入与对话工具（image2-preset）复用。
 * ------------------------------------------------------------------ */

export const PRESET_KINDS = ['prompt', 'flow', 'outfit-list']

const PRESET_TEXT_LIMIT = 60000
const PRESET_NAME_MAX = 80

/** 人物设计图 · 版式 A：脸部特写 + 赤膊体型 + 着装动作（单变量 {outfit}）。 */
const BUILTIN_PROMPT_SHEET_A = `Character reference sheet of the SAME man as in the attached reference photos — his face must be an EXACT likeness: reproduce facial features, short black hair and lean athletic build precisely from the reference photos; the identical face appears in every view. LAYOUT of this wide sheet:
1) TOP-LEFT: LARGE close-up headshot portrait of his face (sharp frontal, filling the corner).
2) CENTER-LEFT: two large waist-up physique crops of him SHIRTLESS — a FRONT torso view and a BACK torso view — framed from top of head down to just below the waist (frame cuts off below the waist, lower garment not visible), showing defined chest, abs, obliques, shoulders, arms, lats and back muscle lines like a bodybuilding physique reference.
3) RIGHT side: one small full-body ACTION pose of him in his complete outfit (jogging-start stance): {outfit}.
Uniform clean light-grey studio background, subtle floor shadow, professional character-design sheet style, consistent proportions and the same face everywhere. No watermark, no extra people.`

/** 人物设计图 · 版式 B：整套穿着在身上的局部特写（单变量 {outfit}）。 */
const BUILTIN_PROMPT_SHEET_B = `Wear-position close-up reference sheet of the SAME man as in the attached reference photos (identical face and build). The full wardrobe worn is: {outfit}. The sheet shows his outfit items each WORN on the body as neat close-up crops arranged in a grid, with a short English label under each item:
CAP — the headwear worn backwards on his head, back-of-head crop;
TANK TOP / TOP — upper-body crop of the top garment;
SHORTS / PANTS — waist/hip crop;
SOCKS — lower-leg crop with the sock worn on the ankle, shoes removed;
SHOES — foot crop wearing the footwear;
CHAIN / ACCESSORIES — neck crop with the chain or accessory.
Clean light-grey studio background, professional character-design reference style, consistent same face where visible, no tailoring/stitch details, no watermark, no extra people.`

const BUILTIN_PRESETS = [
  {
    id: 'builtin-sheet-a',
    name: '人物设计图·版式A（脸部特写+赤膊体型+动作）',
    kind: 'prompt',
    desc: '同人多视角参考 → 一张设计图：脸部大特写 + 腰部以上赤膊正/背肌肉展示 + 着套装动作姿势。变量 {outfit} 填该套完整穿着（英文描述，如 black sleeveless tank with red shoulder accents, charcoal cap backwards, dark shorts, silver chain）。',
    builtin: true,
    body: {
      prompt: BUILTIN_PROMPT_SHEET_A,
      mode: 'edit',
      size: '1536x1024',
      quality: 'high',
      variables: ['outfit'],
    },
  },
  {
    id: 'builtin-sheet-b',
    name: '人物设计图·版式B（穿着局部特写）',
    kind: 'prompt',
    desc: '同人多视角参考 → 该套每件衣物“穿在身上”的局部特写网格（帽/上衣/裤/袜/鞋/配饰），含穿袜脚踝（脱鞋）。变量 {outfit} 填全套穿着清单（英文）。注意：个别网关内容策略会拦截“仅内裤”构图，需要内裤时可尝试在 {outfit} 描述并以裤腰露出内裤边方式呈现，遇 HTTP 400 content_policy_violation 就删去该行。',
    builtin: true,
    body: {
      prompt: BUILTIN_PROMPT_SHEET_B,
      mode: 'edit',
      size: '1536x1024',
      quality: 'high',
      variables: ['outfit'],
    },
  },
  {
    id: 'builtin-char-design-flow',
    name: '流程·同人多视角→全套人物设计图（逐套确认制）',
    kind: 'flow',
    desc: '保存完整工作流：同一人多视角参考图 → 罗列所有着装并让用户确认 → 逐套用版式A/B 生成，每生成一张都停下等用户确认，再生成下一套。AI 对话中使用：让我读取此流程即可。',
    builtin: true,
    body: {
      instructions: `执行「同人多视角 → 全套人物设计图」流程（逐套确认制）：
1) 素材：用户提供同一个人的 2~8 张不同视角图片（refs 可直接传 sha256: 附件 id 给 image2-edit）。
2) 清点着装：先逐一确认每张参考图的穿着并去重，整理成套装清单（每套含全部穿着：上衣/下装/鞋袜/帽/链等），向用户展示并请其确认。
3) 逐套生成：对每一套先使用 preset builtin-sheet-a（版式A：脸部特写+赤膊体型+动作）生成一张；如需穿着细节再使用 builtin-sheet-b（版式B：穿着局部特写）。每套在 prompt 的 {outfit} 处填入该套英文穿着描述。
4) 确认制：每生成完一张必须停下，把结果展示给用户并等待确认，用户说“继续/下一套”后才生成下一张；绝不一次批量出多张。全部完成后汇总清单。`,
      refNote: '需要识图清点穿着时可用识图工具；模型可直接看图时自行归纳。',
    },
  },
  {
    id: 'builtin-outfits-list',
    name: '清单·参考人物六套着装（含英文 outfit 描述）',
    kind: 'outfit-list',
    desc: '此前 8 张参考图归纳出的 6 套着装清单，{outfit} 变量可直接取用。',
    builtin: true,
    body: {
      items: [
        { no: 1, zh: '灰白边无袖背心 + 珊瑚橙短裤 + 银链', en: 'light-grey sleeveless tank top with white trim, bright coral-orange fitted athletic shorts, thin silver chain necklace' },
        { no: 2, zh: '青绿/藏青拼色无袖运动背心', en: 'teal-green sleeveless athletic tank with dark navy shoulder yoke, plain dark athletic shorts' },
        { no: 3, zh: '黑底红肩无袖运动背心 + 反戴灰棒球帽', en: 'black sleeveless athletic tank with red shoulder accents, charcoal baseball cap worn backwards, dark athletic shorts, thin silver chain necklace' },
        { no: 4, zh: '浅蓝点纹短袖衬衫(敞开) + 黑打底 + 深蓝短裤', en: 'light powder-blue short-sleeve shirt worn open over a black sleeveless undershirt, dark navy casual shorts, silver chain necklace, light-strap wristwatch' },
        { no: 5, zh: '蓝红格纹衬衫 + 黑打底 + 深灰长裤', en: 'blue-darkred-navy plaid button-up shirt over a black crew-neck undershirt, plain dark-grey casual trousers' },
        { no: 6, zh: '浅绿云纹短袖衬衫(敞开) + 黑打底 + 卡其长裤', en: 'light sage-green mottled short-sleeve shirt worn open over a black undershirt, off-white khaki trousers, white sneakers' },
      ],
    },
  },
]

function presetsFilePath() {
  return join(dirname(studioLibRoot()), 'presets.json')
}

function readUserPresets() {
  try {
    const list = JSON.parse(readFileSync(presetsFilePath(), 'utf8'))
    return Array.isArray(list) ? list.filter(item => item !== null && typeof item === 'object') : []
  } catch {
    return []
  }
}

function writeUserPresets(list) {
  mkdirSync(dirname(presetsFilePath()), { recursive: true })
  writeFileSync(presetsFilePath(), JSON.stringify(list, null, 2))
}

/** 全部模板：内置在前（不可改），用户在后。 */
export function listPresets() {
  return [...BUILTIN_PRESETS, ...readUserPresets()]
}

export function presetVisibleText(item) {
  const body = objectOf(item?.body)
  if (item?.kind === 'flow') return String(body.instructions ?? '')
  if (item?.kind === 'outfit-list') {
    return (Array.isArray(body.items) ? body.items : [])
      .map(entry => `#${entry?.no ?? '-'} ${entry?.zh ?? ''}${entry?.en ? ` / ${entry.en}` : ''}`)
      .join('\n')
  }
  return String(body.prompt ?? '')
}

export function validatePresetInput(input) {
  const name = String(input?.name ?? '').trim()
  if (name === '') throw new Error('模板名称不能为空')
  if (name.length > PRESET_NAME_MAX) throw new Error(`模板名称最多 ${PRESET_NAME_MAX} 字符`)
  const kind = String(input?.kind ?? '').trim()
  if (!PRESET_KINDS.includes(kind)) throw new Error(`kind 必须是 ${PRESET_KINDS.join(' / ')}`)
  const body = objectOf(input?.body)
  const text = kind === 'prompt'
    ? String(body.prompt ?? '')
    : kind === 'flow'
      ? String(body.instructions ?? '')
      : JSON.stringify(body.items ?? [])
  if (text.trim() === '') throw new Error('模板内容不能为空')
  if (text.length > PRESET_TEXT_LIMIT) throw new Error(`模板内容最多 ${PRESET_TEXT_LIMIT} 字符`)
  if (BUILTIN_PRESETS.some(item => item.name === name)) throw new Error(`「${name}」是内置模板，不能覆盖`)
  return {
    id: String(input?.id ?? '').trim(),
    name,
    kind,
    desc: String(input?.desc ?? '').trim().slice(0, 300),
    body,
  }
}

export function savePreset(input) {
  const next = validatePresetInput(input)
  const userPresets = readUserPresets()
  const index = userPresets.findIndex(item => item.id === next.id || item.name === next.name)
  if (index >= 0) {
    if (next.id !== '' && next.id !== userPresets[index].id) {
      // 同名不同 id：以新 id 覆盖旧条目内容
    }
    const merged = { ...userPresets[index], ...next }
    if (next.id === '') merged.id = userPresets[index].id
    userPresets[index] = merged
  } else {
    userPresets.push({
      ...next,
      id: next.id !== '' ? next.id : `u-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      builtin: false,
    })
  }
  writeUserPresets(userPresets)
  return userPresets[index] ?? userPresets[userPresets.length - 1]
}

export function removePreset(id) {
  const text = String(id ?? '').trim()
  if (text === '' || !/^[A-Za-z0-9._-]{1,80}$/.test(text)) throw new Error('模板 id 不合法')
  if (BUILTIN_PRESETS.some(item => item.id === text)) throw new Error('内置模板不可删除')
  const userPresets = readUserPresets()
  const next = userPresets.filter(item => item.id !== text)
  if (next.length === userPresets.length) throw new Error(`模板不存在：${text}`)
  writeUserPresets(next)
  return { removed: true }
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
    if (req.method === 'GET' && url.pathname === '/image2-draw/presets') {
      respondJson(res, 200, { ok: true, value: { items: listPresets() } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/image2-draw/presets') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      try {
        const item = savePreset(body)
        respondJson(res, 200, { ok: true, value: { item } })
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (req.method === 'DELETE' && url.pathname === '/image2-draw/presets') {
      try {
        removePreset(url.searchParams.get('id') ?? '')
        respondJson(res, 200, { ok: true, value: { removed: true } })
      } catch (error) {
        respondJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
      }
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
    description: '图生图：基于 1~8 张参考图调用配置好的 image2 API 修改/重绘。传多张参考图时按 OpenAI 官方「多源图」语义发送（重复 image 字段）：适合「多张不同角度/视角的人物照 → 保持同一人物生成新图」这类角色一致性需求，请在图生图提示词里写清主体关系（如：以下参考图是同一人物的不同视角，请保持五官身材一致，生成…）。refs 可传本地路径（相对路径按会话工作目录解析），也可直接传对话中已上传图片的附件 id（sha256: 开头，插件自动从附件库读取，无需识图工具、无需把图片另存本地）；单张 ≤4MB、总计 ≤32MB，仅支持 PNG/JPEG/WebP（Node 端不自动缩放）。结果会显示在聊天卡片并保存到 outputs/image2。文件名由结果卡片展示，最终回复不要重复输出文件名。不要拼接完整路径，也不要调用读取图片或文件工具检查结果；当前模型可能不支持图片输入。',
    parameters: {
      ...commonParameters,
      refs: { type: 'array', items: { type: 'string' }, required: true, description: '参考图（1~8 个）：本地文件路径（相对路径基于会话工作目录），或对话中已上传图片的附件 id（sha256: 开头，直接使用、无需另存本地或先调用任何读图/识图工具）；两者可混用' },
    },
    output: { schema: outputSchema, render: renderOutcome },
    async execute(args, exec) {
      const settings = current()
      const size = resolveSize(args.size, args.prompt, '1024x1024')
      const quality = args.quality ?? 'low'
      if (!QUALITIES.includes(quality)) throw new Error(`quality 必须是 ${QUALITIES.join('/')}`)
      const parts = refsToParts(args.refs, exec)
      const outcome = await editPartsOnce(ctx, settings, { prompt: args.prompt, size, quality }, parts, exec)
      const value = { ...outcome, mode: 'edit', size, quality }
      return value
    },
  }))

  ctx.tools.register(defineTool({
    name: 'image2-preset',
    description: '提示词库/功能库：列出、读取或保存生图模板。内置模板含「人物设计图·版式A（脸部特写+赤膊体型+动作）」「人物设计图·版式B（穿着局部特写）」「流程·同人多视角→全套人物设计图（逐套确认制）」「清单·六套着装（含英文 outfit 描述）」，也可保存用户自己的 prompt/流程/清单便于复用。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save'], description: 'list=列全部模板；get=按 id 读取模板全文；save=保存自定义模板' },
      id: { type: 'string', description: '模板 id（get 时需要）' },
      name: { type: 'string', description: '新模板名称（save 时需要；不能与内置同名）' },
      kind: { type: 'string', enum: ['prompt', 'flow', 'outfit-list'], description: '模板类型（save 时需要）：prompt=生成提示词（body.prompt，可含 {outfit} 占位）；flow=流程指令（body.instructions）；outfit-list=着装清单（body.items:[{no,zh,en}]）' },
      body: { type: 'object', additionalProperties: true, description: '模板内容对象（save 时需要）：prompt 型含 prompt/mode/size/quality/variables；flow 型含 instructions；outfit-list 型含 items' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.message,
      }],
    },
    async execute(args) {
      const action = String(args.action ?? '').trim()
      if (action === 'list') {
        const items = listPresets()
        const lines = items.map(item => `- [${item.id}] ${item.name}（${item.kind}${item.builtin ? '，内置' : ''}）`)
        return { ok: true, message: `提示词库共 ${items.length} 个模板：\n${lines.join('\n')}` }
      }
      if (action === 'get') {
        const id = String(args.id ?? '').trim()
        if (id === '') throw new Error('缺少模板 id（用 list 查看）')
        const item = listPresets().find(candidate => candidate.id === id)
        if (item === undefined) throw new Error(`模板不存在：${id}`)
        const text = presetVisibleText(item)
        return {
          ok: true,
          message: `模板：${item.name}（${item.kind}）\n说明：${item.desc ?? ''}\n\n内容：\n${text}`,
        }
      }
      if (action === 'save') {
        const saved = savePreset({
          name: args.name,
          kind: args.kind,
          desc: typeof args.body?.desc === 'string' ? args.body.desc : '',
          body: args.body,
        })
        return { ok: true, message: `已保存自定义模板：${saved.name}（id=${saved.id}，kind=${saved.kind}）。之后可用 image2-preset get id=${saved.id} 复用。` }
      }
      throw new Error('action 必须是 list / get / save')
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
  attachmentIdHexOf,
  attachmentObjectPathOf,
  attachmentRefFromUrl,
  buildEditForm,
  decodeBase64Image,
  dshHomeOf,
  downloadImage,
  readAttachmentImage,
  readReferenceImages,
  readResponseBodyLimited,
  refsToParts,
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
