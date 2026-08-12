/**
 * Working Copy Registry 测试矩阵（ADR-023 P2.2）。
 * 验证：parse/serialize 往返、upsert revision 协商（push/conflict）、
 * promote → ResumeDocument Candidate（bound 块锚主 claim / unbound 块 UNBOUND_BLOCK warning /
 * 未知段类型跳过 + invalid）、promoted 状态写回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies, upsertWorkingCopy, promoteToDocumentCandidate, parseWorkingCopyMarkdown, serializeWorkingCopy } from '../storage/working-copy-registry.ts'
import { scanResumes } from '../storage/resume-watcher.ts'
import type { WorkingCopy } from '../ir/resume.ts'

function setup(): { ws: Workspace; root: string; claimId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-wc-'))
  const ws = initWorkspace(root)
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
