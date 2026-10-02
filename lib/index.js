/**
 * dsh-whale-theme v4.0.0 —— 宿主侧：素材 HTTP 文件服务。
 *
 * ## 为什么用 HTTP 而不是 RPC 或内嵌
 *
 * 素材是**原画质**（开场动画 720p 3.6MB、看板娘 1080×1916 5.6MB、壁纸
 * 1536×1024），三种分发方式实测结论：
 *
 * - **内嵌 bundle**：3.2MB base64 会让 DSH 的 bundle 组合器卡死在
 *   "Loading plugins…"，原画质素材（15.9MB）远超阈值 → 不可行；
 * - **RPC base64**：响应 ≥1MB 会被网关丢弃/限流，客户端表现为无响应
 *   或整页卡死（今天反复出现的故障）→ 不可行；
 * - **本地 HTTP 流**：`<video>` / `<img>` 直接指向 `http://127.0.0.1:port`
 *   由浏览器原生流式加载，零 base64、零内存拼接、不经 RPC 网关 →
 *   **唯一可行路径**（实测 whale-http-ok=true，媒体加载成功）。
 *
 * 端口用 `listen(0)` 由系统分配，经 `whale/ping` 告知客户端，避免端口冲突。
 */

import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

export const name = 'whale-theme'

export const inject = []

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 素材路由：URL 路径 → assets 相对路径。 */
const ROUTES = {
  '/whale/intro.mp4': 'assets/intro.mp4',
  '/whale/mascot.webp': 'assets/mascot.webp',
  '/whale/wallpaper.jpg': 'assets/wallpaper.jpg',
}

const MIME = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' }

/** HTTP 服务端口（listen 后填入；0 = 未启动）。 */
let httpPort = 0

/**
 * 统计**今天**的 token 用量。
 *
 * 数据源：**~/.dsh/storages/session_projcache/sessions/*.json**（DSH 的会话
 * 投影缓存，每个文件对应一个会话）。路径为
 * `record.rows.tokenUsage.val.totals`，内含
 * `uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`。
 *
 * 注意：不要去读 ~/.dsh/sessions 下的 jsonl.zstd —— 那是原始事件日志，
 * 里面**没有** usage 字段（实测只有 1 行、无 token 记录）。
 */
function collectProjectionFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectProjectionFiles(full, out)
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

function todayTokenUsage() {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0 }
  // 按模型分项：投影里只有会话粒度的累计量 + lastUsed 模型（无逐条模型明细），
  // 故将会话总量归属到其 lastUsed 模型；老会话无模型字段则归入“未知模型”。
  const byModel = new Map()
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const sinceMs = since.getTime()
  const root = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
  for (const file of collectProjectionFiles(root)) {
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))?.record
    } catch {
      continue
    }
    const rows = record?.rows
    if (rows === null || typeof rows !== 'object') continue
    const totals = rows.tokenUsage?.val?.totals
    if (totals === null || typeof totals !== 'object') continue
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const input = num(totals.uncachedInputTokens) + num(totals.cacheWriteTokens)
    const output = num(totals.outputTokens)
    const cacheRead = num(totals.cacheReadTokens)
    if (input + output + cacheRead === 0) continue
    // “今天”口径：优先用 lastPromptAt（会话最后一次提问时间），mtime 不可靠
    //（DSH 启动/迁移会 touch 全部投影文件，实测 199 个文件的 mtime 全是今天，
    // 若只按 mtime 会把旧会话的累计量全算进来，报出 1.4 亿这种离谱数字）。
    const lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt
    if (typeof lastPromptAt === 'number') {
      if (lastPromptAt < sinceMs) continue
    } else {
      // 无 lastPromptAt 的老格式才回退到 mtime
      let mtime
      try {
        mtime = statSync(file).mtime
      } catch {
        continue
      }
      if (mtime < since) continue
    }
    total.input += input
    total.output += output
    total.cacheRead += cacheRead
    total.cacheWrite += num(totals.cacheWriteTokens)
    const cost = rows.sessionStats?.val?.cost
    total.cost += num(cost)
    total.sessions++
    const lastUsed = rows.modelSelection?.val?.lastUsed
    let modelKey = '未知模型'
    if (lastUsed !== null && typeof lastUsed === 'object') {
      const name = lastUsed.model ?? lastUsed.modelId ?? lastUsed.name
      if (typeof name === 'string' && name !== '') modelKey = name
      else if (typeof lastUsed.provider === 'string' && lastUsed.provider !== '') modelKey = lastUsed.provider
    } else if (typeof lastUsed === 'string' && lastUsed !== '') {
      modelKey = lastUsed
    }
    let entry = byModel.get(modelKey)
    if (entry === undefined) {
      entry = { model: modelKey, input: 0, output: 0, cacheRead: 0, total: 0, sessions: 0 }
      byModel.set(modelKey, entry)
    }
    entry.input += input
    entry.output += output
    entry.cacheRead += cacheRead
    entry.total += input + output + cacheRead
    entry.sessions++
  }
  total.total = total.input + total.output + total.cacheRead
  total.models = [...byModel.values()].sort((a, b) => b.total - a.total)
  return total
}

function reply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

export function apply(ctx) {
  try {
    writeFileSync(resolve(packageRoot, 'assets', '.host-alive'), String(Date.now()))
  } catch { /* 探针失败不影响功能 */ }

  // 素材 HTTP 服务：支持 Range 请求（video 拖动/续播需要）。
  const server = http.createServer((req, res) => {
    const path = req.url?.split('?')[0]
    const rel = ROUTES[path]
    if (rel === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const file = resolve(packageRoot, rel)
    void (async () => {
      let info
      try {
        info = await stat(file)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('missing')
        return
      }
      const type = MIME[extname(file)] ?? 'application/octet-stream'
      const range = req.headers.range
      // Range 支持：video 元素依赖它做分段加载。
      if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) {
        const [startRaw, endRaw] = range.replace('bytes=', '').split('-')
        const start = startRaw === '' ? info.size - Number(endRaw) : Number(startRaw)
        const end = startRaw === '' || endRaw === '' ? info.size - 1 : Number(endRaw)
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= info.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        createReadStream(file, { start, end }).pipe(res)
        return
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      createReadStream(file).pipe(res)
    })()
  })

  server.on('error', (error) => {
    ctx.logger?.error?.(`[whale-theme] 素材 HTTP 服务启动失败：${error.message}`)
  })
  server.listen(0, '127.0.0.1', () => {
    httpPort = server.address().port
    ctx.logger?.info?.(`[whale-theme] v4.0.0 素材 HTTP 服务：127.0.0.1:${httpPort}`)
  })

  // 仅保留一个轻量端点：把端口告诉客户端。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection ?? connectionCtx.get?.('connection')
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return
    connection.fetch.register({
      path: '/api/whale-theme',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
        let message
        try {
          message = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = message?.payload
        if (
          message?.type !== 'client-request'
          || typeof message.rpcId !== 'string'
          || message.method !== 'whale-theme'
          || call === null || typeof call !== 'object'
        ) {
          return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid request.' } })
        }
        if (call?.method === 'whale/usage') {
          // 今日 token 用量（宿主直读会话投影缓存，避免走 RPC 大响应）。
          // 之前因缺失 import（join/homedir/readdirSync 等）直接抛 ReferenceError，
          // 导致客户端永远查不到数据；这里加 try/catch 保底。
          try {
            return reply(rpcId, { ok: true, value: todayTokenUsage() })
          } catch (error) {
            ctx.logger?.error?.(`[whale-theme] whale/usage 失败：${error?.message ?? error}`)
            return reply(rpcId, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
          }
        }

        if (call?.method === 'whale/diag') {
          // 客户端自诊断：写入 assets/.diag.json（覆盖式，便于反复重启观察）。
          try {
            writeFileSync(
              resolve(packageRoot, 'assets', '.diag.json'),
              JSON.stringify({ at: new Date().toISOString(), ...call.payload }, null, 2),
              'utf8',
            )
          } catch { /* 探针失败不影响功能 */ }
          return reply(rpcId, { ok: true, value: { logged: true } })
        }
        return reply(rpcId, { ok: true, value: { httpPort } })
      },
    })
  })
}
