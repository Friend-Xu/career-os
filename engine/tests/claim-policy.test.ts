/**
 * claim-policy 单测：canUseClaim——Claim 没有可信度只有可消费性（从证据继承推导）。
 * 证据 archived/删除 → 自动不可用；provenance 空恒 false（every 空数组陷阱显式拦截）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CareerClaim, EvidenceItem } from '../ir/schema.ts'
import { canUseClaim, indexEvidence } from '../storage/claim-policy.ts'

function ev(id: string, status: EvidenceItem['status']): EvidenceItem {
  return {
    id,
    event: { title: id },
    role: '机械结构负责人',
    contribution: '负责机架设计',
    evidence: { scope: [{ content: '机架设计' }] },
    source: { type: 'user_input', capturedAt: '2026-08-05' },
    status,
  }
}

function claim(evidenceIds: string[], overrides: Partial<CareerClaim> = {}): CareerClaim {
  return {
    id: 'claim_20260805_00001',
    created_at: '2026-08-05',
    source: 'agent_generated',
    statement: '负责自动化设备机械结构设计',
    claimType: 'fact',
    provenance: evidenceIds.map((evidenceId) => ({ evidenceId })),
    ...overrides,
  }
}

test('canUseClaim：provenance 全部 trusted → true', () => {
  const items = [ev('evidence_20260805_00001', 'trusted'), ev('evidence_20260805_00002', 'trusted')]
  const idx = indexEvidence(items)
  assert.equal(canUseClaim(claim(['evidence_20260805_00001', 'evidence_20260805_00002']), idx), true)
})

test('canUseClaim：任一证据非 trusted → false（候选/raw/archived 均不可消费）', () => {
  for (const status of ['candidate', 'raw', 'archived'] as const) {
    const items = [ev('evidence_20260805_00001', 'trusted'), ev('evidence_20260805_00002', status)]
    const idx = indexEvidence(items)
    assert.equal(canUseClaim(claim(['evidence_20260805_00001', 'evidence_20260805_00002']), idx), false, status)
  }
})

test('canUseClaim：provenance 空 → false（Claim 不脱离证据；空数组 every=true 陷阱显式拦截）', () => {
  assert.equal(canUseClaim(claim([]), indexEvidence([])), false)
})

test('canUseClaim：引用不存在的证据 → false（孤儿 claim 自动不可用）', () => {
  const items = [ev('evidence_20260805_00001', 'trusted')]
  const idx = indexEvidence(items)
  assert.equal(canUseClaim(claim(['evidence_20260805_00099']), idx), false)
})

test('canUseClaim：证据 archived → claim 自动失效（无孤儿维护）', () => {
  const items = [ev('evidence_20260805_00001', 'archived')]
  const idx = indexEvidence(items)
  assert.equal(canUseClaim(claim(['evidence_20260805_00001']), idx), false)
})

test('indexEvidence：evidenceId → item 索引', () => {
  const items = [ev('evidence_20260805_00001', 'trusted')]
  const idx = indexEvidence(items)
  assert.equal(idx.get('evidence_20260805_00001')?.contribution, '负责机架设计')
  assert.equal(idx.has('evidence_20260805_00002'), false)
})
