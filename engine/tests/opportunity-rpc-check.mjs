/**
 * Opportunity RPC smoke（P3.2）：真实引擎验证 working-copies/opportunities。
 * 用法：npm run smoke:opportunity（或 npx tsx tests/opportunity-rpc-check.mjs）
 */
import { WebSocket } from 'ws'

const URL = process.env.COS_WS_URL ?? 'ws://127.0.0.1:5289'
const ws = new WebSocket(URL)
let nextId = 1
const pending = new Map()

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++)
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`))
    else resolve(msg.result)
  }
})

ws.on('open', async () => {
  try {
    await rpc('system/init')
    const wcs = await rpc('working-copies/list')
    const jobs = await rpc('jobs/list')
    if (wcs.length === 0 || jobs.length === 0) {
      console.log('SKIP：无工作副本或岗位（wc=%d jobs=%d）', wcs.length, jobs.length)
      ws.close()
      return
    }
    const wc = wcs[0]
    const job = jobs[0]
    console.log(`工作副本：${wc.id.slice(-10)}（${wc.sections.length} 段）`)
    console.log(`岗位：${job.company} · ${job.title}`)
    const ops = await rpc('working-copies/opportunities', { wcId: wc.id, jobId: job.id })
    console.log(`\n机会投影：${ops.length} 条`)
    for (const o of ops) {
      const t = o.applyTarget
        ? ` → ${o.applyTarget.action}${o.applyTarget.blockId ? ` b:${o.applyTarget.blockId.slice(-8)}` : '（新块）'}`
        : ''
      console.log(`[${o.severity}/${o.intent}] ${o.source} ${o.id}${t}`)
      console.log(`  ${o.suggestedAction}`)
      console.log(`  证据 ${o.refs.evidenceIds.length} · claim ${o.refs.claimIds.length}`)
    }
    const pass = ops.length > 0
    console.log(pass ? '\n✅ opportunities RPC 正常' : '\n⚠ 机会为空（数据均为 covered？）')
    ws.close()
    process.exit(pass ? 0 : 2)
  } catch (e) {
    console.error('❌', e.message)
    ws.close()
    process.exit(1)
  }
})

ws.on('error', (e) => {
  console.error('WS 错误：', e.message)
  process.exit(1)
})
