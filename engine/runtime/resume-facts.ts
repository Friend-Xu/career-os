/**
 * resume-facts：简历事实提取与候选生成（P0-1 确定性通道）。
 *
 * 链路（Engine Registration 负责事实——Agent 退出候选生产）：
 *   extraction/resume-00X.md（提取文本）
 *     → extractResumeFactsDirect（generateObject + schema，一次性结构化提取）
 *     → resume-00X.facts.json（Resume Facts Artifact，引擎单方写）
 *     → resumeFactsToCandidates（确定性映射：Facts → Candidate 输入）
 *     → appendCandidates（Candidate Inbox；用户确认由既有 resolveCandidate → Registration
 *        → projectPersonSnapshots → completePersonInit 链闭口）
 *
 * 契约复用（不发明新格式）：candidate payload = 既有通用载荷列语法——
 *   教育 `学校=…；专业=…；学历=…；起=…；止=…`；经历 `公司=…；岗位=…；起=…；止=…`（在职止=至今）；
 *   技能 `技能=…；级别=…；场景=…`；约束 `意向岗位=…；优先级=…；薪资=…；城市=…；现居=…`；
 *   项目/比赛/空窗类经历与兴趣类候选不附加第四段（与前端采集协议一致）。
 *   解析器：person-watcher parseEducationPayload/parseExperiencePayload、
 *   person-snapshot-projection parseSkillPayload/parseConstraintPayload——同源。
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { createStructuredExtractor } from '../agent/capability/structured-extractor.ts'
import type { Logger } from '../logger.ts'
import { appendCandidates, listCandidates, readManifestInitState, setManifestInitState } from '../storage/person-watcher.ts'
import type { Workspace } from '../storage/workspace.ts'

// ─── Resume Facts 契约（generateObject 的 schema = 类型 = 校验规则，三者同源）──────────

export interface ResumeFacts {
  education: ResumeEducation[]
  experience: ResumeExperience[]
  skills: ResumeSkill[]
  constraints: ResumeConstraintItem[]
  interests: string[]
}

export interface ResumeEducation {
  school: string
  major?: string
  /** 归一化枚举（person-education-registration-contract §6：高中/大专/本科/硕士/博士） */
  degree?: string
  startYear?: number
  endYear?: number
}

export interface ResumeExperience {
  company?: string
  role?: string
  type: 'job' | 'project' | 'competition' | 'gap'
  start?: string
  end?: string
  summary?: string
}

export interface ResumeSkill {
  skill: string
  /** 归一化枚举：精通/熟练/胜任/掌握/入门（原文映射规则见 EXTRACT_SYSTEM） */
  level?: string
  context?: string
}

export interface ResumeConstraintItem {
  jobRole?: string
  priority?: 'high' | 'medium' | 'low'
  salary?: string
  city?: string
  location?: string
  note?: string
}

export const ResumeFactsSchema = z.object({
  education: z
    .array(
      z.object({
        school: z.string(),
        major: z.string().optional(),
        degree: z.enum(['高中', '大专', '本科', '硕士', '博士']).optional(),
        startYear: z.number().int().positive().optional(),
        endYear: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  experience: z
    .array(
      z.object({
        company: z.string().optional(),
        role: z.string().optional(),
        type: z.enum(['job', 'project', 'competition', 'gap']),
        start: z.string().optional(),
        end: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  skills: z
    .array(
      z.object({
        skill: z.string(),
        level: z.enum(['精通', '熟练', '胜任', '掌握', '入门']).optional(),
        context: z.string().optional(),
      }),
    )
    .default([]),
  constraints: z
    .array(
      z.object({
        jobRole: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        salary: z.string().optional(),
        city: z.string().optional(),
        location: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
  interests: z.array(z.string()).default([]),
})

const EXTRACT_SYSTEM =
  '你是简历信息提取器。从简历提取文本中提取结构化字段，只输出一个 JSON 对象，不要任何其他文字、' +
  '注释或 markdown 围栏。\n' +
  '规则：\n' +
  '① 只提取文本中显式出现的信息；未出现一律省略（禁止编造/补全——缺字段就省略）。\n' +
  '② 教育 degree 只能是：高中、大专、本科、硕士、博士（"大学本科/本科"→本科）。\n' +
  '③ 经历 type 只能是：job（工作经历）/ project（项目经历）/ competition（比赛）/ gap（空窗·备考·休整）；' +
  '起止格式 YYYY.MM 或 YYYY（如 2023.07、2025.03；仍在职 end 省略）；project/competition 无公司则 company 省略。\n' +
  '④ 技能 level 只能是：精通、熟练、胜任、掌握、入门（原文"精通/非常熟悉"→精通；"熟练/扎实"→熟练；' +
  '"了解/学习/接触/自学"→入门；无明确表述则省略）。\n' +
  '⑤ 约束：求职意向（岗位）/期望薪资/期望城市/现居城市等按原文；年龄、性别、备注放 note。\n' +
  '⑥ 兴趣：简历中明确表述的倾向（如"希望从事…"）才输出；无则空数组。'

/** 直连结构化提取（运行时唯一路径：generateObject；120s 超时防慢端点拖住初始化） */
export async function extractResumeFactsDirect(text: string, model: LanguageModel, logger: Logger): Promise<ResumeFacts> {
  const extractor = createStructuredExtractor(model)
  const result = await extractor.extract<ResumeFacts>(
    { text: text.slice(0, 12_000), system: EXTRACT_SYSTEM, timeoutMs: 120_000, maxRetries: 3, maxOutputTokens: 8_192 },
    ResumeFactsSchema,
  )
  logger.info(
    `resume-facts(direct) 提取：edu=${result.education.length} exp=${result.experience.length} ` +
      `skills=${result.skills.length} cons=${result.constraints.length} int=${result.interests.length}`,
  )
  return result
}

// ─── Candidate Generator（确定性映射：Facts → Candidate 输入）────────────────────────

export interface CandidateInput {
  category: string
  content: string
  source: 'resume'
  payload?: string
}

const EXPERIENCE_TYPE_LABEL: Record<ResumeExperience['type'], string> = {
  job: '工作',
  project: '项目',
  competition: '比赛',
  gap: '空窗',
}

/** 教育 span → '2019-2023' | '2019' | ''（只以存在字段为准） */
function yearSpan(start?: number, end?: number): string {
  if (start !== undefined && end !== undefined) return `${start}-${end}`
  if (start !== undefined) return String(start)
  if (end !== undefined) return String(end)
  return ''
}

function kv(...pairs: [string, string | undefined][]): string {
  return pairs
    .filter(([, v]) => v !== undefined && v.trim() !== '')
    .map(([k, v]) => `${k}=${v!.trim()}`)
    .join('；')
}

/** 教育 → 候选（content 原文可读；payload 供 Registration/投影结构化） */
function educationCandidate(e: ResumeEducation): CandidateInput | null {
  if (!e.school?.trim()) return null
  const span = yearSpan(e.startYear, e.endYear)
  const head = [e.school.trim(), e.major?.trim(), e.degree].filter(Boolean).join(' ')
  const content = `${head}${span ? `（${span}）` : ''}`
  const payload = kv(
    ['学校', e.school],
    ['专业', e.major],
    ['学历', e.degree],
    ['起', e.startYear !== undefined ? String(e.startYear) : undefined],
    ['止', e.endYear !== undefined ? String(e.endYear) : undefined],
  )
  return { category: 'education', content, source: 'resume', payload: payload || undefined }
}

/** 经历 → 候选：job 带载荷；project/competition/gap 不附加第四段（与采集协议一致） */
function experienceCandidate(x: ResumeExperience): CandidateInput | null {
  const span = [x.start, x.end].filter(Boolean).join('-') || ''
  const range = span ? `（${span}）` : ''
  const head = [x.company?.trim(), x.role?.trim()].filter(Boolean).join(' ')
  if (x.type === 'job') {
    const content = `${head}${range}` || EXPERIENCE_TYPE_LABEL.job
    const payload = kv(['公司', x.company], ['岗位', x.role], ['起', x.start], ['止', x.end])
    return { category: 'experience', content, source: 'resume', payload: payload || undefined }
  }
  const label = EXPERIENCE_TYPE_LABEL[x.type]
  const content = [`${[head, label].filter(Boolean).join(' ')}${range}`, x.summary?.trim()].filter(Boolean).join('：')
  return { category: 'experience', content: content || label, source: 'resume' }
}

function skillCandidate(s: ResumeSkill): CandidateInput | null {
  if (!s.skill?.trim()) return null
  const content = `${s.skill.trim()}${s.level ? `（${s.level}）` : ''}`
  const payload = kv(['技能', s.skill], ['级别', s.level], ['场景', s.context])
  return { category: 'skill', content, source: 'resume', payload: payload || undefined }
}

/** 约束 → 候选：一行候选可携带多键（意向岗位/优先级/薪资/城市/现居），与既有投影解析同源 */
function constraintCandidate(c: ResumeConstraintItem): CandidateInput | null {
  const parts = [
    c.jobRole && `求职意向：${c.jobRole.trim()}`,
    c.salary && `期望薪资：${c.salary.trim()}`,
    c.city && `期望城市：${c.city.trim()}`,
    c.location && `现居：${c.location.trim()}`,
    c.note && c.note.trim(),
  ].filter(Boolean)
  if (parts.length === 0) return null
  const payload = kv(
    ['意向岗位', c.jobRole],
    ['优先级', c.priority],
    ['薪资', c.salary],
    ['城市', c.city],
    ['现居', c.location],
  )
  return { category: 'constraint', content: parts.join('；'), source: 'resume', payload: payload || undefined }
}

/** 确定性映射：ResumeFacts → Candidate 输入（source=resume；顺序：教育→经历→技能→约束→兴趣） */
export function resumeFactsToCandidates(facts: ResumeFacts): CandidateInput[] {
  const out: CandidateInput[] = []
  for (const e of facts.education) {
    const c = educationCandidate(e)
    if (c) out.push(c)
  }
  for (const x of facts.experience) {
    const c = experienceCandidate(x)
    if (c) out.push(c)
  }
  for (const s of facts.skills) {
    const c = skillCandidate(s)
    if (c) out.push(c)
  }
  for (const c of facts.constraints) {
    const cand = constraintCandidate(c)
    if (cand) out.push(cand)
  }
  for (const i of facts.interests) {
    if (i.trim()) out.push({ category: 'interest', content: `兴趣方向：${i.trim()}`, source: 'resume' })
  }
  return out
}

// ─── Resume Facts Artifact（引擎单方写；facts.json = 数据资产，不进 markdown 扫描域）────────

export function factsArtifactRel(personId: string, artifactId: string): string {
  return `persons/${personId}/documents/resumes/extraction/${artifactId}.facts.json`
}

export function writeResumeFactsArtifact(
  ws: Workspace,
  personId: string,
  artifactId: string,
  facts: ResumeFacts,
  meta: { model: string; createdAt?: string },
): void {
  ws.write(
    factsArtifactRel(personId, artifactId),
    JSON.stringify(
      {
        $schema: 'career-os/resume-facts@1',
        artifactId,
        personId,
        source: 'resume_extraction',
        model: meta.model,
        createdAt: meta.createdAt ?? new Date().toISOString(),
        facts,
      },
      null,
      2,
    ),
  )
}

export function readResumeFactsArtifact(ws: Workspace, personId: string, artifactId: string): ResumeFacts | undefined {
  const rel = factsArtifactRel(personId, artifactId)
  if (!ws.exists(rel)) return undefined
  try {
    const parsed = JSON.parse(ws.read(rel)) as { facts?: ResumeFacts }
    return parsed.facts
  } catch {
    return undefined
  }
}

// ─── 编排：提取文本 → Facts → Candidate Inbox（幂等：facts 已存在 → 复用不重提）────────────

export interface GenerateResumeCandidatesResult {
  artifactId: string
  facts: ResumeFacts
  added: { id: string; category: string; content: string; status: string }[]
  /** facts.json 已存在（未触发 LLM 提取）；added=[] 表示候选此前已登记（幂等） */
  reused: boolean
}

/** 最新简历 artifact（meta 最大编号；无 → undefined） */
export function latestResumeArtifactId(ws: Workspace, personId: string): string | undefined {
  try {
    const seqs = ws
      .listMarkdown(`persons/${personId}/documents/resumes`)
      .filter((f) => /\.meta\.md$/.test(f) && f.startsWith('resume-'))
      .map((f) => Number(f.match(/^resume-(\d+)\.meta\.md$/)?.[1] ?? 0))
      .filter((n) => n > 0)
    if (seqs.length === 0) return undefined
    return `resume-${String(Math.max(...seqs)).padStart(3, '0')}`
  } catch {
    return undefined
  }
}

export async function generateResumeCandidates(
  ws: Workspace,
  params: { personId: string; artifactId?: string },
  model: LanguageModel,
  logger: Logger,
): Promise<GenerateResumeCandidatesResult> {
  const { personId } = params
  const artifactId = params.artifactId?.trim() || latestResumeArtifactId(ws, personId)
  if (!artifactId) throw new Error('未找到简历 artifact——请先上传简历')
  const extRel = `persons/${personId}/documents/resumes/extraction/${artifactId}.md`
  if (!ws.exists(extRel)) {
    throw new Error(`未找到提取文本（${artifactId}）——请先在简历上传页完成提取`)
  }
  let facts = readResumeFactsArtifact(ws, personId, artifactId)
  let reused = true
  if (!facts) {
    reused = false
    facts = await extractResumeFactsDirect(ws.read(extRel), model, logger)
    writeResumeFactsArtifact(ws, personId, artifactId, facts, { model: (model as unknown as { modelId?: string }).modelId ?? 'unknown' })
  }
  const candidates = resumeFactsToCandidates(facts)
  const already = listCandidateCount(ws, personId)
  const added =
    reused && already > 0
      ? []
      : appendCandidatesSafe(ws, personId, candidates)
  // 状态机（PR-2）：候选已入 Inbox → candidate_review（仅推进未完成档案；completed 不降级）
  const cur = readManifestInitState(ws, personId)
  if (cur === 'uploading' || cur === 'extracting' || cur === 'in_progress') {
    setManifestInitState(ws, personId, 'candidate_review')
  }
  return { artifactId, facts, added, reused }
}

// 局部导入避免顶部循环（person-watcher 不依赖本模块）
function listCandidateCount(ws: Workspace, personId: string): number {
  try {
    return listCandidates(ws, personId).length
  } catch {
    return 0
  }
}

function appendCandidatesSafe(
  ws: Workspace,
  personId: string,
  candidates: { category: string; content: string; source: 'resume'; payload?: string }[],
): { id: string; category: string; content: string; status: string }[] {
  if (candidates.length === 0) return []
  const added = appendCandidates(ws, { personId, candidates })
  return added.map((c) => ({ id: c.id, category: c.category, content: c.content, status: c.status }))
}
