import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { appendCandidates, createPersonSession, listCandidates, parseEducationPayload, parseExperiencePayload } from '../storage/person-watcher.ts'
import { createResumeArtifact } from '../storage/pdf-artifact.ts'
import { ResumeFactsSchema, resumeFactsToCandidates, writeResumeFactsArtifact, generateResumeCandidates, readResumeFactsArtifact, latestResumeArtifactId, type ResumeFacts } from '../runtime/resume-facts.ts'
import type { Logger } from '../logger.ts'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

function testWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-resume-facts-'))
  return initWorkspace(root)
}

const SAMPLE_FACTS: ResumeFacts = {
  education: [
    { school: 'University-A', major: '机械工程', degree: '本科', startYear: 2019, endYear: 2023 },
    { school: '中学-B', degree: undefined, startYear: 2016, endYear: 2019 },
  ],
  experience: [
    { company: 'Company-A', role: '机械工程师', type: 'job', start: '2023.07', end: '2025.03', summary: 'IVD 结构设计' },
    { company: 'Company-A', role: '机械工程师', type: 'project', start: '2024.01', end: '2025.03', summary: 'I2400 化学发光低成本优化' },
    { type: 'gap', start: '2025.04', end: '2026.03', summary: '考研备考（机械原理方向）' },
    { company: 'Company-A', role: '机械工程师', type: 'job', start: '2026.03' },
  ],
  skills: [
    { skill: 'SolidWorks', level: '精通', context: '机械制图与三维建模' },
    { skill: 'Ansys', level: '入门' },
  ],
  constraints: [
    { jobRole: '机械结构工程师', salary: '11-13K', city: 'City-X', location: 'City-X', priority: 'high' },
    { note: '26 岁男；英语良好未过四级；普通话二级甲等' },
  ],
  interests: ['医疗器械结构设计', '机器人结构设计'],
}

test('ResumeFactsSchema：完整合法 + 可选字段省略/数组缺省降级', () => {
  const full = ResumeFactsSchema.safeParse(SAMPLE_FACTS)
  assert.equal(full.success, true)
  const minimal = ResumeFactsSchema.safeParse({})
  assert.equal(minimal.success, true)
  assert.deepEqual(minimal.data, { education: [], experience: [], skills: [], constraints: [], interests: [] })
})

test('ResumeFactsSchema：值域校验（degree/type/level 枚举拦截）', () => {
  assert.equal(ResumeFactsSchema.safeParse({ education: [{ school: 'X', degree: '中学' }] }).success, false)
  assert.equal(ResumeFactsSchema.safeParse({ experience: [{ type: 'intern' }] }).success, false)
  assert.equal(ResumeFactsSchema.safeParse({ skills: [{ skill: 'A', level: '大神' }] }).success, false)
  assert.equal(ResumeFactsSchema.safeParse({ education: [{ school: 'X' }] }).success, true)
})

test('resumeFactsToCandidates：确定性映射（edu2 + exp4 + skill2 + cons2 + int2 = 12）', () => {
  const cands = resumeFactsToCandidates(SAMPLE_FACTS)
  assert.equal(cands.length, 12)
  assert.deepEqual(
    cands.map((c) => c.category),
    ['education', 'education', 'experience', 'experience', 'experience', 'experience', 'skill', 'skill', 'constraint', 'constraint', 'interest', 'interest'],
  )
})

test('resumeFactsToCandidates：教育/经历载荷可被既有解析器回读', () => {
  const cands = resumeFactsToCandidates(SAMPLE_FACTS)
  const edu = cands.find((c) => c.category === 'education' && c.content.startsWith('University-A'))
  assert.ok(edu)
  assert.equal(edu.payload, '学校=University-A；专业=机械工程；学历=本科；起=2019；止=2023')
  const parsed = parseEducationPayload(edu.payload)
  assert.deepEqual(parsed, { school: 'University-A', major: '机械工程', degree: '本科', startYear: 2019, endYear: 2023 })

  const job = cands.find((c) => c.content.includes('Company-A 机械工程师（2023.07-2025.03）'))
  assert.ok(job)
  const jobParsed = parseExperiencePayload(job.payload)
  assert.deepEqual(jobParsed, { company: 'Company-A', role: '机械工程师', start: '2023.07', end: '2025.03' })
})

test('resumeFactsToCandidates：项目/空窗无载荷；在职 job 无止；约束合并行；兴趣无载荷', () => {
  const cands = resumeFactsToCandidates(SAMPLE_FACTS)
  const project = cands.find((c) => c.content.includes('项目（2024.01-2025.03）：I2400'))
  assert.ok(project)
  assert.equal(project.payload, undefined)
  const gap = cands.find((c) => c.content.includes('空窗（2025.04-2026.03）'))
  assert.ok(gap)
  assert.equal(gap.payload, undefined)
  const activeJob = cands.find((c) => c.content.includes('机械工程师（2026.03）'))
  assert.ok(activeJob)
  assert.equal(activeJob.payload, '公司=Company-A；岗位=机械工程师；起=2026.03')
  const cons = cands.find((c) => c.category === 'constraint' && c.content.includes('求职意向：机械结构工程师'))
  assert.ok(cons)
  assert.equal(cons.payload, '意向岗位=机械结构工程师；优先级=high；薪资=11-13K；城市=City-X；现居=City-X')
  const note = cands.find((c) => c.content.includes('26 岁男'))
  assert.ok(note)
  assert.equal(note.payload, undefined)
  const int = cands.find((c) => c.category === 'interest')
  assert.ok(int)
  assert.equal(int.payload, undefined)
  assert.equal(int.content, '兴趣方向：医疗器械结构设计')
})

test('generateResumeCandidates：facts 已存在 → 首次补录候选，再次调用幂等不重加', async () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '某某', sourceMode: 'resume' })
  createResumeArtifact(ws, { personId, fileName: 'resume.pdf', text: '（提取文本——复用路径不触发 LLM）', extraction: { method: 'vision', model: 'glm-4v-flash' } })
  const artifactId = latestResumeArtifactId(ws, personId)
  assert.equal(artifactId, 'resume-001')
  writeResumeFactsArtifact(ws, personId, artifactId!, SAMPLE_FACTS, { model: 'deepseek-v4-flash' })

  const stub = {} as unknown as LanguageModel
  const r1 = await generateResumeCandidates(ws, { personId }, stub, silentLogger)
  assert.equal(r1.reused, true)
  assert.equal(r1.added.length, 12)
  assert.equal(r1.facts.education.length, 2)
  const r2 = await generateResumeCandidates(ws, { personId }, stub, silentLogger)
  assert.equal(r2.reused, true)
  assert.equal(r2.added.length, 0) // 幂等：候选已登记 → 不重复追加

  // Candidate Inbox 通道闭口：行格式可被 listCandidates 回读
  const listed = listCandidates(ws, personId)
  assert.equal(listed.length, 12)
  assert.equal(listed[0].category, 'education')
  assert.equal(listed[0].status, 'pending')
  assert.equal(listed[0].source, 'resume')
  assert.equal(listed[0].payload, '学校=University-A；专业=机械工程；学历=本科；起=2019；止=2023')
  const facts = readResumeFactsArtifact(ws, personId, 'resume-001')
  assert.equal(facts?.education.length, 2)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('generateResumeCandidates：缺 artifact / 缺提取文本 → fail fast', async () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '某某', sourceMode: 'resume' })
  const stub = {} as unknown as LanguageModel
  await assert.rejects(() => generateResumeCandidates(ws, { personId }, stub, silentLogger), /未找到简历 artifact/)
  createResumeArtifact(ws, { personId, fileName: 'r.pdf', pdfBase64: Buffer.from('pdf').toString('base64'), extraction: { method: 'vision' } })
  await assert.rejects(() => generateResumeCandidates(ws, { personId }, stub, silentLogger), /未找到提取文本/)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('appendCandidates 兼容：generator 输出可直接走既有候选通道（源=resume）', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '某某', sourceMode: 'resume' })
  const added = appendCandidates(ws, { personId, candidates: resumeFactsToCandidates(SAMPLE_FACTS) })
  assert.equal(added.length, 12)
  assert.equal(added[0].status, 'pending')
  assert.equal(added[0].sessionRef, 'session-001')
  const listed = listCandidates(ws, personId)
  assert.equal(listed.length, 12)
  assert.ok(listed.every((c) => c.source === 'resume'))
  rmSync(ws.paths.root, { recursive: true, force: true })
})
