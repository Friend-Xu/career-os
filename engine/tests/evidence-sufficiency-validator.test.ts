import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveNextAction,
  foldState,
  validateEvidenceSufficiency,
  type SufficiencyAssessment,
  type SufficiencyDimension,
  type SufficiencyState,
} from '../runtime/evidence-sufficiency-validator.ts'

/** 构造完整 9 维声明（默认全 RESOLVED + 每维一个来源） */
function assessment(overrides: {
  state?: SufficiencyState
  dims?: Partial<Record<string, Partial<SufficiencyDimension>>>
  conflicts?: SufficiencyAssessment['conflicts']
  limitations?: SufficiencyAssessment['limitations']
  nextAction?: 'stop' | 'continue' | 'finalize'
}): SufficiencyAssessment {
  const keys = [
    'company_overview', 'industry', 'products', 'business',
    'hiring', 'salary', 'financing', 'risk', 'career_development',
  ]
  const dimensions: SufficiencyDimension[] = keys.map((key) => ({
    key,
    status: 'RESOLVED',
    retries: 0,
    sources: [{ domain: `src-${key}.example.com`, tier: 'official' }],
    note: '',
    ...overrides.dims?.[key],
  }))
  return {
    state: overrides.state ?? 'SUFFICIENT',
    dimensions,
    conflicts: overrides.conflicts ?? [],
    limitations: overrides.limitations ?? [],
    nextAction: overrides.nextAction ?? 'stop',
  }
}

/** 渲染为回答文本（json 围栏 + 前置正文行） */
function textOf(a: SufficiencyAssessment): string {
  const json = JSON.stringify({ sufficiency: a }, null, 2)
  return `已调查完主要方面，结论见下。\n\n## SUFFICIENCY_STATE\n\n\`\`\`json\n${json}\n\`\`\`\n`
}

function validate(a: SufficiencyAssessment, conf?: { enabledChannels?: string[]; exhaustedChannels?: string[] }) {
  return validateEvidenceSufficiency({ text: textOf(a), ...conf })
}

// ─── Golden Flow A：正常充分 → SUFFICIENT + stop（预算剩余也停） ───────────────

test('A 正常充分：全 critical RESOLVED → SUFFICIENT + stop（无 issues）', () => {
  const r = validate(assessment({}))
  assert.equal(r.valid, true, r.issues.join('; '))
  assert.equal(r.assessment?.state, 'SUFFICIENT')
  assert.equal(r.assessment?.nextAction, 'stop')
})

test('A2 非关键维度 UNCERTAIN 不阻止 SUFFICIENT（记录但透明）', () => {
  const a = assessment({
    dims: { financing: { status: 'UNCERTAIN', note: '单来源' } },
    nextAction: 'stop',
  })
  const r = validate(a)
  assert.equal(r.valid, true, r.issues.join('; '))
})

// ─── Golden Flow B：明显缺口 → GAP + continue（定向再查） ─────────────────────

test('B 明显缺口：risk UNCOVERED 且通道可用 → GAP + continue', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取：公示系统未收录' } },
    nextAction: 'continue',
  })
  const r = validate(a)
  assert.equal(r.valid, true, r.issues.join('; '))
  assert.equal(r.assessment?.state, 'GAP')
})

test('B2 缺口但无可用通道 → finalize + limitation=gap', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取' } },
    limitations: [{ type: 'gap', dimension: 'risk', note: '风险维度未获取' }],
    nextAction: 'finalize',
  })
  // 只启用 nbs（risk 不适用）→ risk 无可用通道
  const r = validate(a, { enabledChannels: ['nbs'] })
  assert.equal(r.valid, true, r.issues.join('; '))
})

// ─── Golden Flow C：来源冲突 → CONFLICTED → 继续 / 无法消解 → finalize ───────

test('C 来源冲突：salary CONFLICTED 且有可用独立来源 → continue', () => {
  const a = assessment({
    state: 'CONFLICTED',
    dims: {
      salary: {
        status: 'CONFLICTED',
        sources: [
          { domain: 'zhipin.com', tier: 'recruiting' },
          { domain: 'liepin.com', tier: 'recruiting' },
        ],
        note: '口径差异',
      },
    },
    conflicts: [{ dimension: 'salary', note: '税前月薪 vs 年包估算' }],
    nextAction: 'continue',
  })
  const r = validate(a)
  assert.equal(r.valid, true, r.issues.join('; '))
})

test('C2 冲突已尝试（retries=1）→ finalize + limitation=conflict（诚实区间输出）', () => {
  const a = assessment({
    state: 'CONFLICTED',
    dims: {
      salary: {
        status: 'CONFLICTED',
        retries: 1,
        sources: [
          { domain: 'zhipin.com', tier: 'recruiting' },
          { domain: 'liepin.com', tier: 'recruiting' },
        ],
        note: '口径差异',
      },
    },
    conflicts: [{ dimension: 'salary', note: '税前月薪 vs 年包估算' }],
    limitations: [{ type: 'conflict', dimension: 'salary', note: '无法消解，输出 9-14K 参考区间' }],
    nextAction: 'finalize',
  })
  const r = validate(a)
  assert.equal(r.valid, true, r.issues.join('; '))
})

// ─── Golden Flow D：预算耗尽（关键）→ 语义与事实分权 ─────────────────────────

test('D1 部分通道耗尽：仍可经其他通道继续 → GAP + continue + limitation=budget_exhausted', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取' } },
    limitations: [{ type: 'budget_exhausted', channel: 'web_search', note: '快搜额度用尽' }],
    nextAction: 'continue',
  })
  // web_search 耗尽；risk 适用通道含 exa（仍可用）→ 可继续
  const r = validate(a, { enabledChannels: ['web_search', 'exa'], exhaustedChannels: ['web_search'] })
  assert.equal(r.valid, true, r.issues.join('; '))
})

test('D2 全部通道耗尽 → finalize + limitations（budget_exhausted + gap）', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取' } },
    limitations: [
      { type: 'budget_exhausted', channel: 'web_search', note: '快搜额度用尽' },
      { type: 'budget_exhausted', channel: 'exa', note: '深查额度用尽' },
      { type: 'gap', dimension: 'risk', note: '风险维度未获取' },
    ],
    nextAction: 'finalize',
  })
  const r = validate(a, { enabledChannels: ['web_search', 'exa'], exhaustedChannels: ['web_search', 'exa'] })
  assert.equal(r.valid, true, r.issues.join('; '))
})

test('D3 红线：budget_exhausted 未记录 → I.10 违规', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取' } },
    nextAction: 'continue',
  })
  const r = validate(a, { enabledChannels: ['web_search', 'exa'], exhaustedChannels: ['web_search'] })
  assert.equal(r.valid, false)
  assert.ok(r.issues.some((i) => i.includes('I.10')), r.issues.join('; '))
})

// ─── Golden Flow E：无关通道耗尽 → 不阻止已成立的 SUFFICIENT ─────────────────

test('E 通道耗尽但充分成立：SUFFICIENT + limitation=budget_exhausted（预算事实 ≠ 质量判决）', () => {
  const a = assessment({
    limitations: [{ type: 'budget_exhausted', channel: 'web_search', note: '无关通道耗尽（仅记录）' }],
    nextAction: 'stop',
  })
  const r = validate(a, { enabledChannels: ['web_search', 'exa'], exhaustedChannels: ['web_search'] })
  assert.equal(r.valid, true, r.issues.join('; '))
})

// ─── 违规矩阵（机械红线） ───────────────────────────────────────────────────

test('伪造 SUFFICIENT：critical 维度 UNCERTAIN 却声明 SUFFICIENT → I.8 折叠违规', () => {
  const a = assessment({
    dims: { salary: { status: 'UNCERTAIN', note: '单来源' } },
    nextAction: 'stop',
  })
  const r = validate(a)
  assert.equal(r.valid, false)
  assert.ok(r.issues.some((i) => i.includes('I.8')), r.issues.join('; '))
  assert.equal(foldState(a), 'UNCERTAIN')
})

test('I.1 缺失 header / 缺失围栏 → 违规', () => {
  const a = assessment({})
  assert.equal(validateEvidenceSufficiency({ text: '没有状态段的回答' }).valid, false)
  const noFence = `${JSON.stringify({ sufficiency: a })}`
  const r = validateEvidenceSufficiency({ text: `## SUFFICIENCY_STATE\n\n${noFence}` })
  assert.equal(r.valid, false)
  assert.ok(r.issues[0]!.includes('I.1'))
})

test('I.2 非 JSON / 字段结构缺失 → 违规', () => {
  const r = validateEvidenceSufficiency({ text: '## SUFFICIENCY_STATE\n\n```json\nnot json\n```' })
  assert.equal(r.valid, false)
  assert.ok(r.issues[0]!.includes('I.2'))
})

test('I.3 枚举非法：state=QUALITY_GOOD / dimension 状态非法 → 违规', () => {
  const good = assessment({})
  const bad = { ...good, state: 'QUALITY_GOOD' as unknown as SufficiencyState, dimensions: [{ ...good.dimensions[0]!, status: 'PERFECT' as never }] }
  const r = validate(bad)
  assert.equal(r.valid, false)
  assert.ok(r.issues.some((i) => i.includes('I.3')), r.issues.join('; '))
})

test('I.4 完整性：缺失维度 / 多余维度 → 违规', () => {
  const a = assessment({})
  const missing = { ...a, dimensions: a.dimensions.filter((d) => d.key !== 'salary') }
  assert.ok(validate(missing).issues.some((i) => i.includes('I.4 完整性：缺少维度 salary')))
  const extra = { ...a, dimensions: [...a.dimensions, { key: '舆情', status: 'RESOLVED' as const, sources: [{ domain: 'x.com', tier: 'official' as const }] }] }
  assert.ok(validate(extra).issues.some((i) => i.includes('I.4 完整性：多余维度 舆情')))
})

test('I.5 来源规则：RESOLVED 无来源 / UNCOVERED 无 note → 违规', () => {
  const a = assessment({})
  const noSource = { ...a, dimensions: a.dimensions.map((d) => (d.key === 'risk' ? { ...d, sources: [] } : d)) }
  assert.ok(validate(noSource).issues.some((i) => i.includes('I.5')))
  const uncoveredNoNote = { ...a, dimensions: a.dimensions.map((d) => (d.key === 'risk' ? { ...d, status: 'UNCOVERED' as const, sources: [], note: '' } : d)) }
  assert.ok(validate(uncoveredNoNote).issues.some((i) => i.includes('I.5')))
})

test('I.6 再查配额：retries=2 → 违规', () => {
  const a = assessment({ dims: { salary: { retries: 2 } } })
  assert.ok(validate(a).issues.some((i) => i.includes('I.6')), validate(a).issues.join('; '))
})

test('I.7 冲突一致性：conflicts 引用非 CONFLICTED 维度 → 违规', () => {
  const a = assessment({ conflicts: [{ dimension: 'salary', note: '差异' }] })
  assert.ok(validate(a).issues.some((i) => i.includes('I.7')), validate(a).issues.join('; '))
})

test('I.9 下一动作：GAP 却说 stop → derive 不符 → 违规', () => {
  const a = assessment({
    state: 'GAP',
    dims: { risk: { status: 'UNCOVERED', sources: [], note: '未获取' } },
    nextAction: 'stop',
  })
  const r = validate(a)
  assert.equal(r.valid, false)
  assert.ok(r.issues.some((i) => i.includes('I.9')), r.issues.join('; '))
  assert.equal(deriveNextAction('GAP', a, { text: '' }), 'continue')
})

test('I.11 交叉一致：limitation=uncertainty 但无 UNCERTAIN 维度 → 违规', () => {
  const a = assessment({ limitations: [{ type: 'uncertainty', note: 'x' }] })
  assert.ok(validate(a).issues.some((i) => i.includes('I.11')), validate(a).issues.join('; '))
})
