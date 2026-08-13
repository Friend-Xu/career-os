import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PersonEducation } from '../ir/schema.ts'
import { parseJdConstraint } from '../runtime/jd-constraint.ts'
import { matchEducation, matchExperience, experienceYearsOf } from '../runtime/constraint-matcher.ts'

const edu = (degree: string, status: PersonEducation['status'] = 'confirmed'): PersonEducation => ({
  school: '某校',
  degree,
  status,
  source: 'resume',
})

const constraintMd = (row: string): string => `# 岗位

## 岗位门槛

| 维度 | 值 | 来源 | 置信度 |
|------|-----|------|--------|
${row}
`

// ─── Parser：岗位门槛段 → JDConstraintEducationIR ─────────────────────────

test('Parser：明确集合（本科;硕士;博士）→ NORMALIZED，rawValues 保留原文', () => {
  const ir = parseJdConstraint(constraintMd('| education | 本科;硕士;博士 | 任职要求 1 | high |'))
  assert.deepEqual(ir.education, {
    rawValues: ['本科', '硕士', '博士'],
    normalizedDegrees: ['本科', '硕士', '博士'],
    normalizationStatus: 'NORMALIZED',
    confidence: 'high',
    source: '任职要求 1',
    matchMode: 'exact',
  })
})

test('Parser：及以上展开（硕士及以上 → [硕士;博士]），rawValues 保留「硕士及以上」原文', () => {
  const ir = parseJdConstraint(constraintMd('| education | 硕士及以上 | 任职要求 1 | high |'))
  assert.deepEqual(ir.education!.rawValues, ['硕士及以上'])
  assert.deepEqual(ir.education!.normalizedDegrees, ['硕士', '博士'])
  assert.equal(ir.education!.normalizationStatus, 'NORMALIZED')
})

test('Parser：无法归一化（应届/不限）→ NEEDS_CONFIRMATION（不猜）', () => {
  const a = parseJdConstraint(constraintMd('| education | 应届 | 任职要求 1 | high |'))
  assert.equal(a.education!.normalizationStatus, 'NEEDS_CONFIRMATION')
  assert.equal(a.education!.normalizedDegrees, undefined)
  const b = parseJdConstraint(constraintMd('| education | 不限 | 任职要求 1 | medium |'))
  assert.equal(b.education!.normalizationStatus, 'NEEDS_CONFIRMATION')
})

test('Parser：优先表述（硕士优先）→ v1 无偏好模型，不产出该维度（Matcher 视 NOT_DECLARED）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 硕士优先 | 任职要求 1 | medium |'))
  assert.equal(ir.education, undefined)
})

test('Parser：混合（本科以上，硕士优先）→ 只取硬性部分（本科;硕士;博士）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 本科以上；硕士优先 | 任职要求 1 | high |'))
  assert.deepEqual(ir.education!.normalizedDegrees, ['本科', '硕士', '博士'])
  assert.equal(ir.education!.normalizationStatus, 'NORMALIZED')
})

test('Parser：缺岗位门槛段 → 空 IR；行级非法维度跳过', () => {
  assert.deepEqual(parseJdConstraint('# 岗位\n\n## 分析摘要\n\n| a | b |'), {})
  const ir = parseJdConstraint(
    '# 岗位\n\n## 岗位门槛\n\n| 维度 | 值 | 来源 | 置信度 |\n|------|-----|------|--------|\n| education | 本科 | 任职要求 1 | high |\n| bogus | x | - | - |\n',
  )
  assert.equal(ir.education!.normalizedDegrees!.length, 1)
  assert.equal(ir.major, undefined)
})

// ─── Matcher：四态派生（契约 §8 九个 Golden Case） ────────────────────────

test('Case 1 Company-A：本科 confirmed + [本科;硕士;博士] → MATCHED', () => {
  const r = matchEducation([edu('本科')], parseJdConstraint(constraintMd('| education | 本科;硕士;博士 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'MATCHED')
  assert.deepEqual(r.evidence, { person: '本科', requirement: '本科、硕士、博士' })
})

test('Case 2 JD 未写学历 → NOT_DECLARED', () => {
  const r = matchEducation([edu('本科')], undefined)
  assert.equal(r.status, 'NOT_DECLARED')
})

test('Case 3 档案缺失 → NEEDS_CONFIRMATION（Unknown ≠ False）', () => {
  const r = matchEducation([], parseJdConstraint(constraintMd('| education | 本科;硕士 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NEEDS_CONFIRMATION')
})

test('Case 4 无法归一化（应届）→ NEEDS_CONFIRMATION', () => {
  const r = matchEducation([edu('本科')], parseJdConstraint(constraintMd('| education | 应届 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NEEDS_CONFIRMATION')
})

test('Case 5 低于要求：大专 vs [本科;硕士;博士] → NOT_MATCHED', () => {
  const r = matchEducation([edu('大专')], parseJdConstraint(constraintMd('| education | 本科;硕士;博士 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NOT_MATCHED')
})

test('Case 6 多学历：本科+硕士 confirmed → 取最高 MATCHED', () => {
  const r = matchEducation([edu('本科'), edu('硕士')], parseJdConstraint(constraintMd('| education | 硕士;博士 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'MATCHED')
})

test('Case 7 多学历含 pending：本科 confirmed + 博士 pending → 按本科算 NOT_MATCHED（pending 不参与）', () => {
  const r = matchEducation([edu('本科'), edu('博士', 'pending')], parseJdConstraint(constraintMd('| education | 硕士;博士 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NOT_MATCHED')
})

test('Case 8 归一化：本科 vs 硕士及以上（[硕士;博士]）→ NOT_MATCHED', () => {
  const r = matchEducation([edu('本科')], parseJdConstraint(constraintMd('| education | 硕士及以上 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NOT_MATCHED')
})

test('Case 9 偏好表述（硕士优先）→ 无 hard 维度 NOT_DECLARED', () => {
  const ir = parseJdConstraint(constraintMd('| education | 硕士优先 | 任职要求 1 | medium |'))
  const r = matchEducation([edu('本科')], ir.education)
  assert.equal(r.status, 'NOT_DECLARED')
})

test('档案 rejected → NEEDS_CONFIRMATION（否认 ≠ 低学历，不产生 NOT_MATCHED）', () => {
  const r = matchEducation([edu('博士', 'rejected')], parseJdConstraint(constraintMd('| education | 本科 | 任职要求 1 | high |')).education)
  assert.equal(r.status, 'NEEDS_CONFIRMATION')
})

// ─── matchMode（Freeze Review 补丁）：5 列模式语义 ─────────────────────────

test('matchMode=related（机械相关专业）→ NEEDS_CONFIRMATION（相关需映射，归一化不猜）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 机械相关专业 | 任职要求 2 | medium | related |'))
  assert.equal(ir.education!.matchMode, 'related')
  assert.equal(ir.education!.normalizationStatus, 'NEEDS_CONFIRMATION')
  assert.equal(ir.education!.normalizedDegrees, undefined)
  const r = matchEducation([edu('本科')], ir.education)
  assert.equal(r.status, 'NEEDS_CONFIRMATION')
})

test('matchMode=preferred（本科以上优先考虑）→ 无 hard 维度（NOT_DECLARED）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 本科以上学历优先考虑 | 任职要求 1 | medium | preferred |'))
  assert.equal(ir.education, undefined)
  const r = matchEducation([edu('本科')], ir.education)
  assert.equal(r.status, 'NOT_DECLARED')
})

test('matchMode=inferred（Agent 推断值）→ NEEDS_CONFIRMATION（推断非原文直述）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 本科 | 推测自公司岗位惯例 | medium | inferred |'))
  assert.equal(ir.education!.normalizationStatus, 'NEEDS_CONFIRMATION')
})

test('matchMode=exact 5 列正常归一化（4 列旧格式兼容：缺省 = exact）', () => {
  const ir = parseJdConstraint(constraintMd('| education | 硕士及以上 | 任职要求 1 | high | exact |'))
  assert.equal(ir.education!.matchMode, 'exact')
  assert.deepEqual(ir.education!.normalizedDegrees, ['硕士', '博士'])
  // 4 列旧格式（无模式列）→ 缺省 exact
  const old = parseJdConstraint(constraintMd('| education | 本科;硕士 | 任职要求 1 | high |'))
  assert.equal(old.education!.matchMode, 'exact')
  assert.deepEqual(old.education!.normalizedDegrees, ['本科', '硕士'])
})

// ─── Parser 扩展（主线 3：major/experience 维度解析） ───────────────────────

test('Parser：major related → fuzzy 标记；preferred → 不产出（偏好非门槛）', () => {
  const md5 = (row: string): string => `# 岗位

## 岗位门槛

| 维度 | 值 | 来源 | 置信度 | 模式 |
|------|-----|------|--------|------|
${row}
`
  const related = parseJdConstraint(md5('| major | 机械设计、流体机械等相关专业 | 任职要求 1 | medium | related |'))
  assert.deepEqual(related.major, {
    rawValues: ['机械设计、流体机械等相关专业'],
    fuzzy: true,
    confidence: 'medium',
    source: '任职要求 1',
  })
  const preferred = parseJdConstraint(md5('| major | 自动化相关专业优先 | 任职要求 1 | medium | preferred |'))
  assert.equal(preferred.major, undefined)
  const exact = parseJdConstraint(constraintMd('| major | 机械工程 | 任职要求 1 | high |'))
  assert.deepEqual(exact.major, { rawValues: ['机械工程'], confidence: 'high', source: '任职要求 1' })
})

test('Parser：experience 原文保留；preferred → 不产出；与 education 同表共析', () => {
  const md = `# 岗位

## 岗位门槛

| 维度 | 值 | 来源 | 置信度 | 模式 |
|------|-----|------|--------|------|
| education | 本科;硕士;博士 | 任职要求 1 | high | exact |
| experience | fresh | 任职要求 1 | high | exact |
| major | 相关专业 | 任职要求 1 | medium | preferred |
`
  const ir = parseJdConstraint(md)
  assert.deepEqual(ir.education!.normalizedDegrees, ['本科', '硕士', '博士']) // education 不再被其他维度早退阻断
  assert.deepEqual(ir.experience, { rawValue: 'fresh', confidence: 'high', source: '任职要求 1' })
  assert.equal(ir.major, undefined) // preferred 不产出
})

// ─── Matcher Policy v0.2：experience 应届 + 年限判定 ───────────────────────

function expRow(partial: Partial<import('../ir/schema.ts').PersonWorkExperience>): import('../ir/schema.ts').PersonWorkExperience {
  return { company: 'Company-A', status: 'confirmed', ...partial }
}

test('matchExperience：fresh 应届判定——毕业年 ≥ 当前年-1 → MATCHED（Policy 层，事实层只存 graduation_year）', () => {
  const c = { rawValue: 'fresh', confidence: 'high' as const, source: '任职要求 1' }
  const now = new Date('2026-08-08')
  const fresh = matchExperience([{ school: '某校', degree: '本科', graduationYear: 2026, status: 'confirmed', source: 'resume' }], undefined, c, now)
  assert.equal(fresh.status, 'MATCHED')
  const prev = matchExperience([{ school: '某校', degree: '本科', graduationYear: 2025, status: 'confirmed', source: 'resume' }], undefined, c, now)
  assert.equal(prev.status, 'MATCHED')
  const old = matchExperience([{ school: '某校', degree: '本科', graduationYear: 2023, status: 'confirmed', source: 'resume' }], undefined, c, now)
  assert.equal(old.status, 'NOT_MATCHED')
})

test('matchExperience：应届类无毕业年份 → NEEDS_CONFIRMATION（Unknown ≠ False）', () => {
  const now = new Date('2026-08-08')
  const c = { rawValue: 'fresh', confidence: 'high' as const, source: '任职要求 1' }
  const noYear = matchExperience([{ school: '某校', degree: '本科', status: 'confirmed', source: 'resume' }], undefined, c, now)
  assert.equal(noYear.status, 'NEEDS_CONFIRMATION')
  assert.equal(noYear.note, '画像未登记毕业年份——需确认')
  const noConstraint = matchExperience(undefined, undefined, undefined)
  assert.equal(noConstraint.status, 'NOT_DECLARED')
})

test('matchExperience：年限类——合并年限对比（低于下限 NOT_MATCHED / 满足 MATCHED / 超上限 NEEDS_CONFIRMATION）', () => {
  const now = new Date('2026-08-08')
  // 2023.07-2025.03 = 20 个月 = 1.7 年
  const rows = [expRow({ start: '2023.07', end: '2025.03' })]
  const below = matchExperience(undefined, rows, { rawValue: '3年以上经验', confidence: 'high', source: '任职要求 2' }, now)
  assert.equal(below.status, 'NOT_MATCHED')
  assert.equal(below.evidence.person, '1.7 年经验')
  const ok = matchExperience(undefined, rows, { rawValue: '1年以上经验', confidence: 'high', source: '任职要求 2' }, now)
  assert.equal(ok.status, 'MATCHED')
  const range = matchExperience(undefined, rows, { rawValue: '1-3年经验', confidence: 'high', source: '任职要求 2' }, now)
  assert.equal(range.status, 'MATCHED')
  const over = matchExperience(undefined, [expRow({ start: '2020.01', end: '2025.12' })], { rawValue: '1-3年经验', confidence: 'high', source: '任职要求 2' }, now)
  assert.equal(over.status, 'NEEDS_CONFIRMATION')
  assert.equal(over.note, '超出年限上限——需确认（超年限可能是薪资错配，不是资格不符）')
})

test('matchExperience：年限类缺件——无经历行 / 无起止 → NEEDS_CONFIRMATION（Unknown ≠ False）', () => {
  const now = new Date('2026-08-08')
  const c = { rawValue: '3年以上经验', confidence: 'high' as const, source: '任职要求 2' }
  assert.equal(matchExperience(undefined, undefined, c, now).status, 'NEEDS_CONFIRMATION')
  assert.equal(matchExperience(undefined, [], c, now).status, 'NEEDS_CONFIRMATION')
  // start 缺失行不参与；end 缺失 → 至今
  assert.equal(matchExperience(undefined, [expRow({ start: undefined, end: '2025.03' })], c, now).status, 'NEEDS_CONFIRMATION')
  const ongoing = matchExperience(undefined, [expRow({ start: '2023.07' })], c, now)
  assert.equal(ongoing.status, 'MATCHED') // 2023.07 → 2026.08 = 3.1 年
  assert.equal(ongoing.evidence.person, '3.1 年经验')
  // 非法表述 → 规则未定义不猜
  assert.equal(matchExperience(undefined, [expRow({ start: '2023.07', end: '2025.03' })], { rawValue: '具有机械行业背景', confidence: 'high', source: '任职要求 2' }, now).status, 'NEEDS_CONFIRMATION')
})

test('experienceYearsOf：区间并集——重叠行不重复计；pending/rejected 行不参与', () => {
  const now = new Date('2026-08-08')
  assert.equal(experienceYearsOf(undefined, now), null)
  const overlap = [
    expRow({ start: '2023.07', end: '2025.03' }),
    expRow({ start: '2024.01', end: '2024.06' }), // 完全包含
    expRow({ start: '2025.04', end: '2026.03' }), // 相接下一段（Gap 不计——行间空隙不补）
  ]
  // 20 + 11 = 31 个月
  assert.equal(experienceYearsOf(overlap, now), 31)
  const pendingOnly = [expRow({ status: 'pending', start: '2023.07', end: '2025.03' })]
  assert.equal(experienceYearsOf(pendingOnly, now), null)
})
