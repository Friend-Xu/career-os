/**
 * 信息池图谱派生（第 3 步）：decisions + companies + profiles → PoolNode[]/PoolEdge[]。
 * - 节点 5 类：person / decision / direction / city / company；id 规范：
 *   person:{名字} / decision:{文件名去扩展} / direction:{名} / city:{名} / company:{名}
 * - 边 3 类：decision→person（评估）/ decision→direction（归属）/ decision→city（位于）
 * - strength：directionMatch/cityScore ≥80 high、≥60 medium、否则 low
 * - matchScore/riskLevel 从决策字段取（同方向/同城市/同人多决策取最大匹配、最高风险）
 * - invalid 决策整体跳过（validator 契约：invalid 实体不参与图谱连线）
 */
import type { EdgeStrength, PoolEdge, PoolNode, RiskLevel } from '../ir/schema.ts'
import type { ParsedDecision } from './report-watcher.ts'

export interface GraphInput {
  decisions: ParsedDecision[]
  companies: { id: string; name: string }[]
  profileNames: string[]
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

function strengthOf(score: number | undefined): EdgeStrength {
  if (score !== undefined && score >= 80) return 'high'
  if (score !== undefined && score >= 60) return 'medium'
  return 'low'
}

export function buildGraph(input: GraphInput): { nodes: PoolNode[]; edges: PoolEdge[] } {
  const nodes = new Map<string, PoolNode>()
  const edges: PoolEdge[] = []

  function addNode(node: PoolNode): void {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
  }
  function mergeScore(id: string, score: number | undefined): void {
    if (score === undefined) return
    const n = nodes.get(id)
    if (n && (n.matchScore === undefined || score > n.matchScore)) n.matchScore = score
  }
  function mergeRisk(id: string, risk: RiskLevel | undefined): void {
    if (risk === undefined) return
    const n = nodes.get(id)
    if (n && (n.riskLevel === undefined || RISK_ORDER[risk] > RISK_ORDER[n.riskLevel])) n.riskLevel = risk
  }
  function addEdge(source: string, target: string, relation: string, strength: EdgeStrength): void {
    edges.push({ id: `${source}->${target}`, source, target, relation, strength })
  }

  // 公司节点（companies/*.md 每个档案）
  for (const c of input.companies) {
    addNode({ id: `company:${c.id}`, label: c.name, type: 'company' })
  }
  // 人节点（每份 profile）
  for (const name of input.profileNames) {
    addNode({ id: `person:${name}`, label: name, type: 'person' })
  }

  for (const p of input.decisions) {
    if (p.validation?.status === 'invalid') continue
    const r = p.record
    const did = `decision:${r.id}`
    addNode({ id: did, label: r.title, type: 'decision', matchScore: r.directionMatch, riskLevel: r.riskLevel })

    if (r.profile) {
      addNode({ id: `person:${r.profile}`, label: r.profile, type: 'person' })
      addEdge(did, `person:${r.profile}`, '评估', strengthOf(r.directionMatch))
      mergeScore(`person:${r.profile}`, r.directionMatch)
      mergeRisk(`person:${r.profile}`, r.riskLevel)
    }
    if (r.direction) {
      const nid = `direction:${r.direction}`
      addNode({ id: nid, label: r.direction, type: 'direction' })
      addEdge(did, nid, '归属', strengthOf(r.directionMatch))
      mergeScore(nid, r.directionMatch)
      mergeRisk(nid, r.riskLevel)
    }
    if (r.city) {
      const nid = `city:${r.city}`
      addNode({ id: nid, label: r.city, type: 'city' })
      addEdge(did, nid, '位于', strengthOf(r.cityScore))
      mergeScore(nid, r.cityScore)
      mergeRisk(nid, r.riskLevel)
    }
  }

  return { nodes: [...nodes.values()], edges }
}
