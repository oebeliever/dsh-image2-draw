#!/usr/bin/env node
/**
 * image2-draw — Claude Code skill 入口。
 * 文生图 / 图生图，复用仓库自己的 lib/core.js（与 DSH 插件同一份实现）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveEndpointsFromSources } from './config.mjs'

const core = await import(new URL('../../../lib/core.js', import.meta.url).href)

const USAGE = `用法:
  node gen.mjs --prompt "…" [--ref a.jpg b.jpg] [--size adaptive|1024x1536|…]
       [--quality low|medium|high|auto] [--count N] [--out 目录] [--timeout 秒数] [--endpoint baseURL,key]...

说明:
  无 --ref → 文生图(/images/generations)；有 --ref → 图生图(/images/edits,多张参考图按多源图语义发送)
  端点来源优先级:--endpoint > 环境变量 > ~/.claude/image2-draw.json > DSH 配置回落
  超时优先级:--timeout > 配置文件顶层 timeoutSeconds > 内置默认 180s
  输出默认写到 <当前目录>/outputs/image2/`

function parseArgs(argv) {
  const args = { prompt: '', refs: [], cliEndpoints: [], size: 'adaptive', quality: 'low', count: 1, out: '', timeout: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${token} 缺少取值`)
      return argv[index]
    }
    if (token === '--help' || token === '-h') args.help = true
    else if (token === '--prompt') args.prompt = next()
    else if (token === '--ref') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) args.refs.push(next())
    } else if (token === '--endpoint') args.cliEndpoints.push(next())
    else if (token === '--size') args.size = next()
    else if (token === '--quality') args.quality = next()
    else if (token === '--count') args.count = Number(next())
    else if (token === '--out') args.out = next()
    else if (token === '--timeout') args.timeout = Number(next())
    else throw new Error(`未知参数:${token}`)
  }
  return args
}

function readFileText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (String(args.prompt).trim() === '') throw new Error(`必须提供 --prompt\n\n${USAGE}`)
  if (!core.QUALITIES.includes(args.quality)) throw new Error(`--quality 必须是 ${core.QUALITIES.join('/')}`)
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 8) throw new Error('--count 必须是 1~8 的整数')

  const home = homedir()
  const resolved = resolveEndpointsFromSources({
    cli: args.cliEndpoints,
    env: process.env,
    home,
    readFile: readFileText,
  })
  if (resolved.notice !== '') console.error(`[image2-draw] ${resolved.notice}`)
  if (resolved.endpoints.length === 0) throw new Error('没有可用端点')

  // T10 审查者建议的验收项：解析器对任何来源都不校验 baseURL，所以必须在这里挡。
  // 最常见的触发方式：把配置文件里的 {"endpoints":[…]} 信封格式写进了 IMAGE2_ENDPOINTS 环境变量
  // （该变量只接受裸数组），此时会得到一个没有 baseURL 的端点对象。
  const blank = resolved.endpoints.filter(endpoint => String(endpoint?.baseURL ?? '').trim() === '')
  if (blank.length > 0) {
    // 提示必须与来源匹配：只有 env 来源才该被指向 IMAGE2_ENDPOINTS（否则会误导用户去改一个他根本没碰过的地方）
    const hint = resolved.source === 'env'
      ? '常见原因：把 {"endpoints":[…]} 信封格式写进了 IMAGE2_ENDPOINTS —— 该环境变量只接受裸数组，信封格式请写进 ~/.claude/image2-draw.json。'
      : '请检查该来源的配置：每个端点都必须有非空地址。'
    throw new Error(`有 ${blank.length} 个端点缺少 baseURL（来源：${resolved.source}）。${hint}`)
  }

  const size = core.resolveSize(args.size, args.prompt, '1024x1024')

  // 超时优先级:--timeout > 配置文件顶层 timeoutSeconds > core 内置默认(180s)。
  // 注意:DSH 侧配置的 timeoutSeconds **不会**传到这里(解析器只返回端点),
  // 需要比 180s 更长(例如中转 quality=high 较慢)时必须显式给 --timeout 或在 CC 配置文件里写 timeoutSeconds。
  const fileTimeout = (() => {
    const text = readFileText(join(home, '.claude', 'image2-draw.json'))
    if (text === undefined) return undefined
    try {
      const value = Number(JSON.parse(text)?.timeoutSeconds)
      return Number.isInteger(value) ? value : undefined
    } catch {
      return undefined
    }
  })()
  const timeoutMs = core.timeoutMsOf({ timeoutSeconds: args.timeout ?? fileTimeout })
  const rotate = String(process.env.IMAGE2_NO_ROTATE ?? '') !== '1'
  const statePath = join(home, '.claude', 'image2-draw.state.json')
  const start = rotate ? core.readStartIndex(statePath) : 0
  const outDir = args.out !== '' ? args.out : join(process.cwd(), core.DEFAULT_OUTPUT_DIR)
  const exec = { agent: { session: { header: { cwd: process.cwd() } } } }
  const parts = args.refs.length > 0
    ? core.refsToParts(args.refs, exec, core.dshHomeOf())
    : []

  for (let index = 1; index <= args.count; index += 1) {
    const outcome = await core.callWithFailover(resolved.endpoints, start, async endpoint => {
      const model = endpoint.model ?? core.DEFAULT_MODEL
      // apiKey 优先；否则把 apiKeyEnv 当作**环境变量名**解析（Claude Code 侧没有凭据库，只有环境变量）。
      // ⚠️ 与 DSH 侧语义不同：DSH 的 apiKeyEnv 是 ~/.dsh/.credentials.yaml 的引用名，由 ctx.credentials 解析。
      const envKey = endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined
      const apiKey = String(endpoint.apiKey ?? envKey ?? '').trim()
      if (apiKey === '') {
        throw new Error(
          `端点 ${endpoint.baseURL} 没有可用密钥（apiKey 为空，且 apiKeyEnv=${endpoint.apiKeyEnv ?? '(未设置)'} 未指向非空环境变量）`,
        )
      }
      if (parts.length > 0) {
        const form = core.buildEditForm({ model }, { prompt: args.prompt, size, quality: args.quality }, parts)
        const result = await core.postForm(core.editUrlOf(endpoint), apiKey, form, timeoutMs)
        return core.decodeImages(result)
      }
      const payload = core.buildGeneratePayload({ model }, { prompt: args.prompt, size, quality: args.quality })
      const result = await core.postJson(core.normalizeGenerationsUrl(endpoint.baseURL), apiKey, payload, timeoutMs)
      return core.decodeImages(result)
    }, { rotate })

    if (outcome.value.length !== 1) throw new Error(`期望返回 1 张图，实际收到 ${outcome.value.length} 张`)
    mkdirSync(outDir, { recursive: true })
    const file = core.saveBlob(outcome.value[0], outDir, { count: args.count, index })
    const label = String(outcome.endpoint.name ?? '').trim() !== '' ? outcome.endpoint.name : outcome.endpoint.baseURL
    console.log(`ENDPOINT:${label}`)
    console.log(`FAILOVER:${outcome.attempts.length}`)
    console.log(`SAVED:${file}`)
    if (rotate && outcome.usedIndex !== start) {
      core.writeStartIndex(statePath, core.nextStartIndex(start, outcome.usedIndex, resolved.endpoints.length))
    }
  }
  return 0
}

// 必须用 process.exitCode 而不是 process.exit():process.exit() 与 undici/libuv 拆卸存在竞态,
// 在 Windows + Node v24 上"完成 ≥2 次 HTTP 往返"后会以 127 退出(故障转移路径必然触发),
// 让调用方把一次成功生成误读成崩溃。
try {
  const code = await main()
  process.exitCode = code
} catch (error) {
  console.error(`[image2-draw] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
