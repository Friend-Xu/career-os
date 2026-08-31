/**
 * 信息池图谱派生（第 3 步）：decisions + companies + profiles → PoolNode[]/PoolEdge[]。
 * - 节点 5 类：person / decision / direction / city / company；id 规范：
 *   person:{名字} / decision:{文件名去扩展} / direction:{名} / city:{名} / company:{名}
 * - 边 3 类：decision→person（评估）/ decision→direction（归属）/ decision→city（位于）
 * - strength：directionMatch/cityScore ≥80 high、≥60 medium、否则 low
 * - matchScore/riskLevel 从决策字段取（同方向/同城市/同人多决策取最大匹配、最高风险）
 * - invalid 实体整体跳过（validator 契约：invalid 不参与图谱连线；决策与公司档案一致）
 * V2 知识层（第 6 步）：roles/skills 入图——
 * - 节点 +2 类：role:{岗位 id}（label=岗位名）/ skill:{技能名}（label=技能名，词表节点）
 * - 边 +2 类：company→role（雇佣，medium，公司节点存在时连）/ role→skill（需求，essential ? high : medium）
 * - 角色技能引用按词表别名归一化连线（如需求写"结构设计" → 连 skill:机械设计）；词表外技能无节点，边跳过
 */
import type { EdgeStrength, PoolEdge, PoolNode, RiskLevel, Role, Skill, Validation } from '../ir/schema.ts'
import type { ParsedDecision } from './report-watcher.ts'
import { buildSkillIndex } from './knowledge-watcher.ts'

export interface GraphInput {
  decisions: ParsedDecision[]
  /** 公司档案（CompanyView）：带 validation 时 invalid 跳过 */
  companies: { id: string; name: string; matchScore?: number; riskLevel?: RiskLevel; validation?: Validation; aliases?: string[] }[]
  profileNames: string[]
  /** V2 知识层：技能词表（词表节点）+ 岗位清单（岗位节点与需求/雇佣边） */
  skills?: Skill[]
  roles?: Role[]
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

  // 公司节点（companies/*.md 每个档案；invalid 档案跳过，与决策一致）
  for (const c of input.companies) {
    if (c.validation?.status === 'invalid') continue
    addNode({ id: `company:${c.id}`, label: c.name, type: 'company', matchScore: c.matchScore, riskLevel: c.riskLevel })
  }
  // 人节点（每份 profile）
  for (const name of input.profileNames) {
    addNode({ id: `person:${name}`, label: name, type: 'person' })
  }

  // V2 知识层：技能节点（词表）+ 岗位节点（雇佣/需求边；invalid 知识文件 → 空列表，无节点可加）
  // v0.3（ADR-031）：节点 id = skill:{skill_id}（Registry 身份）；canonical_name 仅 label；legacy 条目（无 id）降级按名
  const skillIndex = buildSkillIndex(input.skills ?? [])
  for (const s of input.skills ?? []) {
    addNode({ id: `skill:${s.id ?? s.name}`, label: s.name, type: 'skill' })
  }
  const companyNodeByName = new Map<string, string>() // canonical/alias → 节点 id（精确解析；档案缺失的公司无雇佣边）
  for (const c of input.companies) {
    if (c.validation?.status === 'invalid') continue
    companyNodeByName.set(c.name, `company:${c.id}`)
    for (const a of c.aliases ?? []) companyNodeByName.set(a, `company:${c.id}`)
  }
  for (const r of input.roles ?? []) {
    const rid = `role:${r.id}`
    addNode({ id: rid, label: r.name, type: 'role' })
    const cid = companyNodeByName.get(r.company)
    if (cid) addEdge(cid, rid, '雇佣', 'medium')
    for (const req of r.skills) {
      // v0.3：需求侧按 skill_id 连线（id 对齐）；legacy 需求（无 id）按词表别名归一降级
      const sid = req.skill_id ? `skill:${req.skill_id}` : `skill:${skillIndex.get(req.name) ?? req.name}`
      if (nodes.has(sid)) addEdge(rid, sid, '需求', req.essential ? 'high' : 'medium')
    }
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
    // v2.8 payload 优先：方向评估明细/城市评估明细 → 每方向/每城市一个节点；无 payload 回退摘要表单值（存量决策）
    if (r.payload?.type === 'direction' && r.payload.directions.length > 0) {
      for (const d of r.payload.directions) {
        const nid = `direction:${d.name}`
        addNode({ id: nid, label: d.name, type: 'direction' })
        addEdge(did, nid, '归属', strengthOf(d.match))
        mergeScore(nid, d.match)
        mergeRisk(nid, r.riskLevel)
      }
    } else if (r.direction) {
      const nid = `direction:${r.direction}`
      addNode({ id: nid, label: r.direction, type: 'direction' })
      addEdge(did, nid, '归属', strengthOf(r.directionMatch))
      mergeScore(nid, r.directionMatch)
      mergeRisk(nid, r.riskLevel)
    }
    if (r.payload?.type === 'city' && r.payload.cities.length > 0) {
      for (const c of r.payload.cities) {
        const nid = `city:${c.name}`
        addNode({ id: nid, label: c.name, type: 'city' })
        addEdge(did, nid, '位于', strengthOf(c.score))
        mergeScore(nid, c.score)
        mergeRisk(nid, r.riskLevel)
      }
    } else if (r.city) {
      const nid = `city:${r.city}`
      addNode({ id: nid, label: r.city, type: 'city' })
      addEdge(did, nid, '位于', strengthOf(r.cityScore))
      mergeScore(nid, r.cityScore)
      mergeRisk(nid, r.riskLevel)
    }
  }

  return { nodes: [...nodes.values()], edges }
}
