import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../storage/graph-builder.ts'
import type { DecisionPayload, DecisionRecord, RiskLevel } from '../ir/schema.ts'

function decision(payload?: DecisionPayload, over: Partial<DecisionRecord> = {}): Parameters<typeof buildGraph>[0]['decisions'][number] {
  return {
    sourceFile: 'x.md',
    record: {
      id: 'd-1',
      title: 't',
      skill: 'city-advisor',
      direction: '机器人结构设计',
      directionMatch: 82,
      riskLevel: 'medium' as RiskLevel,
      keyRisk: 'k',
      status: 'complete',
      profile: '你好',
      summary: 's',
      createdAt: '2026-08-07',
      protocolVersion: '2.8',
      ...(payload ? { payload } : {}),
      ...over,
    },
  }
}

function graphOf(d: Parameters<typeof buildGraph>[0]['decisions'][number]) {
  return buildGraph({ decisions: [d], companies: [], profileNames: [] })
}

test('城市 payload → 每城市独立节点（各自得分、边强度）', () => {
  const { nodes, edges } = graphOf(
    decision({
      type: 'city',
      direction: '机器人结构设计',
      cities: [
        { name: '苏州', score: 76, strengths: [], risks: [] },
        { name: '深圳', score: 69.5, strengths: [], risks: [] },
      ],
    }),
  )
  const su = nodes.find((n) => n.id === 'city:苏州')
  const sz = nodes.find((n) => n.id === 'city:深圳')
  assert.ok(su && su.matchScore === 76, '苏州节点应带 76 分')
  assert.ok(sz && sz.matchScore === 69.5, '深圳节点应带 69.5 分')
  const edgeSu = edges.find((e) => e.source === 'decision:d-1' && e.target === 'city:苏州')
  const edgeSz = edges.find((e) => e.source === 'decision:d-1' && e.target === 'city:深圳')
  assert.equal(edgeSu?.relation, '位于')
  assert.equal(edgeSu?.strength, 'medium') // 76 → medium
  assert.equal(edgeSz?.strength, 'medium') // 69.5 → medium
  assert.ok(!nodes.some((n) => n.id === 'city:苏州 / 深圳'), '不应出现整串城市节点')
})

test('方向 payload → 每方向独立节点（各自匹配）', () => {
  const { nodes, edges } = graphOf(
    decision({
      type: 'direction',
      directions: [
        { name: '医疗器械结构设计', match: 71, strengths: [], risks: [] },
        { name: '热管理', match: 59, strengths: [], risks: [] },
      ],
    }),
  )
  const a = nodes.find((n) => n.id === 'direction:医疗器械结构设计')
  const b = nodes.find((n) => n.id === 'direction:热管理')
  assert.ok(a && a.matchScore === 71)
  assert.ok(b && b.matchScore === 59)
  const edgeA = edges.find((e) => e.source === 'decision:d-1' && e.target === 'direction:医疗器械结构设计')
  assert.equal(edgeA?.relation, '归属')
  assert.equal(edgeA?.strength, 'medium') // 71 → medium
  assert.ok(!nodes.some((n) => n.id.includes(' / ')), '不应出现整串方向节点')
})

test('无 payload（存量决策）：单字符串 city/direction 节点 fallback', () => {
  const { nodes } = graphOf(decision(undefined, { city: '苏州 / 深圳', directionMatch: 82 }))
  assert.ok(nodes.some((n) => n.id === 'city:苏州 / 深圳'), '旧协议整串城市保持单节点')
  assert.ok(nodes.some((n) => n.id === 'direction:机器人结构设计'))
})
