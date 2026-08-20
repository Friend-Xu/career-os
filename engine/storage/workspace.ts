/**
 * 工作目录服务：引擎的唯一文件系统出口。
 * - paths：子目录解析（决策文件名规范见 decision-registry：系统 ID 登记，引擎单方命名）
 * - read/write：统一 fs 封装（同步；本地个人工具、文件小）
 * - initWorkspace：首次运行创建目录树（对齐 AGENTS.md 既有承诺）
 *   + metadata/protocol.json（{ protocol: 'career-os', version: ProtocolVersion, created }，
 *   引擎单方维护，skill 不读写；版本漂移时回写当前版本，created 保留首次时间戳）
 * 目录创建失败/不可写 → WorkspaceError fail fast（系统边界校验）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ProtocolVersion } from '../ir/schema.ts'

export class WorkspaceError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`❌ workspace：${path} = ${reason}`)
    this.name = 'WorkspaceError'
    this.path = path
    this.reason = reason
  }
}

export interface WorkspacePaths {
  root: string
  profiles: string
  decisions: string
  decisionContexts: string
  companies: string
  jobs: string
  applications: string
  evidence: string
  claims: string
  claimProposals: string
  opportunityProposals: string
  applyTransactions: string
  opportunityHistory: string
  strengthProposals: string
  derivationProposals: string
  resumes: string
  workingCopies: string
  proposals: string
  portfolio: string
  portfolioProjects: string
  portfolioProposals: string
  interviews: string
  interviewProposals: string
  coverLetters: string
  coverLetterProposals: string
  knowledge: string
  persons: string
  targets: string
  companyPool: string
  jobLeads: string
  metadata: string
  indexFile: string
  protocolFile: string
}

export interface Workspace {
  paths: WorkspacePaths
  /** 相对 root 读文件；不存在抛 WorkspaceError（调用方先用 exists 判断） */
  read(relPath: string): string
  /** 相对 root 写文件（自动创建父目录） */
  write(relPath: string, content: string | Uint8Array): void
  exists(relPath: string): boolean
  /** 相对 root 删除文件（不存在抛 WorkspaceError） */
  delete(relPath: string): void
  /** 列出子目录下的 .md 文件（无目录则抛 WorkspaceError） */
  listMarkdown(subDir: string): string[]
  /** 列出子目录下的 .json 文件（无目录则抛 WorkspaceError；Application Registry 用） */
  listJson(subDir: string): string[]
  /** 列出子目录下的子目录名（无目录则抛 WorkspaceError） */
  listDirs(subDir: string): string[]
}

export function buildPaths(root: string): WorkspacePaths {
  return {
    root,
    profiles: join(root, 'profiles'),
    decisions: join(root, 'decisions'),
    decisionContexts: join(root, 'decision-contexts'),
    companies: join(root, 'companies'),
    jobs: join(root, 'jobs'),
    applications: join(root, 'applications'),
    evidence: join(root, 'evidence'),
    claims: join(root, 'claims'),
    claimProposals: join(root, 'claim-proposals'),
    opportunityProposals: join(root, 'opportunity-proposals'),
    applyTransactions: join(root, 'apply-transactions'),
    opportunityHistory: join(root, 'opportunity-history'),
    strengthProposals: join(root, 'strength-proposals'),
    derivationProposals: join(root, 'derivation-proposals'),
    resumes: join(root, 'resumes'),
    workingCopies: join(root, 'resumes', 'working-copies'),
    proposals: join(root, 'proposals'),
    portfolio: join(root, 'portfolio'),
    portfolioProjects: join(root, 'portfolio', 'projects'),
    portfolioProposals: join(root, 'portfolio', 'proposals'),
    interviews: join(root, 'interviews'),
    interviewProposals: join(root, 'interviews', 'proposals'),
    coverLetters: join(root, 'cover-letters'),
    coverLetterProposals: join(root, 'cover-letters', 'proposals'),
    knowledge: join(root, 'knowledge'),
    persons: join(root, 'persons'),
    targets: join(root, 'targets'),
    companyPool: join(root, 'company-pool'),
    jobLeads: join(root, 'job-leads'),
    metadata: join(root, 'metadata'),
    indexFile: join(root, 'INDEX.md'),
    protocolFile: join(root, 'metadata', 'protocol.json'),
  }
}

const INDEX_TEMPLATE = `# 职业决策信息池

> 汇总索引（AGENTS.md 协议）。首次运行由引擎创建，内容由 skill 生态维护。
`

const PROTOCOL_TEMPLATE = {
  protocol: 'career-os',
  version: ProtocolVersion,
}

/** 版本标记收敛（断链审计 F14/Y1）：缺失 → 创建；版本漂移（旧引擎写入）→ 回写当前
 *  ProtocolVersion（created 保留首次时间戳）；已对齐 → 不写盘（幂等）。损坏的标记文件按缺失重建。 */
function writeProtocolMarker(protocolFile: string): void {
  let created: string | undefined
  if (existsSync(protocolFile)) {
    try {
      const existing = JSON.parse(readFileSync(protocolFile, 'utf8')) as { protocol?: string; version?: string; created?: string }
      if (existing.protocol === 'career-os' && existing.version === ProtocolVersion) return
      created = existing.created
    } catch {
      // 损坏的标记文件：按缺失处理（系统边界——文件内容不在契约内）
    }
  }
  writeFileSync(protocolFile, JSON.stringify({ ...PROTOCOL_TEMPLATE, created: created ?? new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

function assertWritable(root: string): void {
  const probe = join(root, '.write-probe')
  try {
    writeFileSync(probe, 'probe', 'utf8')
  } catch {
    throw new WorkspaceError(root, '目录不可写（权限/磁盘问题）')
  }
}

export function initWorkspace(root: string): Workspace {
  const paths = buildPaths(root)
  try {
    mkdirSync(paths.profiles, { recursive: true })
    mkdirSync(paths.decisions, { recursive: true })
    mkdirSync(paths.decisionContexts, { recursive: true })
    mkdirSync(paths.companies, { recursive: true })
    mkdirSync(paths.jobs, { recursive: true })
    mkdirSync(paths.applications, { recursive: true })
    mkdirSync(paths.evidence, { recursive: true })
    mkdirSync(paths.claims, { recursive: true })
    mkdirSync(paths.claimProposals, { recursive: true })
    mkdirSync(paths.opportunityProposals, { recursive: true })
    mkdirSync(paths.strengthProposals, { recursive: true })
    mkdirSync(paths.derivationProposals, { recursive: true })
    mkdirSync(paths.applyTransactions, { recursive: true })
    mkdirSync(paths.opportunityHistory, { recursive: true })
    mkdirSync(paths.resumes, { recursive: true })
    mkdirSync(join(paths.resumes, 'documents'), { recursive: true })
    mkdirSync(join(paths.resumes, 'drafts'), { recursive: true })
    mkdirSync(join(paths.resumes, 'exports'), { recursive: true })
    mkdirSync(paths.workingCopies, { recursive: true })
    mkdirSync(paths.proposals, { recursive: true })
    mkdirSync(paths.portfolio, { recursive: true })
    mkdirSync(paths.portfolioProjects, { recursive: true })
    mkdirSync(paths.portfolioProposals, { recursive: true })
    mkdirSync(paths.interviews, { recursive: true })
    mkdirSync(paths.interviewProposals, { recursive: true })
    mkdirSync(paths.coverLetters, { recursive: true })
    mkdirSync(paths.coverLetterProposals, { recursive: true })
    mkdirSync(paths.knowledge, { recursive: true })
    mkdirSync(paths.persons, { recursive: true })
    mkdirSync(paths.targets, { recursive: true })
    mkdirSync(paths.companyPool, { recursive: true })
    mkdirSync(paths.jobLeads, { recursive: true })
    mkdirSync(paths.metadata, { recursive: true })
  } catch {
    throw new WorkspaceError(root, '目录创建失败（权限/路径非法）')
  }
  assertWritable(root)

  if (!existsSync(paths.indexFile)) writeFileSync(paths.indexFile, INDEX_TEMPLATE, 'utf8')
  writeProtocolMarker(paths.protocolFile)

  return {
    paths,
    read(relPath) {
      const full = join(root, relPath)
      try {
        return readFileSync(full, 'utf8')
      } catch {
        throw new WorkspaceError(relPath, '文件不存在或不可读')
      }
    },
    write(relPath, content) {
      const full = join(root, relPath)
      mkdirSync(dirname(full), { recursive: true })
      // 不传 encoding：string 默认 utf8；Uint8Array（如简历 PDF）原样写入
      writeFileSync(full, content)
    },
    exists(relPath) {
      return existsSync(join(root, relPath))
    },
    delete(relPath) {
      const full = join(root, relPath)
      try {
        unlinkSync(full)
      } catch {
        throw new WorkspaceError(relPath, '文件不存在或不可删除')
      }
    },
    listMarkdown(subDir) {
      const dir = join(root, subDir)
      if (!existsSync(dir)) throw new WorkspaceError(subDir, '目录不存在')
      return readdirSync(dir).filter((f) => f.endsWith('.md'))
    },
    listJson(subDir) {
      const dir = join(root, subDir)
      if (!existsSync(dir)) throw new WorkspaceError(subDir, '目录不存在')
      return readdirSync(dir).filter((f) => f.endsWith('.json'))
    },
    listDirs(subDir) {
      const dir = join(root, subDir)
      if (!existsSync(dir)) throw new WorkspaceError(subDir, '目录不存在')
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    },
  }
}
