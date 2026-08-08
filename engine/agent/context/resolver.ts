/**
 * Context Resolution（ADR-020 §6 / 契约 §6：生命周期 Step 2）。
 * - 职责：消费既有 Registry（scanJobs / scanResumes / store.listCompanies / listDecisions）
 *   解析存在性 + 生成 snapshot 标识（解析时登记的当前标识，非 optimistic lock）+ provenance
 * - 引用不存在 → INVALID_CONTEXT_REFERENCE（错误关联比无关联危险，fail fast）
 * - 不引入 ContextRepository 等新抽象——直接消费既有读取路径
 */
import type { Workspace } from '../../storage/workspace.ts'
import { scanJobs } from '../../storage/job-watcher.ts'
import { scanResumes } from '../../storage/resume-watcher.ts'
import type { CompanyRecord, DecisionRecord } from '../../ir/schema.ts'
import type {
  AgentTaskRejected,
  ContextReference,
  ResolvedContextReference,
} from '../../ir/agent-task.ts'

/** 引用类型 → 来源通道（provenance 映射——UI「本次分析依据」展示标签） */
const PROVENANCE: Record<ContextReference['type'], { kind: string; label: string }> = {
  job: { kind: 'jd-analysis', label: '岗位分析' },
  company: { kind: 'company-dossier', label: '公司档案' },
  resume: { kind: 'resume-artifact', label: '简历资产' },
  decision: { kind: 'decision-registry', label: '决策记录' },
}

/** resolver 消费的最小 Registry 接口（company/decision 在 ProjectionStore——不依赖具体 store 类型） */
export interface RegistryStore {
  listCompanies(): CompanyRecord[]
  listDecisions(): DecisionRecord[]
}

export type ResolveResult =
  | { resolved: ResolvedContextReference[] }
  | AgentTaskRejected

/** 全量解析：任一引用不存在 → 整体拒绝（INVALID_CONTEXT_REFERENCE，fail fast） */
export function resolveContextRefs(
  ws: Workspace,
  store: RegistryStore,
  refs: ContextReference[],
): ResolveResult {
  const resolved: ResolvedContextReference[] = []
  for (const ref of refs) {
    const r = resolveOne(ws, store, ref)
    if (!r) {
      return {
        reason: 'INVALID_CONTEXT_REFERENCE',
        refs: [{ type: ref.type, id: ref.id, error: '引用不存在' }],
      }
    }
    resolved.push(r)
  }
  return { resolved }
}

function resolveOne(
  ws: Workspace,
  store: RegistryStore,
  ref: ContextReference,
): ResolvedContextReference | null {
  const provenance = PROVENANCE[ref.type]
  switch (ref.type) {
    case 'job': {
      const job = scanJobs(ws).find((j) => j.record.id === ref.id)
      if (!job) return null
      return {
        type: 'job',
        id: ref.id,
        label: `${job.record.company} ${job.record.title}`,
        snapshot: { kind: 'timestamp', value: job.record.createdAt.slice(0, 10) },
        provenance,
      }
    }
    case 'company': {
      const company = store.listCompanies().find((c) => c.id === ref.id)
      if (!company) return null
      return { type: 'company', id: ref.id, label: company.name, provenance }
    }
    case 'resume': {
      const resume = scanResumes(ws).find((r) => r.record.id === ref.id)
      if (!resume) return null
      return {
        type: 'resume',
        id: ref.id,
        snapshot: { kind: 'version', value: resume.record.id },
        provenance,
      }
    }
    case 'decision': {
      const decision = store.listDecisions().find((d) => d.id === ref.id)
      if (!decision) return null
      return {
        type: 'decision',
        id: ref.id,
        label: decision.title,
        snapshot: { kind: 'timestamp', value: decision.createdAt.slice(0, 10) },
        provenance,
      }
    }
  }
}
