/**
 * stage-artifact-registry：Stage Artifact 生命周期原语（契约 Career-Workflow-Contract-v0.2 §一）。
 *
 * 通用能力（artifact_type 参数化，不感知业务字段）：
 * - register：Proposal（Agent 写的暂存文件，无系统身份）→ 引擎确定性校验 → 分配 artifact_id
 *   + 权威 frontmatter（state: registered）。**Registration 是唯一产生系统身份的地方。**
 * - read / list / count：投影（只读已登记文件；暂存提案无身份、不出现在投影里）。
 * - resolve：registered → confirmed | rejected。同动作幂等成功 / 反动作 ALREADY_RESOLVED /
 *   终态不可逆（契约 §4.3）。
 *
 * 校验（§1.4，登记时一次性执行，单一真相源）：marker 段 / 依据非空 / 依据可解析且限定
 * person 事实域（facts/ 与 snapshot/current/）/ 归属声明与登记上下文一致。
 * evaluator（artifact-exists）只 count，不重复校验。
 *
 * 物理形态：{dir(personId)}/ 下提案暂存名 → 登记后重命名 {idPrefix}{YYYYMMDD}_{NNNNN}.md。
 * ID 生成复用 artifact-registry 的 nextArtifactId（防覆盖语义同源）。
 */
import type { Workspace } from './workspace.ts'
import type { StageArtifact, StageArtifactState } from '../ir/schema.ts'
import { nextArtifactId, splitFrontmatter } from './artifact-registry.ts'

export interface StageArtifactSpec {
  artifactType: string
  /** 目录模板（按 person 展开，如 (p) => `persons/${p}/directions`） */
  dir: (personId: string) => string
  idPrefix: string
  marker: RegExp
  /** 证据域（契约 v0.3 §一）：evidence_refs 引用路径必须匹配（相对 person 根，含 .md）。
   *  direction_candidate = facts/ + snapshot/current/；evaluation_candidate 增 directions/。 */
  evidenceRefPattern: RegExp
}

export interface RegisterStageArtifactParams {
  personId: string
  workflowId: string
  stageId: string
  /** dir 内的暂存文件名（本次 Stage Execution intake 内，§1.6） */
  proposalFile: string
}

export type RegisterStageArtifactResult =
  | { ok: true; artifact: StageArtifact }
  | {
      ok: false
      code:
        | 'PROPOSAL_NOT_FOUND'
        | 'MARKER_MISSING'
        | 'EVIDENCE_EMPTY'
        | 'EVIDENCE_UNRESOLVABLE'
        | 'EVIDENCE_OUT_OF_SCOPE'
        | 'OWNERSHIP_MISMATCH'
      reason: string
    }

export interface StageArtifactFilter {
  workflowId?: string
  stageId?: string
  state?: StageArtifactState
}

export type ResolveStageArtifactResult =
  | { ok: true; artifact: StageArtifact; unchanged: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_RESOLVED'; currentState?: StageArtifactState }

const ID_RE = (idPrefix: string) => new RegExp(`^${idPrefix}\\d{8}_\\d{5}$`)

// ─── frontmatter（引擎权威格式：标量 + YAML array，如 evidence_refs）─────────

/** 解析权威 frontmatter（引擎单方写读；标量 + 缩进 list 两种形态） */
function parseAuthoritative(md: string): { meta: Record<string, string | string[]>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && listKey) {
      ;(meta[listKey] as string[]).push(item[1])
      continue
    }
    listKey = null
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (value === '') {
      meta[key] = []
      listKey = key
    } else {
      meta[key] = value
    }
  }
  return { meta, body: md.slice(m[0].length) }
}

function serializeAuthoritative(meta: Record<string, string | string[]>, body: string): string {
  const lines: string[] = ['---']
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${item}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---', '', body)
  return lines.join('\n')
}

// ─── 提案解析（§2.1：## 方向主张 marker 段 + ## 事实依据 段）──────────────────

/** 从 body 提取「事实依据」段的引用路径（bullet 行 `- 路径：说明` 的路径部分） */
function extractEvidenceRefs(body: string): string[] {
  const section = body.match(/##\s*事实依据\s*\n([\s\S]*?)(?=\n##\s|$)/)
  if (!section) return []
  const refs: string[] = []
  for (const line of section[1].split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (!bullet) continue
    const ref = bullet[1].split(/[:：]/)[0].trim()
    if (ref) refs.push(ref)
  }
  return refs
}

/** marker 段后首个非空段落 = 主张摘要（UI 投影） */
function extractClaim(body: string, marker: RegExp): string | undefined {
  const m = body.match(marker)
  if (!m) return undefined
  for (const line of body.slice(m.index! + m[0].length).split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t
  }
  return undefined
}

// ─── 证据校验（§1.4 注册硬约束；v0.3 §一 证据域参数化；evaluator 不做第二套）────────

function validateEvidenceRefs(
  ws: Workspace,
  spec: StageArtifactSpec,
  personId: string,
  refs: string[],
): { ok: true } | { ok: false; code: 'EVIDENCE_UNRESOLVABLE' | 'EVIDENCE_OUT_OF_SCOPE'; reason: string } {
  for (const raw of refs) {
    const ref = raw.split('#')[0].trim()
    if (!ref) return { ok: false, code: 'EVIDENCE_UNRESOLVABLE', reason: `引用为空：${raw}` }
    if (ref.startsWith('/') || ref.startsWith('\\') || /^[A-Za-z]:/.test(ref) || ref.includes('..')) {
      return { ok: false, code: 'EVIDENCE_OUT_OF_SCOPE', reason: `引用越界（绝对路径/上级目录）：${raw}` }
    }
    if (!spec.evidenceRefPattern.test(ref)) {
      return { ok: false, code: 'EVIDENCE_OUT_OF_SCOPE', reason: `引用不在 ${spec.artifactType} 证据域（${spec.evidenceRefPattern}）：${raw}` }
    }
    if (!ws.exists(`persons/${personId}/${ref}`)) {
      return { ok: false, code: 'EVIDENCE_UNRESOLVABLE', reason: `引用不存在：persons/${personId}/${ref}` }
    }
  }
  return { ok: true }
}

// ─── 注册（Proposal → Registered Artifact，唯一身份产生点）────────────────────

export function registerStageArtifact(
  ws: Workspace,
  spec: StageArtifactSpec,
  params: RegisterStageArtifactParams,
  now: Date = new Date(),
): RegisterStageArtifactResult {
  const dir = spec.dir(params.personId)
  const rel = `${dir}/${params.proposalFile}`
  if (!ws.exists(rel)) return { ok: false, code: 'PROPOSAL_NOT_FOUND', reason: `提案文件不存在：${rel}` }
  const md = ws.read(rel)
  if (!spec.marker.test(md)) {
    return { ok: false, code: 'MARKER_MISSING', reason: `缺少必需段落（marker：${spec.marker}）` }
  }
  const { meta, body } = splitFrontmatter(md)
  if (meta.person_id !== params.personId || meta.workflow_id !== params.workflowId || meta.stage_id !== params.stageId) {
    return { ok: false, code: 'OWNERSHIP_MISMATCH', reason: '提案声明 person_id/workflow_id/stage_id 与登记上下文不符' }
  }
  const refs = extractEvidenceRefs(body)
  if (refs.length === 0) return { ok: false, code: 'EVIDENCE_EMPTY', reason: '缺少「事实依据」段或引用为空' }
  const ev = validateEvidenceRefs(ws, spec, params.personId, refs)
  if (!ev.ok) return { ok: false, code: ev.code, reason: ev.reason }

  const artifactId = nextArtifactId(
    ws,
    { type: spec.artifactType, dir, idPrefix: spec.idPrefix, marker: spec.marker, passthroughFields: [] },
    now,
  )
  const fm: Record<string, string | string[]> = {
    id: artifactId,
    created_at: now.toISOString().slice(0, 10),
    source_file: params.proposalFile,
    artifact_type: spec.artifactType,
    workflow_id: params.workflowId,
    stage_id: params.stageId,
    person_id: params.personId,
    state: 'registered',
    version: '1',
    registered_by: 'engine',
    evidence_refs: refs,
  }
  ws.write(`${dir}/${artifactId}.md`, serializeAuthoritative(fm, body))
  ws.delete(rel)
  return {
    ok: true,
    artifact: {
      artifact_type: spec.artifactType,
      artifact_id: artifactId,
      workflow_id: params.workflowId,
      stage_id: params.stageId,
      person_id: params.personId,
      state: 'registered',
      evidence_refs: refs,
      version: 1,
      registered_by: 'engine',
      source_file: params.proposalFile,
      created_at: fm.created_at as string,
      claim: extractClaim(body, spec.marker),
    },
  }
}

// ─── 投影（read / list / count；暂存提案无身份不出现）────────────────────────

export function readStageArtifact(
  ws: Workspace,
  spec: StageArtifactSpec,
  personId: string,
  artifactId: string,
): StageArtifact | null {
  if (!ID_RE(spec.idPrefix).test(artifactId)) return null
  const rel = `${spec.dir(personId)}/${artifactId}.md`
  if (!ws.exists(rel)) return null
  const { meta, body } = parseAuthoritative(ws.read(rel))
  const state = meta.state as string | undefined
  if (state !== 'registered' && state !== 'confirmed' && state !== 'rejected') return null
  return {
    artifact_type: meta.artifact_type as string,
    artifact_id: artifactId,
    workflow_id: meta.workflow_id as string,
    stage_id: meta.stage_id as string,
    person_id: meta.person_id as string,
    state,
    evidence_refs: (meta.evidence_refs as string[]) ?? [],
    version: parseInt(meta.version as string, 10),
    registered_by: 'engine',
    ...(meta.confirmed_at ? { confirmed_at: meta.confirmed_at as string } : {}),
    ...(meta.confirmed_by ? { confirmed_by: meta.confirmed_by as 'user' } : {}),
    source_file: meta.source_file as string | undefined,
    created_at: meta.created_at as string | undefined,
    claim: extractClaim(body, spec.marker),
  }
}

export function listStageArtifacts(
  ws: Workspace,
  spec: StageArtifactSpec,
  personId: string,
  filter: StageArtifactFilter = {},
): StageArtifact[] {
  const dir = spec.dir(personId)
  let files: string[]
  try {
    files = ws.listMarkdown(dir)
  } catch {
    return []
  }
  const re = ID_RE(spec.idPrefix)
  return files
    .sort()
    .filter((f) => re.test(f.replace(/\.md$/, '')))
    .map((f) => readStageArtifact(ws, spec, personId, f.replace(/\.md$/, '')))
    .filter((a): a is StageArtifact => a !== null)
    .filter(
      (a) =>
        (!filter.workflowId || a.workflow_id === filter.workflowId) &&
        (!filter.stageId || a.stage_id === filter.stageId) &&
        (!filter.state || a.state === filter.state),
    )
}

export function countStageArtifacts(
  ws: Workspace,
  spec: StageArtifactSpec,
  personId: string,
  filter: StageArtifactFilter = {},
): number {
  return listStageArtifacts(ws, spec, personId, filter).length
}

// ─── 裁决（§4.3：同动作幂等成功 / 反动作 ALREADY_RESOLVED / 终态不可逆）──────

export function resolveStageArtifact(
  ws: Workspace,
  spec: StageArtifactSpec,
  personId: string,
  artifactId: string,
  action: 'confirm' | 'reject',
  now: Date = new Date(),
): ResolveStageArtifactResult {
  const artifact = readStageArtifact(ws, spec, personId, artifactId)
  if (!artifact) return { ok: false, code: 'NOT_FOUND' }
  const next: StageArtifactState = action === 'confirm' ? 'confirmed' : 'rejected'
  if (artifact.state === next) return { ok: true, artifact, unchanged: true }
  if (artifact.state !== 'registered') return { ok: false, code: 'ALREADY_RESOLVED', currentState: artifact.state }

  const rel = `${spec.dir(personId)}/${artifactId}.md`
  const { meta, body } = parseAuthoritative(ws.read(rel))
  meta.state = next
  meta.confirmed_at = now.toISOString()
  meta.confirmed_by = 'user'
  ws.write(rel, serializeAuthoritative(meta, body))
  return { ok: true, artifact: readStageArtifact(ws, spec, personId, artifactId)!, unchanged: false }
}

// ─── 批量登记（§1.5：拒绝明细结构化返回，调用方接 error.engine 可见性）────────

export interface StageArtifactBatchParams {
  personId: string
  workflowId: string
  stageId: string
  /** 本次 intake 内暂存文件名清单（§1.6：intake 边界由调用方持有，本函数不自行扫描目录） */
  proposalFiles: string[]
}

export interface StageArtifactRejection {
  proposalFile: string
  code: Extract<RegisterStageArtifactResult, { ok: false }>['code']
  reason: string
}

export interface StageArtifactBatchResult {
  registered: StageArtifact[]
  rejected: StageArtifactRejection[]
}

/** 逐个登记：成功 → registered；失败 → 提案保留原样 + 拒绝明细（不中断后续文件） */
export function registerStageArtifactBatch(
  ws: Workspace,
  spec: StageArtifactSpec,
  params: StageArtifactBatchParams,
  now: Date = new Date(),
): StageArtifactBatchResult {
  const registered: StageArtifact[] = []
  const rejected: StageArtifactRejection[] = []
  for (const proposalFile of params.proposalFiles) {
    const res = registerStageArtifact(
      ws,
      spec,
      { personId: params.personId, workflowId: params.workflowId, stageId: params.stageId, proposalFile },
      now,
    )
    if (res.ok) registered.push(res.artifact)
    else rejected.push({ proposalFile, code: res.code, reason: res.reason })
  }
  return { registered, rejected }
}
