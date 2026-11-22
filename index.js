/**
 * dsh-esp-bridge —— ESP32 语音终端的 DSH 侧桥
 *
 * 作用：外部（ESP32 / 浏览器 / 手机）把一句话用 HTTP 发进来，
 *      桥把它当作「用户说的话」投进 DSH 的活跃会话，等 agent 答完，
 *      再把回复文字用 HTTP 返回去。
 *
 * 对外路由（都挂在 DSH 自己的 web 服务器上）：
 *   GET  /esp/ping               → 自检：服务在不在、有哪些候选会话
 *   GET  /esp/ask?text=...       → 投一句话，返回 JSON（方便浏览器直接试）
 *   POST /esp/ask  {"text":...}  → 同上，程序用
 *
 * 依据（rc.3 实测）：agents.get(sessionId) → handle.agent.followup(message)，
 * 消息必须是 source:{kind:'user'}，别乱改（dsh-selfwake 里记的血泪教训）。
 */

import { appendFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 读 DSH 会话文件：它是 4632 段拼接的 zstd 帧，必须按魔数切帧逐段解压 */
function readSessionEvents(file) {
  const buf = readFileSync(file)
  const offs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  let text = ''
  for (let k = 0; k < offs.length; k++) {
    const slice = buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)
    try { text += zstdDecompressSync(slice).toString('utf8') } catch {}
  }
  const evs = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && typeof o.type === 'string') evs.push(o) } catch {}
  }
  return evs
}
export const inject = ['webServer', 'agents', 'agentDefaultModel']

const ROUTE = '/esp'
const MAX_BODY = 1024 * 1024
const BUILD = 'v4'
/** 已投递、还在等回答的请求（供 /esp/last 补捞） */
const pending = []
const PENDING_MAX = 20

let LOG = join(homedir(), '.dsh', 'esp-bridge.log')

function log(msg) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 会话目录 → 候选 sessionId（新的在前） */
function listSessions(root) {
  const out = []
  function scan(dir, depth) {
    try {
      for (const name of readdirSync(dir)) {
        const sub = join(dir, name)
        let st
        try { st = statSync(sub) } catch { continue }
        if (!st.isDirectory()) continue
        const file = join(sub, 'session.v4.jsonl.zstd')
        if (existsSync(file)) {
          out.push({ id: name, dir: sub, mtime: st.mtimeMs })
        } else if (depth > 0) {
          scan(sub, depth - 1)
        }
      }
    } catch (error) {
      log('listSessions 失败: ' + String(error))
    }
  }
  if (!existsSync(root)) return out
  scan(root, 1)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** session 快照里抽出「assistant 说的话」 */
function extractText(ev) {
  if (!ev || typeof ev !== 'object') return ''
  const isAssistant = ev.type === 'assistant/message' || ev.type === 'agent/message'
  const d = ev.data ?? ev
  const msg = d?.message ?? d
  if (!msg || typeof msg !== 'object') {
    return typeof d?.text === 'string' ? d.text.trim() : ''
  }
  if (!isAssistant && msg.role !== 'assistant') return ''
  const content = msg.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (!p || typeof p !== 'object') continue
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
    }
    return parts.join('').trim()
  }
  if (typeof msg.text === 'string') return msg.text.trim()
  return ''
}
function joinAssistant(snap, p) {
  const parts = []
  const baseLen = Math.max(0, Number(p?.baseLen) || 0)
  const baseline = p?.baseline
  for (let i = 0; i < snap.length; i++) {
    const ev = snap[i]
    const id = ev?.id ?? JSON.stringify(ev).slice(0, 80)
    const isOld = baseline && baseline.has(id)
    if (isOld && i < baseLen) continue
    if (!isOld && i < baseLen) continue
    const t = extractText(ev)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

function snapshot(agent) {
  try {
    const s = agent?.session
    if (!s || typeof s.snapshotEvents !== 'function') return null
    return s.snapshotEvents() ?? []
  } catch (error) {
    log('snapshotEvents 失败: ' + String(error))
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把 text 投进会话，等 assistant 说完。
 * 返回 { ok, text, sessionId, ms, partial }
 */
async function ask(ctx, text, opts) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') {
    return { ok: false, error: '拿不到 agents 服务（插件 inject 没生效？）' }
  }

  const candidates = []
  if (opts.sessionId) candidates.push({ id: opts.sessionId, mtime: Number.MAX_SAFE_INTEGER })
  const known = listSessions(opts.sessionsRoot)
  const byId = new Map(known.map((s) => [s.id, s]))
  let liveIds = []
  try {
    if (agents.store && typeof agents.store.keys === 'function') liveIds = [...agents.store.keys()]
  } catch { /* store 结构变了就退回目录扫描 */ }
  for (const id of liveIds) candidates.push(byId.get(id) ?? { id, mtime: 0 })
  for (const s of known) candidates.push(s)

  const tried = []
  const live = []
  for (const c of candidates) {
    try {
      const handle = agents.get(c.id)
      const a = handle?.agent ?? handle
      if (a && typeof a.followup === 'function') {
        live.push({ a, id: c.id, mtime: Number(c.mtime) || 0 })
      } else {
        tried.push(String(c.id).slice(0, 8) + ':无句柄')
      }
    } catch (error) {
      tried.push(String(c.id).slice(0, 8) + ':' + String(error?.message ?? error).slice(0, 40))
    }
  }
  if (!live.length) {
    return { ok: false, error: '没有活跃会话可投（窗口没开？）', tried }
  }
  // 指定了目标会话却不在活跃列表里：绝不退回别的会话，让桥去重建
  if (opts.sessionId && !live.some((x) => x.id === opts.sessionId)) {
    return { ok: false, error: '目标会话已回收', needRecreate: true, target: opts.sessionId, tried }
  }
  live.sort((x, y) => y.mtime - x.mtime)
  const agent = live[0].a
  const usedId = live[0].id

  const before = snapshot(agent)
  if (before === null) return { ok: false, error: '这个会话拿不到 snapshotEvents' }
  const seen = new Set(before.map((e) => e?.id ?? JSON.stringify(e).slice(0, 80)))

  const message = {
    id: `esp-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }

  const started = Date.now()
  try {
    agent.followup(message)
  } catch (error) {
    return { ok: false, error: 'followup 抛错：' + String(error?.message ?? error) }
  }
  log(`ask -> ${usedId} : ${text.slice(0, 60)}`)
  pending.push({ sessionId: usedId, baseline: seen, baseLen: before.length, at: started })
  if (pending.length > PENDING_MAX) pending.shift()

  // 轮询：等新的 assistant 文本，稳定 2 秒后收工
  let lastText = ''
  let lastChange = 0
  const deadline = started + opts.waitMs
  while (Date.now() < deadline) {
    await sleep(400)
    const now = snapshot(agent) ?? []
    const parts = []
    for (const ev of now) {
      const key = ev?.id ?? JSON.stringify(ev).slice(0, 80)
      if (seen.has(key)) continue
      const t = extractText(ev)
      if (t) parts.push(t)
    }
    const joined = parts.join('\n').trim()
    if (joined && joined !== lastText) {
      lastText = joined
      lastChange = Date.now()
    } else if (lastText && Date.now() - lastChange > 2000) {
      break
    }
  }

  const ms = Date.now() - started
  log(`ask <- ${usedId} (${ms}ms): ${lastText.slice(0, 60)}`)
  return {
    ok: true,
    text: lastText,
    sessionId: usedId,
    ms,
    partial: lastText === '' || Date.now() >= deadline,
  }
}

/**
 * 流式版 ask：每有新文本就回调 onDelta(full, delta)，用于桥做「边生成边合成」。
 * 返回 { ok, text, sessionId }
 */
async function askStream(ctx, text, opts, onDelta) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') {
    return { ok: false, error: '拿不到 agents 服务（插件 inject 没生效？）' }
  }
  const candidates = []
  if (opts.sessionId) candidates.push({ id: opts.sessionId, mtime: Number.MAX_SAFE_INTEGER })
  const known = listSessions(opts.sessionsRoot)
  const byId = new Map(known.map((s) => [s.id, s]))
  let liveIds = []
  try {
    if (agents.store && typeof agents.store.keys === 'function') liveIds = [...agents.store.keys()]
  } catch { /* ignore */ }
  for (const id of liveIds) candidates.push(byId.get(id) ?? { id, mtime: 0 })
  for (const s of known) candidates.push(s)

  const live = []
  for (const c of candidates) {
    try {
      const handle = agents.get(c.id)
      const a = handle?.agent ?? handle
      if (a && typeof a.followup === 'function') live.push({ a, id: c.id, mtime: Number(c.mtime) || 0 })
    } catch { /* ignore */ }
  }
  if (!live.length) return { ok: false, error: '没有活跃会话可投' }
  if (opts.sessionId && !live.some((x) => x.id === opts.sessionId)) {
    return { ok: false, error: '目标会话已回收', needRecreate: true, target: opts.sessionId }
  }
  live.sort((x, y) => y.mtime - x.mtime)
  const agent = live[0].a
  const usedId = live[0].id

  const before = snapshot(agent)
  if (before === null) return { ok: false, error: '这个会话拿不到 snapshotEvents' }
  const seen = new Set(before.map((e) => e?.id ?? JSON.stringify(e).slice(0, 80)))

  const message = {
    id: `esp-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  try {
    agent.followup(message)
  } catch (error) {
    return { ok: false, error: 'followup 抛错：' + String(error?.message ?? error) }
  }
  log(`stream -> ${usedId} : ${text.slice(0, 60)}`)
  pending.push({ sessionId: usedId, baseline: seen, baseLen: before.length, at: Date.now() })
  if (pending.length > PENDING_MAX) pending.shift()

  let lastText = ''
  let lastChange = Date.now()
  const deadline = Date.now() + opts.waitMs
  while (Date.now() < deadline) {
    await sleep(250)
    const now = snapshot(agent) ?? []
    const parts = []
    for (const ev of now) {
      const key = ev?.id ?? JSON.stringify(ev).slice(0, 80)
      if (seen.has(key)) continue
      const t = extractText(ev)
      if (t) parts.push(t)
    }
    const joined = parts.join('\n').trim()
    if (joined && joined !== lastText) {
      const delta = joined.startsWith(lastText) ? joined.slice(lastText.length) : joined
      lastText = joined
      lastChange = Date.now()
      try { onDelta?.(joined, delta) } catch { /* ignore */ }
    } else if (lastText && Date.now() - lastChange > 1500) {
      break
    }
  }
  log(`stream <- ${usedId}: ${lastText.slice(0, 60)}`)
  return { ok: true, text: lastText, sessionId: usedId }
}

export function apply(ctx, config = {}) {
  const opts = {
        sessionsRoot: config.sessionsRoot ?? join(homedir(), '.dsh', 'sessions'),
    sessionId: config.sessionId ?? '',
    waitMs: Number(config.waitMs ?? 180000),
    personaPath: config.personaPath ?? join(homedir(), '.dsh', 'esp-persona.txt'),
    cwd: config.cwd ?? process.cwd(),
  }
  if (config.logFile) LOG = config.logFile

  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) {
    log('没有 webServer 服务，esp-bridge 不注册路由')
    return
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        try {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            })
            return res.end()
          }

          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const sub = url.pathname.slice(ROUTE.length) || '/'

          if (sub === '/newvoice') {
            const agents = ctx.get('agents')
            const out = { ok: false }
            try {
              const src = url.searchParams.get('from') || ''
              const dir = url.searchParams.get('dir') || ''
              const take = Math.min(200, Number(url.searchParams.get('take') || 40))
              const personaPath = url.searchParams.get('persona') || opts.personaPath
              const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8').trim() : ''
              out.personaChars = persona.length

              let evs = []
              const srcHandle = src ? agents.get(src) : null
              const srcAgent = srcHandle?.agent ?? srcHandle
              if (srcAgent?.session?.snapshotEvents) {
                try { evs = srcAgent.session.snapshotEvents() ?? [] } catch (e) { out.liveErr = String(e?.message ?? e) }
              }
              out.srcEvents = evs.length

              if (!evs.length && dir) {
                try {
                  const file = join(dir, 'session.v4.jsonl.zstd')
                  if (existsSync(file)) {
                    evs = readSessionEvents(file)
                    out.fileEvents = evs.length
                  }
                } catch (e) { out.fileErr = String(e?.message ?? e).slice(0, 200) }
              }

              const seed = []
              if (persona) seed.push({ type: 'system/message', time: Date.now(), data: { turn: 1, step: 1, message: { id: 'persona-' + randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: persona }] } } })
              const msgs = []
              for (const e of evs) {
                if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
                const msg = e.type === 'user/message' ? (e.data?.message ?? e.data) : e.data?.message
                if (!msg || !Array.isArray(msg.content)) continue
                const content = msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
                if (!content.length) continue
                if (e.type === 'user/message') {
                  msgs.push({ type: 'user/message', time: e.time, data: { id: msg.id || ('u-' + randomUUID()), role: 'user', source: msg.source ?? { kind: 'user' }, content } })
                } else {
                  msgs.push({ type: 'assistant/message', time: e.time, data: { turn: Number(e.data?.turn ?? 0), step: Number(e.data?.step ?? 0), stream: [], message: { id: msg.id || ('a-' + randomUUID()), role: 'assistant', source: msg.source ?? { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content } } })
                }
              }
              for (const m of msgs.slice(-take)) seed.push(m)
              seed.forEach((e, i) => { e.seq = i; if (!e.surfaceOp) e.surfaceOp = 'append' })
              out.tookMsgs = Math.min(take, msgs.length)
              out.seedCount = seed.length
              const id = 'voice-' + randomUUID()
              const sel = (ctx.agentDefaultModel?.currentSelection?.() ?? { provider: 'deepseek-official', model: 'deepseek-flash' })
              await agents.create({ sessionId: id, seed, agentOptions: { provider: sel.provider, model: sel.model }, meta: { cwd: opts.cwd } })
              out.ok = true
              out.sessionId = id
              log('新建语音会话 ' + id + '，seed=' + seed.length)
            } catch (e) {
              out.error = String(e?.message ?? e)
              out.detail = String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 700)
              log('新建语音会话失败: ' + out.error)
            }
            return json(res, 200, out)
          }
          if (sub === '/ping') {
            const sessions = listSessions(opts.sessionsRoot)
            const agents = ctx.get('agents')
            let live = []
            try { if (agents?.store?.keys) live = [...agents.store.keys()] } catch { /* ignore */ }
            return json(res, 200, {
              ok: true,
              service: 'dsh-esp-bridge',
              build: BUILD,
              hasAgents: !!agents && typeof agents.get === 'function',
              sessionsRoot: opts.sessionsRoot,
              live,
              sessions: sessions.slice(0, 5).map((s) => ({ id: s.id, dir: s.dir })),
            })
          }

          if (sub === '/debug') {
            const agents = ctx.get('agents')
            const out = { proto: [], store: null, ctxKeys: [], probes: [] }
            try {
              out.proto = Object.getOwnPropertyNames(Object.getPrototypeOf(agents)).slice(0, 60)
            } catch (e) { out.protoErr = String(e) }
            try {
              const store = agents.store
              const desc = { type: typeof store, ctor: store?.constructor?.name ?? null }
              if (store && typeof store.keys === 'function') desc.keys = [...store.keys()].slice(0, 20)
              if (typeof store?.size === 'number') desc.size = store.size
              if (store && typeof store === 'object' && typeof store.keys !== 'function') desc.own = Object.keys(store).slice(0, 20)
              out.store = desc
            } catch (e) { out.storeErr = String(e) }
            try {
              const root = ctx
              const seen = []
              for (const k of ['sessions', 'conversations', 'session', 'conversation', 'agent', 'agents', 'store', 'runtime', 'workspace', 'windows', 'gui', 'client']) {
                let v
                try { v = root.get ? root.get(k) : root[k] } catch { v = undefined }
                if (v !== undefined) seen.push(k + ':' + (typeof v) + (v?.constructor?.name ? '/' + v.constructor.name : ''))
              }
              out.ctxKeys = seen
            } catch (e) { out.ctxErr = String(e) }
            const sessions = listSessions(opts.sessionsRoot)
            const newest = sessions[0]
            const cands = newest ? [newest.id, 'session-' + newest.id, newest.dir] : []
            for (const key of cands) {
              const row = { key, viaGet: 'undef', viaStore: 'undef' }
              try { const g = agents?.get?.(key); row.viaGet = g == null ? 'null' : (typeof g + (g.constructor?.name ? '/' + g.constructor.name : '')) } catch (e) { row.viaGet = 'err:' + String(e?.message ?? e) }
              try { const s = agents?.store?.get?.(key); row.viaStore = s == null ? 'null' : (typeof s + (s.constructor?.name ? '/' + s.constructor.name : '')) } catch (e) { row.viaStore = 'err:' + String(e?.message ?? e) }
              out.probes.push(row)
            }
            return json(res, 200, out)
          }
          if (sub === '/dump') {
            const n = Math.min(20, Number(url.searchParams.get('n') || 8))
            const ag = ctx.get('agents')
            const out = []
            let dumpIds = []
            try {
              if (ag?.store && typeof ag.store.keys === 'function') dumpIds = [...ag.store.keys()]
            } catch { /* ignore */ }
            if (!dumpIds.length) dumpIds = listSessions(opts.sessionsRoot).slice(0, 3).map((s) => s.id)
            for (const sid of dumpIds) {
              const h = ag?.get ? ag.get(sid) : null
              const a = h?.agent ?? h
              if (!a) continue
              const snap = snapshot(a) ?? []
              out.push({
                id: sid,
                count: snap.length,
                tail: snap.slice(-n).map((ev) => {
                  const m = ev?.message ?? ev
                  return {
                    id: ev?.id ?? null,
                    evType: ev?.type ?? null,
                    role: m?.role ?? null,
                    text: extractText(ev).slice(0, 40),
                    keys: Object.keys(ev ?? {}).slice(0, 8),
                    dataKeys: Object.keys(ev?.data ?? {}).slice(0, 10),
                    dataPeek: JSON.stringify(ev?.data ?? null).slice(0, 160),
                  }
                }),
              })
            }
            return json(res, 200, { ok: true, out })
          }

          if (sub === '/stream') {
            const text = url.searchParams.get('text') ?? ''
            if (!text) return json(res, 400, { ok: false, error: 'need text' })
            res.writeHead(200, {
              'content-type': 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-cache',
              'Access-Control-Allow-Origin': '*',
            })
            const write = (o) => { try { res.write(JSON.stringify(o) + '\n') } catch { /* closed */ } }
            let streamed = ''
            const r = await askStream(ctx, text, opts, (full, delta) => {
              streamed = full
              if (delta) write({ delta })
            })
            write({ done: true, ok: r.ok, text: r.text || streamed, sessionId: r.sessionId, error: r.error })
            res.end()
            return
          }

          if (sub === '/last') {
            const agents2 = ctx.get('agents')
            const drained = []
            for (const p of pending.slice()) {
              try {
                const handle = agents2.get(p.sessionId)
                const a = handle?.agent ?? handle
                if (!a) continue
                const snap = snapshot(a)
                if (snap === null) continue
                const text = joinAssistant(snap, p)
                if (text) {
                  drained.push({ sessionId: p.sessionId, text, ageMs: Date.now() - p.at })
                  pending.splice(pending.indexOf(p), 1)
                }
              } catch (e) {
                drained.push({ sessionId: p.sessionId, error: String(e?.message ?? e) })
              }
            }
            return json(res, 200, { ok: true, count: drained.length, drained, waiting: pending.length })
          }

          if (sub === '/ask') {
            let text = url.searchParams.get('text') ?? ''
            if (req.method === 'POST') {
              const raw = await readBody(req)
              if (raw) {
                try {
                  const body = JSON.parse(raw)
                  if (typeof body?.text === 'string' && body.text.trim()) text = body.text
                  if (typeof body?.sessionId === 'string' && body.sessionId) opts.sessionId = body.sessionId
                } catch {
                  text = raw
                }
              }
            }
            text = String(text).trim()
            if (!text) return json(res, 400, { ok: false, error: '缺少 text' })
            const result = await ask(ctx, text, opts)
            return json(res, result.ok ? 200 : 500, result)
          }

          return json(res, 404, { ok: false, error: 'unknown path ' + sub })
        } catch (error) {
          log('handler 抛错: ' + String(error?.stack ?? error))
          try {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          } catch {
            /* 已经发过头了 */
          }
        }
      },
    }),
  )

  log('esp-bridge 已注册路由 ' + ROUTE + '，sessionsRoot=' + opts.sessionsRoot)
}