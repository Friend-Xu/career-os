/**
 * NBS Indicator Resolver（Phase 3 批次 B）：语义关键词 → 可信指标解析 + 歧义显式化。
 *
 * 两阶段：
 * - Stage 1 候选召回：curator 精确/别名命中（最高优先级）→ 树搜索兜底
 *   （分类名匹配的定向下钻，深度 ≤3——全树暴力下钻已实测不可行：超时 + WAF + 重名 ×79）
 * - Stage 2 可解释排序（只保留可计算分项，不做伪分数）：
 *   curator 命中 > 名称全名精确 > 前缀匹配 > 包含匹配；同级下叶子指标优先于中间节点
 *
 * Ambiguity Gate（不确定性显式化）：top1 不唯一/与 top2 分差不足 → 返回候选编号列表，
 * 绝不静默选——Agent 经 indicatorId 第二轮指认（消歧闭环）。
 */
import type { Logger } from '../../../logger.ts'
import type { NbsCatalogNode, NbsIndicator } from './api.ts'
import { NBS_PREWARM_THROTTLE_MS } from './api.ts'
import type { CuratorEntry } from './aliases.ts'

export interface ResolvedIndicator {
  indicatorId: string
  catalogId: string
  name: string
  /** 人类可读树路径（返回文本与候选展示用——证据可追溯） */
  path: string
  /** 解析置信（0-1，可解释：curator 精确 1 / 全名精确 0.9 / 前缀 0.7 / 包含 0.5） */
  confidence: number
}

export type ResolveResult =
  | { kind: 'resolved'; indicator: ResolvedIndicator }
  | { kind: 'candidates'; options: ResolvedIndicator[] }
  | { kind: 'miss' }

export interface ResolverTreeDeps {
  /** 顶级分类（节流由调用方纪律控制；测试注入 mock） */
  topCategories(): Promise<NbsCatalogNode[]>
  childrenOf(cid: string): Promise<NbsCatalogNode[]>
  indicatorsOf(cid: string): Promise<NbsIndicator[]>
}

export interface ResolverDeps {
  curator?: CuratorEntry[]
  tree?: ResolverTreeDeps
  logger?: Logger
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 名称匹配分（可解释排序分项） */
function nameScore(label: string, keyword: string): number {
  if (label === keyword) return 0.9
  if (label.startsWith(keyword)) return 0.7
  if (label.includes(keyword)) return 0.5
  return 0
}

/** 深度上限（定向下钻：分类名匹配的分支最多走 3 层——真机勘察树深 2-3） */
const MAX_DEPTH = 3
/** 候选上限 */
const MAX_CANDIDATES = 3
/** Gate 阈值：top1 与 top2 分差不足此值 → 歧义候选（不静默选） */
const AMBIGUITY_GAP = 0.2

export async function resolveIndicator(keyword: string, deps: ResolverDeps = {}): Promise<ResolveResult> {
  const q = keyword.trim()
  if (q.length === 0) return { kind: 'miss' }
  const curator = deps.curator ?? []
  // Stage 1a：curator 命中（语义名精确 = 1；别名 = 0.95——curated 资产最高优先）
  const exact = findCuratorExactIn(curator, q)
  if (exact !== undefined) {
    return resolveCuratorHit(curator, exact, q, 1)
  }
  const byAlias = findCuratorByAliasIn(curator, q)
  if (byAlias !== undefined) {
    return resolveCuratorHit(curator, byAlias, q, 0.95)
  }

  // Stage 1b：树搜索兜底（无 tree deps = 测试场景直接 miss）
  const tree = deps.tree
  if (tree === undefined) return { kind: 'miss' }
  const candidates: ResolvedIndicator[] = []
  let tops: NbsCatalogNode[] = []
  try {
    tops = await tree.topCategories()
  } catch {
    return { kind: 'miss' } // 树不可用（WAF/网络）→ miss（诚实失败，不走猜测）
  }
  // 分类名匹配优先分支（名称分 >0 的分类先下钻）
  const scoredTops = tops
    .map((t) => ({ node: t, score: nameScore(t._name ?? t.name ?? '', q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  const branchRoots = scoredTops.length > 0 ? scoredTops.map((x) => x.node) : tops
  const seen = new Set<string>()

  const walk = async (node: NbsCatalogNode, path: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || candidates.length >= MAX_CANDIDATES * 3) return
    const cid = node._id ?? ''
    if (cid === '' || seen.has(cid)) return
    seen.add(cid)
    await sleep(NBS_PREWARM_THROTTLE_MS)
    if (node.isLeaf === true) {
      let inds: NbsIndicator[] = []
      try {
        inds = await tree.indicatorsOf(cid)
      } catch {
        return // 单节点失败容忍（WAF 抖动不毁整个解析）
      }
      for (const i of inds) {
        const label = i.i_showname ?? i._name ?? i.name ?? ''
        const score = nameScore(label, q)
        if (score > 0) {
          const id = i._id ?? i.id ?? ''
          if (id !== '') {
            candidates.push({
              indicatorId: id,
              catalogId: cid,
              name: label,
              path: `${path} > ${node._name ?? ''}`.trim(),
              confidence: score,
            })
          }
        }
      }
      return
    }
    let kids: NbsCatalogNode[] = []
    try {
      kids = await tree.childrenOf(cid)
    } catch {
      return
    }
    // 分支内：节点名匹配分高的先走（定向下钻）
    const ordered = kids
      .map((k) => ({ node: k, score: nameScore(k._name ?? k.name ?? '', q) }))
      .sort((a, b) => b.score - a.score)
    for (const { node: k } of ordered.slice(0, 4)) {
      await walk(k, `${path} > ${node._name ?? ''}`, depth + 1)
    }
  }

  for (const root of branchRoots.slice(0, 4)) {
    await walk(root, '', 1)
  }

  // Stage 2：排序 + Gate
  const sorted = candidates.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CANDIDATES)
  if (sorted.length === 0) return { kind: 'miss' }
  const top = sorted[0]
  const second = sorted[1]
  if (top.confidence >= 0.9 || (second === undefined ? true : top.confidence - second.confidence >= AMBIGUITY_GAP)) {
    return { kind: 'resolved', indicator: top }
  }
  return { kind: 'candidates', options: sorted }
}

function toResolved(e: CuratorEntry, confidence: number): ResolvedIndicator {
  return { indicatorId: e.indicatorId, catalogId: e.catalogId, name: e.name, path: e.path, confidence }
}

/** 人均维度词检测（P4.5 强语义：口径变化——per_capita 查询 vs total 条目必须 Gate；不含 rate/share——
 *  无实战实例的维度后置，数据驱动扩展） */
export function wantsPerCapita(keyword: string): boolean {
  return /(人均|每人|平均每|per[\s-]*capita)/i.test(keyword)
}

/** 维度一致性 Gate：query 含人均词（口径变化）时，total 条目不得静默承接 per_capita 查询——
 *  - 同 path 存在 per_capita 兄弟条目 → 映射到兄弟（语义归一：人均地区生产总值 → 人均国内生产总值；
 *    置信降档 0.9——映射性命中低于直接别名命中，诚实降级）
 *  - 无兄弟 → candidates（歧义显式化，不静默选——携带原条目线索供指认） */
function resolveCuratorHit(curator: CuratorEntry[], hit: CuratorEntry, keyword: string, confidence: number): ResolveResult {
  if (wantsPerCapita(keyword) && hit.dimension !== 'per_capita') {
    const sibling = curator.find((e) => e.dimension === 'per_capita' && e.path === hit.path)
    if (sibling !== undefined) return { kind: 'resolved', indicator: toResolved(sibling, 0.9) }
    return { kind: 'candidates', options: [toResolved(hit, confidence)] }
  }
  return { kind: 'resolved', indicator: toResolved(hit, confidence) }
}

function findCuratorExactIn(list: CuratorEntry[], keyword: string): CuratorEntry | undefined {
  return list.find((e) => e.name === keyword)
}
/** 别名命中 = keyword 与别名精确相等或包含别名（单向：短词不误命中长别名）；
 *  多命中取最长别名（最具体优先）——「人均GDP」命中「人均GDP」而非「GDP」 */
function findCuratorByAliasIn(list: CuratorEntry[], keyword: string): CuratorEntry | undefined {
  let best: CuratorEntry | undefined
  let bestLen = 0
  for (const e of list) {
    for (const a of e.aliases) {
      if ((keyword === a || keyword.includes(a)) && a.length > bestLen) {
        best = e
        bestLen = a.length
      }
    }
  }
  return best
}
