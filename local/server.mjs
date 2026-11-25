import { createServer } from 'node:http'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = '127.0.0.1'
const requestedPort = Number.parseInt(process.env.HTML_EDITOR_PORT || '4173', 10)
const port = Number.isFinite(requestedPort) ? requestedPort : 4173
const appDirectory = fileURLToPath(new URL('.', import.meta.url))
const editorPath = resolve(appDirectory, 'index.html')
const assetRootsPath = resolve(appDirectory, '.asset-roots.json')
const draftsDirectory = resolve(appDirectory, 'saved-drafts')
const currentDraftPath = resolve(draftsDirectory, '自动保存.html')
const previousDraftPath = resolve(draftsDirectory, '上一次保存.html')
const draftMetadataPath = resolve(draftsDirectory, 'draft.json')
const maxHtmlBytes = 20 * 1024 * 1024
const localAssetRoots = new Map()
const execFileAsync = promisify(execFile)
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'], ['.otf', 'font/otf'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
])

try {
  const savedRoots = JSON.parse(await readFile(assetRootsPath, 'utf8'))
  for (const [token, root] of Object.entries(savedRoots)) {
    if (typeof token === 'string' && typeof root === 'string' && isAbsolute(root)) localAssetRoots.set(token, root)
  }
} catch {}

async function registerLocalAssetRoot(root) {
  const token = randomUUID()
  localAssetRoots.set(token, root)
  await writeFile(assetRootsPath, JSON.stringify(Object.fromEntries(localAssetRoots), null, 2), 'utf8')
  return token
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin
  return !origin || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`
}

async function readRequestJson(request, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readDraft() {
  try {
    const [html, metadataText] = await Promise.all([
      readFile(currentDraftPath, 'utf8'),
      readFile(draftMetadataPath, 'utf8').catch(() => '{}'),
    ])
    const metadata = JSON.parse(metadataText)
    return { exists: true, html, name: metadata.name || '本地自动保存.html', savedAt: metadata.savedAt || null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

async function saveDraft(html, name) {
  const content = String(html || '')
  const size = Buffer.byteLength(content, 'utf8')
  if (!content.trim()) throw new Error('没有可保存的 HTML 内容')
  if (size > maxHtmlBytes) throw new Error('草稿不能超过 20 MB')
  await mkdir(draftsDirectory, { recursive: true })
  const tempPath = resolve(draftsDirectory, `.draft-${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content, 'utf8')
    try { await copyFile(currentDraftPath, previousDraftPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    await rename(tempPath, currentDraftPath)
    const metadata = { name: String(name || '本地自动保存.html'), savedAt: new Date().toISOString(), size }
    await writeFile(draftMetadataPath, JSON.stringify(metadata, null, 2), 'utf8')
    return metadata
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

function resolveLocalFile(source) {
  if (source.startsWith('file://')) return fileURLToPath(new URL(source))
  if (isAbsolute(source)) return resolve(source)
  return null
}

async function loadHtmlSource(rawSource) {
  const source = String(rawSource || '').trim()
  if (!source) throw new Error('请粘贴本地 HTML 路径或链接')

  const localPath = resolveLocalFile(source)
  if (localPath) {
    if (!['.html', '.htm'].includes(extname(localPath).toLowerCase())) {
      throw new Error('本地文件必须是 .html 或 .htm')
    }
    const fileInfo = await stat(localPath)
    if (!fileInfo.isFile()) throw new Error('该路径不是文件')
    if (fileInfo.size > maxHtmlBytes) throw new Error('HTML 文件不能超过 20 MB')
    const token = await registerLocalAssetRoot(dirname(localPath))
    return {
      html: await readFile(localPath, 'utf8'),
      name: localPath.split('/').pop() || '导入页面.html',
      baseUrl: `http://${host}:${port}/api/local-assets/${token}/`,
    }
  }

  let url
  try {
    url = new URL(source)
  } catch {
    throw new Error('请输入绝对路径、file:// 链接或本机 http:// 链接')
  }

  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('为保护本机数据，只允许 localhost 或 127.0.0.1 链接')
  }

  const upstream = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!upstream.ok) throw new Error(`本地链接返回 HTTP ${upstream.status}`)
  const length = Number(upstream.headers.get('content-length') || 0)
  if (length > maxHtmlBytes) throw new Error('HTML 文件不能超过 20 MB')
  const html = await upstream.text()
  if (Buffer.byteLength(html, 'utf8') > maxHtmlBytes) throw new Error('HTML 文件不能超过 20 MB')
  const name = decodeURIComponent(url.pathname.split('/').pop() || '导入页面.html')
  return { html, name: /\.html?$/i.test(name) ? name : `${name}.html`, baseUrl: new URL('.', url).href }
}

async function chooseLocalHtml() {
  try {
    const script = 'set chosenFile to choose file with prompt "选择要导入的 HTML 文件" of type {"public.html"}\nPOSIX path of chosenFile'
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 120_000 })
    return loadHtmlSource(stdout.trim())
  } catch (error) {
    if (String(error?.stderr || error?.message || '').includes('User canceled')) throw new Error('已取消选择文件')
    throw error
  }
}

async function sendLocalAsset(url, response) {
  const match = url.pathname.match(/^\/api\/local-assets\/([^/]+)\/(.*)$/)
  if (!match) return false
  const root = localAssetRoots.get(match[1])
  if (!root) throw new Error('本地资源会话已失效，请重新导入 HTML')
  const relativePath = decodeURIComponent(match[2])
  const assetPath = resolve(root, relativePath)
  if (assetPath !== root && !assetPath.startsWith(root + sep)) throw new Error('拒绝读取该资源路径')
  const fileInfo = await stat(assetPath)
  if (!fileInfo.isFile()) throw new Error('资源不是文件')
  const data = await readFile(assetPath)
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(assetPath).toLowerCase()) || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
  return true
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'html-editor-local' })
      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/local-assets/')) {
      await sendLocalAsset(url, response)
      return
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(editorPath)
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(html)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/draft') {
      if (!isAllowedOrigin(request)) {
        sendJson(response, 403, { error: '拒绝来自其他网页的草稿读取请求' })
        return
      }
      sendJson(response, 200, await readDraft())
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/draft') {
      if (!isAllowedOrigin(request)) {
        sendJson(response, 403, { error: '拒绝来自其他网页的保存请求' })
        return
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(response, 415, { error: '请求格式不正确' })
        return
      }
      const body = await readRequestJson(request, maxHtmlBytes * 2 + 1024 * 1024)
      sendJson(response, 200, { ok: true, ...(await saveDraft(body.html, body.name)) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/read-local-html') {
      if (!isAllowedOrigin(request)) {
        sendJson(response, 403, { error: '拒绝来自其他网页的读取请求' })
        return
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(response, 415, { error: '请求格式不正确' })
        return
      }
      const body = await readRequestJson(request)
      sendJson(response, 200, await loadHtmlSource(body.source))
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/choose-local-html') {
      if (!isAllowedOrigin(request)) {
        sendJson(response, 403, { error: '拒绝来自其他网页的文件选择请求' })
        return
      }
      sendJson(response, 200, await chooseLocalHtml())
      return
    }

    sendJson(response, 404, { error: '未找到页面' })
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取失败'
    sendJson(response, 400, { error: message })
  }
})

server.listen(port, host, () => {
  console.log(`HTML 编辑器已启动：http://${host}:${port}`)
  console.log('按 Ctrl+C 可停止服务')
})
