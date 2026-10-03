/**
 * 图库投稿中转（Cloudflare Worker，免费版即可）。
 *
 * 插件用户选文件 → POST 到本 Worker → Worker 用站长的 GitHub 令牌在
 * 目标仓库开分支、传图、开 PR → 站长照常在 Pull requests 里合并。
 * 令牌只躺在 Cloudflare 的 Secret 里，不进插件，用户拿不到。
 *
 * 部署：
 * 1. dash.cloudflare.com 注册登录 → Workers → Create → Hello World 模板。
 * 2. 把本文件内容粘贴进 worker.js，Save and deploy。
 * 3. Settings → Variables → Add variable（全部选 Secret）：
 *    - GITHUB_TOKEN ：GitHub 令牌，只需目标仓库的 contents:write + pull_requests:write。
 *      建法：GitHub 头像 → Settings → Developer settings → Personal access
 *      tokens → Fine-grained tokens → Generate → Repository access 只选
 *      你的 blue-fish-archive fork → Permissions 开 Contents(读写) 与
 *      Pull requests(读写)。
 *    - REPO ：hui26705-bot/blue-fish-archive（换成你的 fork 全名）
 *    - UPLOAD_KEY ：随便定一串长的，插件和这里填一样的（防路人刷投稿）。
 * 4. 把 Workers 域名（形如 https://xxx.username.workers.dev）发给插件作者，
 *    接进看板娘「我要投稿」按钮。
 *
 * 限流说明：免费版无 KV，靠 UPLOAD_KEY 挡随手刷；PR 必须站长合并才上墙，
 * 垃圾投稿进不了图库，只是多几个待关的 PR。
 */

const MAX_BYTES = 12 * 1024 * 1024
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

function cors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'content-type, x-upload-key')
  return response
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

function cleanName(raw) {
  const base = String(raw || 'sticker').split(/[\\/]/).pop()
  const noExt = base.replace(/\.[a-z0-9]+$/i, '')
  const safe = noExt.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'sticker'
  return safe
}

function extOf(name, mime) {
  const fromName = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  if (fromName && ALLOWED_EXT.has(fromName[1])) return fromName[1] === 'jpeg' ? 'jpg' : fromName[1]
  const fromMime = String(mime || '').toLowerCase().split('/')[1]
  if (fromMime === 'jpeg') return 'jpg'
  if (fromMime && ALLOWED_EXT.has(fromMime)) return fromMime
  return null
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'dsh-whale-gallery-submit',
      ...(init.headers || {}),
    },
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} @ ${path}：${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
    if (!env.UPLOAD_KEY || request.headers.get('x-upload-key') !== env.UPLOAD_KEY) {
      return json({ ok: false, error: 'unauthorized' }, 401)
    }
    if (!env.GITHUB_TOKEN || !env.REPO) {
      return json({ ok: false, error: 'worker 未配置' }, 500)
    }

    const form = await request.formData().catch(() => null)
    const file = form && form.get('file')
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ ok: false, error: '没有收到文件' }, 400)
    }
    const buffer = await file.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) {
      return json({ ok: false, error: '文件为空或超过 12MB' }, 400)
    }
    const ext = extOf(file.name, file.type)
    if (ext === null) {
      return json({ ok: false, error: '只收 PNG / JPG / GIF / WebP' }, 400)
    }
    const filename = `dsh-${Date.now()}-${cleanName(file.name)}.${ext}`
    const rand = Math.random().toString(36).slice(2, 8)
    const branch = `submit/${Date.now()}-${rand}`

    try {
      const ref = await gh(`/repos/${env.REPO}/git/ref/heads/main`, env.GITHUB_TOKEN)
      await gh(`/repos/${env.REPO}/git/refs`, env.GITHUB_TOKEN, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
      })
      await gh(`/repos/${env.REPO}/contents/media/${filename}`, env.GITHUB_TOKEN, {
        method: 'PUT',
        body: JSON.stringify({
          message: `投稿：${filename}`,
          content: toBase64(buffer),
          branch,
        }),
      })
      const pr = await gh(`/repos/${env.REPO}/pulls`, env.GITHUB_TOKEN, {
        method: 'POST',
        body: JSON.stringify({
          title: `投稿：${filename}`,
          head: branch,
          base: 'main',
          body: '来自看板娘插件「我要投稿」。合并后 Action 自动生成缩略图并上墙。',
        }),
      })
      return json({ ok: true, pr: pr.html_url, filename })
    } catch (error) {
      return json({ ok: false, error: String((error && error.message) || error) }, 500)
    }
  },
}
