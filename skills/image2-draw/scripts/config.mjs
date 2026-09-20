/**
 * Claude Code skill 的端点来源解析（纯函数，便于测试）。
 * 优先级：CLI --endpoint > 环境变量 > ~/.claude/image2-draw.json > DSH 扁平单端点配置。
 */

export const MAX_ENDPOINTS = 8

/** DSH 侧默认凭据引用名（与 lib/core.js 的 DEFAULT_KEY_ENV 一致）。 */
const DEFAULT_KEY_ENV = 'IMAGE2_API_KEY'

/** "baseURL,key" → 端点；无逗号则为纯 baseURL。 */
export function parseCliEndpoint(text) {
  const raw = String(text ?? '').trim()
  const comma = raw.indexOf(',')
  if (comma < 0) return { baseURL: raw, apiKey: undefined }
  const baseURL = raw.slice(0, comma).trim()
  const apiKey = raw.slice(comma + 1).trim()
  return { baseURL, apiKey: apiKey === '' ? undefined : apiKey }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item))
  if (value !== null && typeof value === 'object') return [value]
  return []
}

export function parseEndpointsJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
  const list = normalizeList(parsed)
  return list.length === 0 ? undefined : list
}

/** `{"endpoints":[…]}` 信封 → 内层数组；其余原样返回（裸数组 / 裸单端点）。 */
function unwrapEnvelope(parsed) {
  const enveloped = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.endpoints !== undefined
  return enveloped ? parsed.endpoints : parsed
}

export function endpointsFromFile(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = normalizeList(unwrapEnvelope(parsed))
  return list.length === 0 ? undefined : list
}

/** 极简 YAML 子集：只取 image2-draw 段落的扁平 key: value（不解析 flow-style 嵌套）。
 *  若该段落里出现 endpoints:，返回 'HAS_ENDPOINTS' 作为"需去 CC 侧配置"的信号。 */
export function endpointsFromDshSettings(yamlText) {
  const lines = String(yamlText ?? '').split(/\r?\n/)
  let inside = false
  const flat = {}
  let hasEndpoints = false
  for (const line of lines) {
    if (/^image2-draw:\s*$/.test(line)) { inside = true; continue }
    if (!inside) continue
    if (/^\S/.test(line)) { inside = false; continue }          // 下一段落开始
    if (/^\s+endpoints:/.test(line)) { hasEndpoints = true; continue }
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line)
    if (match !== null) flat[match[1]] = match[2]
  }
  if (hasEndpoints) return 'HAS_ENDPOINTS'
  const baseURL = typeof flat.baseURL === 'string' ? flat.baseURL.trim() : ''
  if (baseURL === '') return undefined
  const endpoint = { baseURL }
  if (flat.model !== undefined && flat.model !== '') endpoint.model = flat.model
  if (flat.editURL !== undefined && flat.editURL !== '') endpoint.editURL = flat.editURL
  if (flat.apiKeyEnv !== undefined && flat.apiKeyEnv !== '') endpoint.apiKeyEnv = flat.apiKeyEnv
  return [endpoint]
}

/** 从 ~/.dsh/.credentials.yaml 的 refs 段取某个凭据值。 */
export function credentialFromDshCredentials(yamlText, ref) {
  const lines = String(yamlText ?? '').split(/\r?\n/)
  let inside = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inside = true; continue }
    if (!inside) continue
    if (/^\S/.test(line)) break
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line)
    if (match !== null && match[1] === ref) return match[2]
  }
  return undefined
}

const EMPTY_NOTICE = '未找到任何端点配置。请任选一种方式：① 设置环境变量 IMAGE2_BASE_URL 与 IMAGE2_API_KEY；'
  + '② 写 ~/.claude/image2-draw.json（{"endpoints":[{"baseURL":"…","apiKey":"…"}]}）；'
  + '③ 在 DSH 里配置 image2-draw 插件（可被自动回落读取）。'

export function resolveEndpointsFromSources(input) {
  const { cli = [], env = {}, home = '', readFile = () => undefined } = input ?? {}

  // 跨平台拼路径：统一正斜杠，Windows 下 fs 也接受（测试里注入的 readFile 按同样规则取键）
  const at = relative => `${String(home).replace(/\\/g, '/').replace(/\/+$/, '')}/${relative}`

  if (cli.length > 0) {
    const endpoints = cli.slice(0, MAX_ENDPOINTS).map(parseCliEndpoint).filter(item => item.baseURL !== '')
    if (endpoints.length > 0) return { endpoints, source: 'cli', notice: '' }
  }

  const fromEnvJson = parseEndpointsJson(env.IMAGE2_ENDPOINTS)
  if (fromEnvJson !== undefined) {
    return { endpoints: fromEnvJson.slice(0, MAX_ENDPOINTS), source: 'env', notice: '' }
  }

  const envBase = String(env.IMAGE2_BASE_URL ?? '').trim()
  if (envBase !== '') {
    const endpoint = { baseURL: envBase }
    const key = String(env.IMAGE2_API_KEY ?? '').trim()
    if (key !== '') endpoint.apiKey = key
    const model = String(env.IMAGE2_MODEL ?? '').trim()
    if (model !== '') endpoint.model = model
    return { endpoints: [endpoint], source: 'env-single', notice: '' }
  }

  const fileText = readFile(at('.claude/image2-draw.json'))
  const fromFile = endpointsFromFile(fileText)
  if (fromFile !== undefined) {
    return { endpoints: fromFile.slice(0, MAX_ENDPOINTS), source: 'file', notice: '' }
  }

  const settingsText = readFile(at('.dsh/settings.yaml'))
  const fromDsh = endpointsFromDshSettings(settingsText)
  if (fromDsh === 'HAS_ENDPOINTS') {
    return {
      endpoints: [],
      source: 'dsh',
      notice: '检测到 DSH 侧配置了多端点，但 Claude Code 侧读不到该结构。请把端点写进 ~/.claude/image2-draw.json（或设置 IMAGE2_ENDPOINTS 环境变量）。',
    }
  }
  if (fromDsh !== undefined) {
    const credentialsText = readFile(at('.dsh/.credentials.yaml'))
    const endpoints = fromDsh.map(endpoint => {
      // 扁平单端点未写 apiKeyEnv 时，DSH 侧同样回落到默认引用名（见 lib/index.js）。
      const value = credentialFromDshCredentials(credentialsText, endpoint.apiKeyEnv ?? DEFAULT_KEY_ENV)
      return value === undefined ? endpoint : { ...endpoint, apiKey: value }
    })
    return { endpoints, source: 'dsh', notice: '' }
  }

  return { endpoints: [], source: 'none', notice: EMPTY_NOTICE }
}
