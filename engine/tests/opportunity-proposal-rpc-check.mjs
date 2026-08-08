/**
 * Opportunity Proposal Bridge RPC smoke（P3.3）：真实引擎验证 5 RPC 链路——
 * working-copies/opportunities → opportunity-proposals/context → generate → list → approve。
 * 校验链：context 组装（责任 + 证据回源）→ 候选提交（FACT_GROUNDING 通过/拦截）→ 登记 → 状态转移。
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
      console.log('SKIP：无工作副本或岗位')
      ws.close()
      return
    }
    const wc = wcs[0]
    const job = jobs[0]
    const ops = await rpc('working-copies/opportunities', { wcId: wc.id, jobId: job.id })
    const alignment = ops.find((o) => o.source === 'alignment')
    if (!alignment) {
      console.log('SKIP：无 alignment 机会（全部 covered？）')
      ws.close()
      return
    }
    console.log(`机会：${alignment.id}（${alignment.intent}）`)

    // 1. context 组装
    const ctx = await rpc('opportunity-proposals/context', { opportunityId: alignment.id, wcId: wc.id })
    console.log(`context：责任「${ctx.responsibilityStatement}」· 证据 ${ctx.evidence.length} 条 · ${ctx.currentBlockText ? '当前块存在' : '无当前块（insert）'}`)

    // 2. 非法提交（编造数字）→ 应被 FACT_GROUNDING 拦截
    const after = ctx.currentBlockText ? ctx.currentBlockText : `负责${ctx.responsibilityStatement}，完成验证测试`
    try {
      await rpc('opportunity-proposals/generate', {
        opportunityId: alignment.id,
        wcId: wc.id,
        changes: [{ blockId: alignment.applyTarget?.blockId, before: ctx.currentBlockText ?? '', after: `${after}，使产能提升 99%`, operation: alignment.applyTarget?.action ?? 'insert' }],
      })
      console.log('⚠ 非法提交未被拦截（99% 无证据锚）')
      ws.close()
      process.exit(2)
    } catch (e) {
      console.log(`✅ 非法提交被拦截：${e.message.slice(0, 60)}…`)
    }

    // 3. 合法提交 → 登记
    const proposal = await rpc('opportunity-proposals/generate', {
      opportunityId: alignment.id,
      wcId: wc.id,
      changes: [{ blockId: alignment.applyTarget?.blockId, before: ctx.currentBlockText ?? '', after, operation: alignment.applyTarget?.action ?? 'insert' }],
    })
    console.log(`✅ 登记：${proposal.id}（${proposal.validation.status} · snapshot wcRev=${proposal.validation.sourceSnapshot.wcRevision}）`)

    // 4. list + approve
    const list = await rpc('opportunity-proposals/list')
    console.log(`list：${list.length} 条`)
    const approved = await rpc('opportunity-proposals/approve', { id: proposal.id })
    console.log(`✅ approve：${approved.status}`)

    console.log('\n✅ P3.3 Bridge RPC 链路正常')
    ws.close()
    process.exit(0)
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
