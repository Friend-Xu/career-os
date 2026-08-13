/**
 * Working Copy Registry 测试矩阵（ADR-023 P2.2）。
 * 验证：parse/serialize 往返、upsert revision 协商（push/conflict）、owner 登记校验（ADR-013/014）、
 * promote → ResumeDocument Candidate（bound 块锚主 claim / unbound 块 UNBOUND_BLOCK warning /
 * 未知段类型跳过 + invalid）、promoted 状态写回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies, upsertWorkingCopy, promoteToDocumentCandidate, parseWorkingCopyMarkdown, serializeWorkingCopy } from '../storage/working-copy-registry.ts'
import { scanResumes } from '../storage/resume-watcher.ts'
import type { WorkingCopy } from '../ir/resume.ts'

function setup(): { ws: Workspace; root: string; claimId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-wc-'))
  const ws = initWorkspace(root)
  // owner 登记校验（ADR-013/014）：upsert 前 owner 必须是已登记 person
  ws.write(
    'persons/person_001/manifest.md',
    `---
id: person_001
name: Person-A
status: active
created_at: 2026-08-08
---
`,
  )
  ws.write(
    'claims/claim_20260808_00001.md',
    `---
id: claim_20260808_00001
created_at: 2026-08-08
lifecycle: active
---
# 主导气密性工装设计，使装配泄漏率降至 0.5%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导气密性工装设计，使装配泄漏率降至 0.5% |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-08 |

## 证据来源

- evidence_20260808_00001
`,
  )
  ws.write(
    'evidence/evidence_20260808_00001.md',
    `---
id: evidence_20260808_00001
owner: person_001
lifecycle: active
type: independent_project
created_at: 2026-08-08
---
# Project-A 气密性工装

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 结构负责人 |
| contribution | 主导气密性工装设计 |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-08 |
| owner | person_001 |
| type | independent_project |

## 证据

### scope
- 气密性工装设计

### impact
- 装配泄漏率降至 0.5%
`,
  )
  return { ws, root, claimId: 'claim_20260808_00001' }
}

function sectionsInput(claimId: string) {
  return [
    {
      id: 'sec_1',
      title: '个人信息',
      blocks: [{ id: 'blk_1', text: '我 | 机械结构工程师 | 5年经验 | City-Z' }],
    },
    {
      id: 'sec_2',
      title: '工作经历',
      blocks: [
        { id: 'blk_2', text: '主导气密性工装设计，使装配泄漏率降至 0.5%', provenanceLinks: [claimId] },
        { id: 'blk_3', text: '负责产线日常维护（未资产化内容）' },
      ],
    },
  ]
}

test('parse/serialize 往返：sections/blocks/claims 标注/lifecycle 完整', () => {
  const wc: WorkingCopy = {
    id: 'wc_20260808_00001',
    owner: 'person_001',
    sections: sectionsInput('claim_20260808_00001'),
    status: 'active',
    revision: 3,
    updatedAt: '2026-08-08T10:00:00Z',
  }
  const parsed = parseWorkingCopyMarkdown(serializeWorkingCopy(wc), 'wc_20260808_00001.md')
  assert.equal(parsed.id, 'wc_20260808_00001')
  assert.equal(parsed.revision, 3)
  assert.equal(parsed.sections.length, 2)
  assert.equal(parsed.sections[1]!.title, '工作经历')
  assert.equal(parsed.sections[1]!.blocks.length, 2)
  assert.deepEqual(parsed.sections[1]!.blocks[0]!.provenanceLinks, ['claim_20260808_00001'])
  // 契约 ApplyTransaction §2：不制造第三种 undefined 态——unbound 块显式 []
  assert.deepEqual(parsed.sections[1]!.blocks[1]!.provenanceLinks, [], 'unbound 块显式空锚数组')
})

test('upsert：新建 → created + revision=1；push → revision+1', () => {
  const { ws } = setup()
  const created = upsertWorkingCopy(ws, { owner: 'person_001', sections: sectionsInput(''), revision: 0 })
  assert.equal(created.status, 'created')
  assert.equal(created.copy.revision, 1)
  assert.match(created.copy.id, /^wc_\d{8}_\d{5}$/)

  const pushed = upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', sections: sectionsInput(''), revision: 1 })
  assert.equal(pushed.status, 'ok')
  assert.equal(pushed.copy.revision, 2)
  assert.equal(scanWorkingCopies(ws).length, 1, '同 id 不重复创建')
})

test('identity 通道（M5.2 G6）：字段条目 round-trip + promote 不产生 bullet/UNBOUND_BLOCK', () => {
  const { ws } = setup()
  const created = upsertWorkingCopy(ws, {
    owner: 'person_001',
    sections: [
      {
        id: 'sec_1',
        title: '个人信息',
        blocks: [],
        identity: [
          { label: '姓名', body: 'Person-A' },
          { label: '目标职位', body: '机械结构工程师' },
          { label: '城市', body: 'City-Z' },
        ],
      },
    ],
    revision: 0,
  })
  const md = ws.read(`resumes/working-copies/${created.copy.id}.md`)
  assert.ok(md.includes('- 姓名 | Person-A（identity）'), '身份行带 identity 标记序列化')
  const parsed = parseWorkingCopyMarkdown(md, `${created.copy.id}.md`)
  assert.deepEqual(parsed.sections[0]!.identity, [
    { label: '姓名', body: 'Person-A' },
    { label: '目标职位', body: '机械结构工程师' },
    { label: '城市', body: 'City-Z' },
  ])
  assert.equal(parsed.sections[0]!.blocks.length, 0, 'identity 不进 claim 通道（blocks 空）')

  const doc = promoteToDocumentCandidate(ws, created.copy.id, new Date('2026-08-08T12:00:00Z'))
  const profile = doc.sections.find((s) => s.type === 'profile')
  assert.ok(profile)
  assert.equal(profile.bullets.length, 0)
  assert.deepEqual(profile.identity, parsed.sections[0]!.identity, 'promote 映射 ResumeSection.identity')
  assert.equal(doc.validation?.status, 'valid', '身份事实不产生 UNBOUND_BLOCK 警告')
})

test('upsert：owner 非登记人 → 拒绝（ADR-013/014 系统身份字段）', () => {
  const { ws } = setup()
  // 占位符/UI 本地 id 一律拒绝——错误值会导致简历归属断裂（A 的简历挂到 B）
  assert.throws(() => upsertWorkingCopy(ws, { owner: '1', sections: sectionsInput(''), revision: 0 }), /owner 非登记人：1/)
  assert.throws(() => upsertWorkingCopy(ws, { owner: 'person_999', sections: sectionsInput(''), revision: 0 }), /owner 非登记人：person_999/)
  assert.throws(() => upsertWorkingCopy(ws, { owner: '  ', sections: sectionsInput(''), revision: 0 }), /owner 缺失/)
  assert.equal(scanWorkingCopies(ws).length, 0, '非法 owner 不落盘')
})

test('upsert：revision 协商——engine > local → conflict（询问合并）', () => {
  const { ws } = setup()
  const created = upsertWorkingCopy(ws, { owner: 'person_001', sections: sectionsInput(''), revision: 0 })
  // 客户端基于 revision 1 提交，但引擎已到 2（另一通道写入）→ conflict
  upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', sections: sectionsInput(''), revision: 1 })
  const conflict = upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', sections: sectionsInput(''), revision: 1 })
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.copy.revision, 2, 'conflict 返回引擎当前副本')
})

test('promote：bound 块锚主 claim；unbound 块 UNBOUND_BLOCK warning——不阻止进入版本', () => {
  const { ws, claimId } = setup()
  const created = upsertWorkingCopy(ws, { owner: 'person_001', sections: sectionsInput(claimId), revision: 0 })
  const doc = promoteToDocumentCandidate(ws, created.copy.id, new Date('2026-08-08T11:00:00Z'))

  assert.equal(doc.status, 'draft')
  assert.equal(doc.lineage?.derivationType, 'user_edit')
  assert.match(doc.id, /^resume_\d{8}_\d{5}$/)
  assert.equal(doc.validation?.status, 'warning', 'unbound 块 → warning 不阻止')
  assert.ok(doc.validation?.issues.some((i) => i.code === 'UNBOUND_BLOCK'))
  assert.ok(doc.validation?.issues.some((i) => i.code === 'CLAIM_NOT_FOUND') === false, 'claim 存在不报缺失')

  const exp = doc.sections.find((s) => s.type === 'experience')
  assert.ok(exp)
  assert.equal(exp.bullets.length, 2, 'unbound 块也进入文档（warning 标注）')
  assert.equal(exp.bullets[0]!.claimId, claimId)
  assert.equal(exp.bullets[1]!.claimId, '', 'unbound 块 claimId 空')

  // documents/ 落盘 + wc 状态 promoted
  assert.ok(scanResumes(ws).some((r) => r.record.id === doc.id), 'documents/ 已登记')
  assert.equal(scanWorkingCopies(ws).find((w) => w.id === created.copy.id)?.status, 'promoted')
})

test('promote：主 claim 不存在 → CLAIM_NOT_FOUND invalid；未知段类型 → 跳过 + invalid', () => {
  const { ws } = setup()
  const created = upsertWorkingCopy(ws, {
    owner: 'person_001',
    sections: [
      { id: 'sec_1', title: '自定义段落', blocks: [{ id: 'blk_1', text: '不知道属于什么类型' }] },
      { id: 'sec_2', title: '工作经历', blocks: [{ id: 'blk_2', text: '幽灵 claim', provenanceLinks: ['claim_99999999_99999'] }] },
    ],
    revision: 0,
  })
  const doc = promoteToDocumentCandidate(ws, created.copy.id)
  assert.equal(doc.validation?.status, 'invalid')
  assert.ok(doc.validation?.issues.some((i) => i.code === 'UNKNOWN_SECTION'))
  assert.ok(doc.validation?.issues.some((i) => i.code === 'CLAIM_NOT_FOUND'))
  assert.equal(doc.sections.length, 1, '未知段类型段不进入文档')
})

test('promote：claim 证据未通过可信校验 → CLAIM_NOT_USABLE，不进版本（消费策略统一入口）', () => {
  const { ws, claimId } = setup()
  // 证据降为 raw（未确认）→ claim 不可消费
  ws.write(
    'evidence/evidence_20260808_00001.md',
    ws.read('evidence/evidence_20260808_00001.md').replace('| status | trusted |', '| status | raw |'),
  )
  const created = upsertWorkingCopy(ws, {
    owner: 'person_001',
    sections: [{ id: 'sec_1', title: '个人优势', blocks: [{ id: 'blk_1', text: '主导气密性工装设计', provenanceLinks: [claimId] }] }],
    revision: 0,
  })
  const doc = promoteToDocumentCandidate(ws, created.copy.id)
  assert.equal(doc.validation?.status, 'invalid', '不可消费 claim 丢内容 → invalid')
  assert.ok(doc.validation?.issues.some((i) => i.code === 'CLAIM_NOT_USABLE'))
  assert.equal(doc.sections[0]!.bullets.length, 0, '不可消费 claim 的块不进版本')
})

test('promote：全 bound + 全 unbound 的 validation 区分（valid vs warning）', () => {
  const { ws, claimId } = setup()
  const allBound = upsertWorkingCopy(ws, {
    owner: 'person_001',
    sections: [{ id: 'sec_1', title: '工作经历', blocks: [{ id: 'blk_1', text: '主导气密性工装设计', provenanceLinks: [claimId] }] }],
    revision: 0,
  })
  const docBound = promoteToDocumentCandidate(ws, allBound.copy.id)
  assert.equal(docBound.validation?.status, 'valid', '全 bound → valid')

  const allUnbound = upsertWorkingCopy(ws, {
    owner: 'person_001',
    sections: [{ id: 'sec_1', title: '工作经历', blocks: [{ id: 'blk_1', text: '自由文本' }] }],
    revision: 0,
  })
  const docUnbound = promoteToDocumentCandidate(ws, allUnbound.copy.id)
  assert.equal(docUnbound.validation?.status, 'warning', '全 unbound → warning（不阻止）')
})

test('Entry Contract v0.1：条目化段 round-trip + promote → ResumeSection.entries（头透传 + 文档还原）', () => {
  const { ws, root, claimId } = setup()
  const wc: WorkingCopy = {
    id: 'wc_20260813_00001',
    owner: 'person_001',
    sections: [
      {
        id: 'sec_1',
        title: '工作经历',
        blocks: [],
        entries: [
          {
            id: 'ent_1',
            title: 'Company-A',
            role: '机械工程师',
            period: '2023.07-2025.03',
            description: '非标自动化设备结构设计部门：负责产线设备与气密性工装',
            blocks: [
              { id: 'blk_1', text: '主导气密性工装设计，使装配泄漏率降至 0.5%', provenanceLinks: [claimId] },
              { id: 'blk_2', text: '负责产线日常维护' },
            ],
          },
        ],
      },
      {
        id: 'sec_2',
        title: '项目经验',
        blocks: [],
        entries: [{ id: 'ent_1', title: 'Project-X', blocks: [{ id: 'blk_1', text: '完成传动模块设计', provenanceLinks: [claimId] }] }],
      },
    ],
    status: 'active',
    revision: 1,
    updatedAt: '2026-08-13T10:00:00Z',
  }
  const md = serializeWorkingCopy(wc)
  assert.match(md, /- Company-A \| 机械工程师 \| 2023\.07-2025\.03 \| 非标自动化设备结构设计部门：负责产线设备与气密性工装（entry）/)
  const parsed = parseWorkingCopyMarkdown(md, 'wc.md')
  const exp = parsed.sections[0]!.entries![0]!
  assert.equal(exp.title, 'Company-A')
  assert.equal(exp.role, '机械工程师')
  assert.equal(exp.period, '2023.07-2025.03')
  assert.equal(exp.description, '非标自动化设备结构设计部门：负责产线设备与气密性工装', 'description 4 字段 round-trip')
  assert.equal(exp.blocks.length, 2)
  assert.deepEqual(exp.blocks[0]!.provenanceLinks, [claimId])
  assert.deepEqual(exp.blocks[1]!.provenanceLinks, [])
  const proj = parsed.sections[1]!.entries![0]!
  assert.equal(proj.title, 'Project-X')
  assert.equal(proj.role, undefined, 'role/period 可空 round-trip')
  assert.equal(proj.period, undefined)
  assert.equal(proj.description, undefined, '无描述不输出第 4 段（3 字段旧行向后兼容）')
  assert.equal(parsed.sections[1]!.blocks.length, 0)

  upsertWorkingCopy(ws, { id: wc.id, owner: 'person_001', sections: parsed.sections, revision: 1 }, new Date('2026-08-13T10:05:00Z'))
  const doc = promoteToDocumentCandidate(ws, wc.id, new Date('2026-08-13T10:06:00Z'))
  const expSec = doc.sections.find((s) => s.type === 'experience')!
  assert.equal(expSec.entries?.length, 1)
  const e = expSec.entries![0]!
  assert.equal(e.title, 'Company-A')
  assert.equal(e.period, '2023.07-2025.03')
  assert.equal(e.description, '非标自动化设备结构设计部门：负责产线设备与气密性工装', 'promote 透传 description')
  assert.equal(e.bullets.length, 2)
  assert.equal(e.bullets[0]!.claimId, claimId)
  assert.equal(e.bullets[1]!.claimId, '', 'unbound → UNBOUND_BLOCK warning 但进入版本')
  assert.ok(doc.validation?.issues.some((i) => i.code === 'UNBOUND_BLOCK'))

  const docMd = ws.read(`resumes/documents/${doc.id}.md`)
  assert.match(docMd, /- Company-A \| 机械工程师 \| 2023\.07-2025\.03 \| 非标自动化设备结构设计部门：负责产线设备与气密性工装（entry）/)
  const reParsed = scanResumes(ws).find((r) => r.record.id === doc.id)!.record
  const reEntry = reParsed.sections.find((s) => s.type === 'experience')!.entries![0]!
  assert.equal(reEntry.title, 'Company-A')
  assert.equal(reEntry.description, '非标自动化设备结构设计部门：负责产线设备与气密性工装', '文档层 round-trip')
  assert.equal(reEntry.bullets.length, 2)
  assert.equal(reEntry.bullets[0]!.claimId, claimId)
  const reProj = reParsed.sections.find((s) => s.type === 'projects')!.entries![0]!
  assert.equal(reProj.title, 'Project-X')
  assert.equal(reProj.bullets.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('显示名（name）：round-trip + upsert 保持/清除语义 + promote 继承', () => {
  const { ws, root } = setup()
  const created = upsertWorkingCopy(ws, { owner: 'person_001', name: ' Company-A 定制版 ', sections: sectionsInput(''), revision: 0 })
  assert.equal(created.copy.name, 'Company-A 定制版', '新建 trim')
  const md = ws.read(`resumes/working-copies/${created.copy.id}.md`)
  assert.match(md, /name: Company-A 定制版/)

  // undefined → 保持引擎当前值（旧调用方无感知）
  const kept = upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', sections: sectionsInput(''), revision: 1 })
  assert.equal(kept.copy.name, 'Company-A 定制版', 'undefined 保持')
  // '' → 清除
  const cleared = upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', name: '', sections: sectionsInput(''), revision: 2 })
  assert.equal(cleared.copy.name, undefined, '空串清除')
  assert.ok(!ws.read(`resumes/working-copies/${created.copy.id}.md`).includes('name:'))

  // 重命名 + promote 继承
  upsertWorkingCopy(ws, { id: created.copy.id, owner: 'person_001', name: '通用版', sections: sectionsInput(''), revision: 3 })
  const doc = promoteToDocumentCandidate(ws, created.copy.id, new Date('2026-08-13T12:30:00Z'))
  assert.equal(doc.name, '通用版', 'promote 继承显示名')
  assert.match(ws.read(`resumes/documents/${doc.id}.md`), /\| name \| 通用版 \|/)
  const reParsed = scanResumes(ws).find((r) => r.record.id === doc.id)!.record
  assert.equal(reParsed.name, '通用版', '文档 round-trip')
  rmSync(root, { recursive: true, force: true })
})
