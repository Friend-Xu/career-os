import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseTargetMarkdown, scanTargets } from '../storage/target-watcher.ts'

/** 合成 fixture：与 workspace 真实实体零语义关联（target_syn/company_syn/person_syn/Company-A） */
const targetMd = `---
id: target_syn_00001
company_id: company_syn_00001
candidate_person: person_syn_00001
original_jd_id: jobs/2026-08-04-Company-A-Mechanical-Engineer
current_jd_path: targets/target_syn_00001/jd.md
created_at: 2026-08-06
context_status: company=ready|product=ready
research_scope_id: scope_syn_00001
research_scope_status: confirmed
---

# Target: Mechanical Engineer — Company-A

## Research Scope

role: 机械结构工程师

focus（AI 推导）:
- 产品机械设计
- 结构优化

exclude（默认）:
- 财务分析
- 市场营销
`

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-target-'))
  initWorkspace(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dir
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('parseTargetMarkdown：正常解析（frontmatter 映射 + focus/exclude/role/伴生文件列举）', () => {
  const { value, validation } = parseTargetMarkdown(targetMd, ['jd.md', 'requirement_matrix.md'])
  assert.equal(validation, undefined)
  assert.equal(value.id, 'target_syn_00001')
  assert.equal(value.companyId, 'company_syn_00001')
  assert.equal(value.candidatePerson, 'person_syn_00001')
  assert.equal(value.originalJdId, 'jobs/2026-08-04-Company-A-Mechanical-Engineer')
  assert.equal(value.currentJdPath, 'targets/target_syn_00001/jd.md')
  assert.equal(value.createdAt, '2026-08-06')
  assert.equal(value.contextStatus, 'company=ready|product=ready')
  assert.equal(value.researchScopeId, 'scope_syn_00001')
  assert.equal(value.researchScopeStatus, 'confirmed')
  assert.equal(value.role, '机械结构工程师')
  assert.deepEqual(value.focus, ['产品机械设计', '结构优化'])
  assert.deepEqual(value.exclude, ['财务分析', '市场营销'])
  assert.deepEqual(value.companionFiles, ['jd.md', 'requirement_matrix.md'])
})

test('parseTargetMarkdown：`-` 占位可选字段 → 缺省（不保留占位值）', () => {
  const md = targetMd.replace('original_jd_id: jobs/2026-08-04-Company-A-Mechanical-Engineer', 'original_jd_id: -')
  const { value } = parseTargetMarkdown(md, [])
  assert.equal(value.originalJdId, undefined)
})

test('parseTargetMarkdown：缺 id / company_id → invalid（error）', () => {
  const missingId = parseTargetMarkdown(targetMd.replace('id: target_syn_00001', 'id:'), [])
  assert.equal(missingId.validation?.status, 'invalid')
  assert.ok(missingId.validation?.issues.some((i) => i.path === 'id' && i.severity === 'error'))

  const missingCompany = parseTargetMarkdown(targetMd.replace('company_id: company_syn_00001', 'company_id:'), [])
  assert.equal(missingCompany.validation?.status, 'invalid')
  assert.ok(missingCompany.validation?.issues.some((i) => i.path === 'companyId' && i.severity === 'error'))
})

test('parseTargetMarkdown：research_scope_status 非法值 → degraded（warn，保留不猜）', () => {
  const { value, validation } = parseTargetMarkdown(
    targetMd.replace('research_scope_status: confirmed', 'research_scope_status: pending'),
    [],
  )
  assert.equal(validation?.status, 'degraded')
  assert.equal(value.researchScopeStatus, undefined)
  assert.ok(validation?.issues.some((i) => i.path === 'researchScopeStatus' && i.severity === 'warn'))
})

test('scanTargets：只收含 target.md 的目录 + 伴生文件确定性列举 + 排序稳定', () => {
  const dir = makeWorkspace({
    'targets/target_syn_00002/target.md': targetMd
      .replace('id: target_syn_00001', 'id: target_syn_00002')
      .replace('current_jd_path: targets/target_syn_00001/jd.md', 'current_jd_path: targets/target_syn_00002/jd.md'),
    'targets/target_syn_00002/jd.md': '# jd',
    'targets/target_syn_00002/product_context.md': '# product',
    'targets/target_syn_00001/target.md': targetMd,
    'targets/target_syn_00001/requirement_matrix.md': '# req',
    'targets/no_target_dir/notes.md': '# no target here',
  })
  try {
    const ws = initWorkspace(dir)
    const targets = scanTargets(ws)
    // 目录名排序稳定；no_target_dir 无 target.md → 跳过
    assert.deepEqual(targets.map((t) => t.record.id), ['target_syn_00001', 'target_syn_00002'])
    assert.equal(targets.length, 2)
    // 伴生文件按固定顺序（jd.md 在 product_context.md 前）
    assert.deepEqual(targets[0]!.record.companionFiles, ['requirement_matrix.md'])
    assert.deepEqual(targets[1]!.record.companionFiles, ['jd.md', 'product_context.md'])
    assert.equal(targets[0]!.sourceFile, 'targets/target_syn_00001/target.md')
  } finally {
    cleanup(dir)
  }
})

test('scanTargets：无 targets/ 目录 → 空数组（不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-target-empty-'))
  try {
    const ws = initWorkspace(dir)
    rmSync(join(dir, 'targets'), { recursive: true, force: true })
    assert.deepEqual(scanTargets(ws), [])
  } finally {
    cleanup(dir)
  }
})
