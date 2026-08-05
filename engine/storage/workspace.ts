/**
 * 工作目录服务：引擎的唯一文件系统出口。
 * - paths：子目录解析（决策文件名规范见 decision-registry：系统 ID 登记，引擎单方命名）
 * - read/write：统一 fs 封装（同步；本地个人工具、文件小）
 * - initWorkspace：首次运行创建目录树（对齐 AGENTS.md 既有承诺）
 *   + metadata/protocol.json（{ protocol: 'career-os', version: '2.2', created }，
 *   引擎单方维护，skill 不读写）
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
  evidence: string
  claims: string
  resumes: string
  proposals: string
  knowledge: string
  metadata: string
  indexFile: string
  protocolFile: string
}

export interface Workspace {
  paths: WorkspacePaths
  /** 相对 root 读文件；不存在抛 WorkspaceError（调用方先用 exists 判断） */
  read(relPath: string): string
  /** 相对 root 写文件（自动创建父目录） */
  write(relPath: string, content: string): void
  exists(relPath: string): boolean
  /** 相对 root 删除文件（不存在抛 WorkspaceError） */
  delete(relPath: string): void
  /** 列出子目录下的 .md 文件（无目录则抛 WorkspaceError） */
  listMarkdown(subDir: string): string[]
}

export function buildPaths(root: string): WorkspacePaths {
  return {
    root,
    profiles: join(root, 'profiles'),
    decisions: join(root, 'decisions'),
    decisionContexts: join(root, 'decision-contexts'),
    companies: join(root, 'companies'),
    jobs: join(root, 'jobs'),
    evidence: join(root, 'evidence'),
    claims: join(root, 'claims'),
    resumes: join(root, 'resumes'),
    proposals: join(root, 'proposals'),
    knowledge: join(root, 'knowledge'),
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
    mkdirSync(paths.evidence, { recursive: true })
    mkdirSync(paths.claims, { recursive: true })
    mkdirSync(paths.resumes, { recursive: true })
    mkdirSync(join(paths.resumes, 'documents'), { recursive: true })
    mkdirSync(join(paths.resumes, 'drafts'), { recursive: true })
    mkdirSync(join(paths.resumes, 'exports'), { recursive: true })
    mkdirSync(paths.proposals, { recursive: true })
    mkdirSync(paths.knowledge, { recursive: true })
    mkdirSync(paths.metadata, { recursive: true })
  } catch {
    throw new WorkspaceError(root, '目录创建失败（权限/路径非法）')
  }
  assertWritable(root)

  if (!existsSync(paths.indexFile)) writeFileSync(paths.indexFile, INDEX_TEMPLATE, 'utf8')
  if (!existsSync(paths.protocolFile)) {
    writeFileSync(paths.protocolFile, JSON.stringify({ ...PROTOCOL_TEMPLATE, created: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  }

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
      writeFileSync(full, content, 'utf8')
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
  }
}
