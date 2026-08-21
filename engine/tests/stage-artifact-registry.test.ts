import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  registerStageArtifact,
  readStageArtifact,
  listStageArtifacts,
  countStageArtifacts,
  resolveStageArtifact,
  registerStageArtifactBatch,
  type StageArtifactSpec,
} from '../storage/stage-artifact-registry.ts'
import { formatRegistrationRejectionMessage } from '../transport/websocket.ts'
import { createPersonSession } from '../storage/person-watcher.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-sar-test-${Date.now()}-${wsSeq}`)
}

const DIRECTION_SPEC: StageArtifactSpec = {
  artifactType: 'direction_candidate',
  dir: (p) => `persons/${p}/directions`,
  idPrefix: 'direction_',
  marker: /##\s*方向主张/,
  /** 证据域（v0.3 §一）：方向候选依据 = 个人事实 */
  evidenceRefPattern: /^(facts|snapshot\/current)\/[^/\\]+\.md$/,
}

/** evaluation_candidate 证据域（v0.3 §一）：评估依据 = 已确认方向 + 个人事实 */
const EVALUATION_SPEC: StageArtifactSpec = {
  artifactType: 'evaluation_candidate',
  dir: (p) => `persons/${p}/evaluations`,
  idPrefix: 'evaluation_',
  marker: /##\s*方向评估/,
  evidenceRefPattern: /^(facts|snapshot\/current|directions)\/[^/\\]+\.md$/,
}

const NOW = new Date('2026-08-21T00:00:00Z')
const WORKFLOW_ID = 'workflow_20260821_00001'
const STAGE_ID = 'direction_exploration'

function makePerson(ws: Workspace): string {
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  return personId
}

/** 写 person 事实域文件（evidence_refs 校验的存在性依据；合成 fixture） */
function seedFacts(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/facts/education.md`, '# 教育\n\n| 学校 | 专业 |\n|------|------|\n| University-A | 机械工程 |\n')
  ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n')
}

/** 合法提案文件内容（§2.1 模板：frontmatter 声明 + marker 段 + 事实依据段） */
function proposalMd(personId: string, workflowId = WORKFLOW_ID, stageId = STAGE_ID): string {
  return [
    '---',
    `person_id: ${personId}`,
    `workflow_id: ${workflowId}`,
    `stage_id: ${stageId}`,
    '---',
    '',
    '## 方向主张',
    '',
    '新能源结构件方向值得重点考虑。',
    '',
    '## 事实依据',
    '',
    '- facts/education.md：机械工程本科（支撑：专业对口）',
    '- snapshot/current/skill_inventory.md：结构设计经验（支撑：经验延续）',
    '',
  ].join('\n')
}

function writeProposal(ws: Workspace, personId: string, fileName: string, md: string): void {
  ws.write(`persons/${personId}/directions/${fileName}`, md)
}

// ─── register：成功链（Proposal → Registered Artifact）─────────────────────

test('register 成功：分配系统 ID + 权威 frontmatter + 暂存文件消失 + 全字段投影', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-新能源结构件方向.md', proposalMd(pid))

  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-新能源结构件方向.md' }, NOW)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.artifact.artifact_id, 'direction_20260821_00001')
  assert.equal(res.artifact.state, 'registered')
  assert.equal(res.artifact.registered_by, 'engine')
  assert.equal(res.artifact.version, 1)
  assert.equal(res.artifact.workflow_id, WORKFLOW_ID)
  assert.equal(res.artifact.stage_id, STAGE_ID)
  assert.equal(res.artifact.person_id, pid)
  assert.deepEqual(res.artifact.evidence_refs, ['facts/education.md', 'snapshot/current/skill_inventory.md'])
  assert.equal(res.artifact.claim, '新能源结构件方向值得重点考虑。')
  assert.equal(res.artifact.source_file, '20260821-新能源结构件方向.md')
  // 暂存文件已被系统身份文件替换
  assert.equal(ws.exists(`persons/${pid}/directions/20260821-新能源结构件方向.md`), false)
  assert.equal(ws.exists(`persons/${pid}/directions/direction_20260821_00001.md`), true)
})

test('register 落盘可回读：read 与 register 投影一致（权威 frontmatter 含 YAML array）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向甲.md' }, NOW)
  assert.equal(res.ok, true)
  if (!res.ok) return

  const artifact = readStageArtifact(ws, DIRECTION_SPEC, pid, res.artifact.artifact_id)!
  assert.equal(artifact.artifact_id, res.artifact.artifact_id)
  assert.equal(artifact.state, 'registered')
  assert.deepEqual(artifact.evidence_refs, res.artifact.evidence_refs)
  assert.equal(artifact.claim, res.artifact.claim)
  assert.equal(artifact.source_file, '20260821-方向甲.md')
  // 落盘文件包含 YAML array 形态
  const md = ws.read(`persons/${pid}/directions/${res.artifact.artifact_id}.md`)
  assert.match(md, /evidence_refs:\n  - facts\/education\.md/)
})

test('register 同日两次：ID 序号递增（不覆盖）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid))
  writeProposal(ws, pid, '20260821-方向乙.md', proposalMd(pid))
  const a = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向甲.md' }, NOW)
  const b = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向乙.md' }, NOW)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (!a.ok || !b.ok) return
  assert.equal(a.artifact.artifact_id, 'direction_20260821_00001')
  assert.equal(b.artifact.artifact_id, 'direction_20260821_00002')
  assert.equal(ws.exists(`persons/${pid}/directions/direction_20260821_00001.md`), true)
  assert.equal(ws.exists(`persons/${pid}/directions/direction_20260821_00002.md`), true)
})

// ─── register：确定性校验（§1.4，Proposal ≠ Registered Artifact）───────────

test('register 拒绝：提案文件不存在 → PROPOSAL_NOT_FOUND', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-不存在.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'PROPOSAL_NOT_FOUND')
})

test('register 拒绝：缺 marker 段 → MARKER_MISSING（提案保留原样）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  writeProposal(ws, pid, '20260821-无主张.md', [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${WORKFLOW_ID}`,
    `stage_id: ${STAGE_ID}`,
    '---',
    '',
    '## 其他段',
    '',
    '没有方向主张段。',
    '',
  ].join('\n'))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-无主张.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'MARKER_MISSING')
  assert.equal(ws.exists(`persons/${pid}/directions/20260821-无主张.md`), true) // 不删除、不赋予身份
})

test('register 拒绝：无事实依据段 → EVIDENCE_EMPTY', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  writeProposal(ws, pid, '20260821-无依据.md', [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${WORKFLOW_ID}`,
    `stage_id: ${STAGE_ID}`,
    '---',
    '',
    '## 方向主张',
    '',
    '裸断言方向，没有依据。',
    '',
  ].join('\n'))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-无依据.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EVIDENCE_EMPTY')
})

test('register 拒绝：引用不存在 → EVIDENCE_UNRESOLVABLE', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  writeProposal(ws, pid, '20260821-悬空引用.md', [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${WORKFLOW_ID}`,
    `stage_id: ${STAGE_ID}`,
    '---',
    '',
    '## 方向主张',
    '',
    '方向乙。',
    '',
    '## 事实依据',
    '',
    '- facts/foo.md：虚构依据',
    '',
  ].join('\n'))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-悬空引用.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EVIDENCE_UNRESOLVABLE')
  assert.match(res.reason, /facts\/foo\.md/)
})

test('register 拒绝：引用越界（上级目录/绝对路径/事实域外）→ EVIDENCE_OUT_OF_SCOPE', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  const cases = ['../decisions/x.md', '/abs/path.md', 'decisions/x.md', 'facts/../education.md', 'other/education.md']
  for (const [i, ref] of cases.entries()) {
    const file = `20260821-越界${i}.md`
    writeProposal(ws, pid, file, [
      '---',
      `person_id: ${pid}`,
      `workflow_id: ${WORKFLOW_ID}`,
      `stage_id: ${STAGE_ID}`,
      '---',
      '',
      '## 方向主张',
      '',
      '方向。',
      '',
      '## 事实依据',
      '',
      `- ${ref}：依据`,
      '',
    ].join('\n'))
    const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: file }, NOW)
    assert.equal(res.ok, false, `ref=${ref} 应被拒绝`)
    if (res.ok) continue
    assert.equal(res.code, 'EVIDENCE_OUT_OF_SCOPE', `ref=${ref}`)
  }
})

test('register 拒绝：归属声明与登记上下文不符 → OWNERSHIP_MISMATCH', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-错归属.md', proposalMd(pid, 'workflow_20260820_99999', STAGE_ID))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-错归属.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'OWNERSHIP_MISMATCH')
})

// ─── 投影（list/count：只读已登记；暂存提案无身份不出现）───────────────────

test('list/count：过滤 workflow/stage/state；暂存提案不出现；空目录返回空', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  // 空目录：list 不抛错
  assert.deepEqual(listStageArtifacts(ws, DIRECTION_SPEC, pid), [])
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid), 0)

  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid))
  writeProposal(ws, pid, '20260821-方向乙.md', proposalMd(pid))
  // 另一 workflow 的已登记 artifact（过滤用）
  writeProposal(ws, pid, '20260821-方向丙.md', proposalMd(pid, 'workflow_20260821_00002', STAGE_ID))
  const a = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向甲.md' }, NOW)
  const b = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向乙.md' }, NOW)
  const c = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: 'workflow_20260821_00002', stageId: STAGE_ID, proposalFile: '20260821-方向丙.md' }, NOW)
  assert.equal(a.ok && b.ok && c.ok, true)
  if (!(a.ok && b.ok && c.ok)) return

  // 暂存文件（方向甲/乙/丙）都已被替换；再放一个新暂存 → 不出现在投影
  writeProposal(ws, pid, '20260821-未登记.md', proposalMd(pid))

  const all = listStageArtifacts(ws, DIRECTION_SPEC, pid)
  assert.equal(all.length, 3)
  assert.ok(all.every((x) => x.state === 'registered'))
  assert.ok(all.every((x) => x.artifact_id.startsWith('direction_')))

  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: WORKFLOW_ID }), 2)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: 'workflow_20260821_00002' }), 1)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: 'workflow_20260821_00003' }), 0)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { stageId: STAGE_ID }), 3)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { state: 'registered' }), 3)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { state: 'confirmed' }), 0)
})

test('read：非法/不存在 ID 返回 null', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  assert.equal(readStageArtifact(ws, DIRECTION_SPEC, pid, 'direction_20260821_00001'), null)
  assert.equal(readStageArtifact(ws, DIRECTION_SPEC, pid, '非法id'), null)
  assert.equal(readStageArtifact(ws, DIRECTION_SPEC, pid, '../evil'), null)
})

// ─── resolve（§4.3：同动作幂等成功 / 反动作 ALREADY_RESOLVED / 终态不可逆）───

function registerOne(ws: Workspace, pid: string) {
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向甲.md' }, NOW)
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('fixture 注册失败')
  return res.artifact.artifact_id
}

test('resolve：registered → confirmed（落盘 state/confirmed_at/confirmed_by）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const id = registerOne(ws, pid)
  const res = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'confirm', NOW)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.unchanged, false)
  assert.equal(res.artifact.state, 'confirmed')
  assert.equal(res.artifact.confirmed_by, 'user')
  assert.ok(res.artifact.confirmed_at)
  const reloaded = readStageArtifact(ws, DIRECTION_SPEC, pid, id)!
  assert.equal(reloaded.state, 'confirmed')
})

test('resolve：reject 终态 + 同动作幂等成功（state 不变）+ 反动作 ALREADY_RESOLVED', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const id = registerOne(ws, pid)

  const first = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'reject', NOW)
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.artifact.state, 'rejected')

  // 同动作（reject + reject）：幂等成功
  const same = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'reject', NOW)
  assert.equal(same.ok, true)
  if (!same.ok) return
  assert.equal(same.unchanged, true)
  assert.equal(same.artifact.state, 'rejected')

  // 反动作（reject 后 confirm）：拒绝，终态不可逆
  const reverse = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'confirm', NOW)
  assert.equal(reverse.ok, false)
  if (reverse.ok) return
  assert.equal(reverse.code, 'ALREADY_RESOLVED')
  assert.equal(reverse.currentState, 'rejected')
  // 落盘未变
  assert.equal(readStageArtifact(ws, DIRECTION_SPEC, pid, id)!.state, 'rejected')
})

test('resolve：confirmed + reject → ALREADY_RESOLVED；confirm + confirm → 幂等', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const id = registerOne(ws, pid)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'confirm', NOW).ok, true)
  const reverse = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'reject', NOW)
  assert.equal(reverse.ok, false)
  if (reverse.ok) return
  assert.equal(reverse.code, 'ALREADY_RESOLVED')
  assert.equal(reverse.currentState, 'confirmed')
  const same = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'confirm', NOW)
  assert.equal(same.ok, true)
  if (!same.ok) return
  assert.equal(same.unchanged, true)
})

test('resolve：artifact 不存在 → NOT_FOUND', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const res = resolveStageArtifact(ws, DIRECTION_SPEC, pid, 'direction_20260821_00009', 'confirm', NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'NOT_FOUND')
})

test('resolve 后 count 按 state 过滤：confirmed/rejected 计数正确', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  for (const [i, name] of ['20260821-方向甲.md', '20260821-方向乙.md', '20260821-方向丙.md'].entries()) {
    writeProposal(ws, pid, name, proposalMd(pid))
    const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: name }, NOW)
    assert.equal(res.ok, true)
    if (res.ok) {
      if (i === 0) resolveStageArtifact(ws, DIRECTION_SPEC, pid, res.artifact.artifact_id, 'confirm', NOW)
      if (i === 1) resolveStageArtifact(ws, DIRECTION_SPEC, pid, res.artifact.artifact_id, 'reject', NOW)
    }
  }
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: WORKFLOW_ID, state: 'confirmed' }), 1)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: WORKFLOW_ID, state: 'rejected' }), 1)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: WORKFLOW_ID, state: 'registered' }), 1)
})

// ─── 批量登记（§1.5：拒绝明细结构化返回，不中断后续文件）─────────────────────

test('batch：全部成功 → registered 全量，rejected 为空', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid))
  writeProposal(ws, pid, '20260821-方向乙.md', proposalMd(pid))
  const res = registerStageArtifactBatch(ws, DIRECTION_SPEC, {
    personId: pid,
    workflowId: WORKFLOW_ID,
    stageId: STAGE_ID,
    proposalFiles: ['20260821-方向甲.md', '20260821-方向乙.md'],
  }, NOW)
  assert.equal(res.registered.length, 2)
  assert.equal(res.rejected.length, 0)
})

test('batch：部分失败 → 成功的登记、失败的原样保留 + 拒绝明细（含 code/reason）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-方向甲.md', proposalMd(pid)) // 合法
  writeProposal(ws, pid, '20260821-无依据.md', proposalMd(pid).replace('## 事实依据\n\n- facts/education.md：机械工程本科（支撑：专业对口）\n- snapshot/current/skill_inventory.md：结构设计经验（支撑：经验延续）', '## 其他\n')) // 无依据段
  const res = registerStageArtifactBatch(ws, DIRECTION_SPEC, {
    personId: pid,
    workflowId: WORKFLOW_ID,
    stageId: STAGE_ID,
    proposalFiles: ['20260821-方向甲.md', '20260821-无依据.md'],
  }, NOW)
  assert.equal(res.registered.length, 1)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0]!.proposalFile, '20260821-无依据.md')
  assert.equal(res.rejected[0]!.code, 'EVIDENCE_EMPTY')
  assert.ok(res.rejected[0]!.reason.length > 0)
  // 失败提案保留原样（无系统身份）
  assert.equal(ws.exists(`persons/${pid}/directions/20260821-无依据.md`), true)
  assert.equal(ws.exists(`persons/${pid}/directions/direction_20260821_00001.md`), true)
})

test('batch：全部失败 → registered 空、rejected 全量（不中断）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  writeProposal(ws, pid, '20260821-无主张.md', proposalMd(pid).replace('## 方向主张', '## 分析'))
  writeProposal(ws, pid, '20260821-悬空引用.md', proposalMd(pid).replace('facts/education.md', 'facts/foo.md'))
  const res = registerStageArtifactBatch(ws, DIRECTION_SPEC, {
    personId: pid,
    workflowId: WORKFLOW_ID,
    stageId: STAGE_ID,
    proposalFiles: ['20260821-无主张.md', '20260821-悬空引用.md'],
  }, NOW)
  assert.equal(res.registered.length, 0)
  assert.equal(res.rejected.length, 2)
  assert.deepEqual(res.rejected.map((r) => r.code).sort(), ['EVIDENCE_UNRESOLVABLE', 'MARKER_MISSING'])
})

// ─── 拒绝可见性消息（§1.5：error.engine message 格式化，纯函数）──────────────

test('formatRegistrationRejectionMessage：含 artifactType/文件名/码/原因', () => {
  const msg = formatRegistrationRejectionMessage('direction_candidate', [
    { proposalFile: '20260821-无依据.md', code: 'EVIDENCE_EMPTY', reason: '缺少「事实依据」段或引用为空' },
  ])
  assert.match(msg, /direction_candidate/)
  assert.match(msg, /20260821-无依据\.md/)
  assert.match(msg, /EVIDENCE_EMPTY/)
  assert.match(msg, /事实依据/)
})

// ─── v0.3 §一：证据域参数化（evaluation_candidate 证据域 = facts + snapshot + directions）──

/** 写一个已登记方向文件（evaluation 证据域引用对象；directions/ 下系统 ID 命名） */
function seedDirectionFile(ws: Workspace, personId: string, directionId = 'direction_20260821_00001'): void {
  ws.write(`persons/${personId}/directions/${directionId}.md`, [
    '---',
    `id: ${directionId}`,
    'artifact_type: direction_candidate',
    `person_id: ${personId}`,
    'state: confirmed',
    '---',
    '',
    '## 方向主张',
    '',
    '方向甲值得考虑。',
    '',
  ].join('\n'))
}

/** evaluation 提案（marker = 方向评估；evidenceRef 决定引用域） */
function evaluationProposalMd(personId: string, evidenceRef: string): string {
  return [
    '---',
    `person_id: ${personId}`,
    `workflow_id: ${WORKFLOW_ID}`,
    'stage_id: direction_evaluation',
    '---',
    '',
    '## 方向评估',
    '',
    '方向甲评估：匹配度高。',
    '',
    '## 事实依据',
    '',
    `- ${evidenceRef}：评估依据`,
    '',
  ].join('\n')
}

test('证据域参数化：evaluation_candidate 允许引用 directions/（已确认方向）→ 登记成功', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  seedDirectionFile(ws, pid)
  ws.write(`persons/${pid}/evaluations/20260821-评估甲.md`, evaluationProposalMd(pid, 'directions/direction_20260821_00001.md'))

  const res = registerStageArtifact(ws, EVALUATION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: 'direction_evaluation', proposalFile: '20260821-评估甲.md' }, NOW)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.artifact.evidence_refs, ['directions/direction_20260821_00001.md'])
  assert.match(res.artifact.artifact_id, /^evaluation_\d{8}_\d{5}$/)
})

test('证据域参数化：evaluation_candidate 引用 decisions/ → EVIDENCE_OUT_OF_SCOPE（域外）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  ws.write(`persons/${pid}/evaluations/20260821-坏评估.md`, evaluationProposalMd(pid, 'decisions/decision_20260821_00001.md'))

  const res = registerStageArtifact(ws, EVALUATION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: 'direction_evaluation', proposalFile: '20260821-坏评估.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EVIDENCE_OUT_OF_SCOPE')
})

test('证据域参数化：evaluation_candidate 引用 directions/ 不存在 → EVIDENCE_UNRESOLVABLE', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  ws.write(`persons/${pid}/evaluations/20260821-悬空.md`, evaluationProposalMd(pid, 'directions/direction_99999999_99999.md'))

  const res = registerStageArtifact(ws, EVALUATION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: 'direction_evaluation', proposalFile: '20260821-悬空.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EVIDENCE_UNRESOLVABLE')
})

test('证据域参数化：direction_candidate 仍拒绝 directions/（证据域不变）→ EVIDENCE_OUT_OF_SCOPE', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedFacts(ws, pid)
  seedDirectionFile(ws, pid)
  const md = proposalMd(pid).replace('- facts/education.md：机械工程本科（支撑：专业对口）', '- directions/direction_20260821_00001.md：方向依据')
  writeProposal(ws, pid, '20260821-方向越域.md', md)

  const res = registerStageArtifact(ws, DIRECTION_SPEC, { personId: pid, workflowId: WORKFLOW_ID, stageId: STAGE_ID, proposalFile: '20260821-方向越域.md' }, NOW)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EVIDENCE_OUT_OF_SCOPE')
})
