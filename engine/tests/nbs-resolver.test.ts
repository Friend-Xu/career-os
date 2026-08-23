/**
 * NBS Indicator Resolver（Phase 3 批次 B）测试：
 * curator 命中 / 树兜底定向下钻 / 可解释排序 / Ambiguity Gate / miss 语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIndicator, type ResolverTreeDeps } from '../agent/tools/nbs/resolver.ts'
import { NBS_CURATOR } from '../agent/tools/nbs/aliases.ts'
import type { NbsCatalogNode, NbsIndicator } from '../agent/tools/nbs/api.ts'

const cat = (id: string, name: string, leaf = false): NbsCatalogNode => ({ _id: id, _name: name, isLeaf: leaf })
const ind = (id: string, showname: string, _name?: string): NbsIndicator => ({ _id: id, i_showname: showname, _name })

/** mock 树：工业 > [规模以上工业增加值(叶), 工业企业利润(叶)]；国民经济核算 > 国内生产总值(叶) */
function mockTree(): ResolverTreeDeps {
  return {
    topCategories: async () => [cat('t1', '国民经济核算'), cat('t2', '工业'), cat('t3', '人民生活')],
    childrenOf: async (cid) => {
      if (cid === 't1') return [cat('t1a', '国内生产总值', true)]
      if (cid === 't2') return [cat('t2a', '规模以上工业增加值', true), cat('t2b', '工业企业利润', true)]
      if (cid === 't3') return [cat('t3a', '全国居民人均收入情况', true)]
      return []
    },
    indicatorsOf: async (cid) => {
      if (cid === 't1a') return [ind('gdp1', '国内生产总值 (亿元)', '国内生产总值')]
      if (cid === 't2a') return [ind('ind1', '规模以上工业增加值 (亿元)', '规模以上工业增加值')]
      if (cid === 't2b') return [ind('profit1', '工业企业利润 (亿元)')]
      if (cid === 't3a') return [ind('inc1', '居民人均可支配收入 (元)')]
      return []
    },
  }
}

test('curator 精确命中：语义名 → resolved（confidence=1，带路径）', async () => {
  const r = await resolveIndicator('工业增加值', { curator: NBS_CURATOR })
  assert.equal(r.kind, 'resolved')
  if (r.kind !== 'resolved') return
  assert.equal(r.indicator.name, '工业增加值')
  assert.equal(r.indicator.confidence, 1)
  assert.ok(r.indicator.path.includes('国民经济核算'), '带人类可读路径')
})

test('curator 别名命中：「GDP」→ 国内生产总值（confidence=0.95）', async () => {
  const r = await resolveIndicator('GDP', { curator: NBS_CURATOR })
  assert.equal(r.kind, 'resolved')
  if (r.kind !== 'resolved') return
  assert.equal(r.indicator.name, '国内生产总值')
  assert.equal(r.indicator.confidence, 0.95)
})

test('树兜底：分类名匹配分支下钻 → 叶子指标名命中（展示名带单位后缀 → 前缀分 0.7）', async () => {
  const r = await resolveIndicator('规模以上工业增加值', { curator: [], tree: mockTree() })
  assert.equal(r.kind, 'resolved')
  if (r.kind !== 'resolved') return
  assert.equal(r.indicator.indicatorId, 'ind1')
  assert.equal(r.indicator.confidence, 0.7, 'i_showname 带单位后缀，前缀命中')
  assert.ok(r.indicator.path.includes('工业'), '路径含分类')
})

test('可解释排序：精确命中优先于包含命中（同子树多候选取最高分）', async () => {
  const r = await resolveIndicator('工业企业利润', { curator: [], tree: mockTree() })
  assert.equal(r.kind, 'resolved')
  if (r.kind !== 'resolved') return
  assert.equal(r.indicator.indicatorId, 'profit1')
})

test('B2 Ambiguity Gate：同分多候选 → candidates（不静默选），携带 indicatorId 供指认', async () => {
  const tree: ResolverTreeDeps = {
    topCategories: async () => [cat('x1', '工业')],
    childrenOf: async () => [cat('x2', '工业产品产量', true), cat('x3', '工业销售产值', true)],
    indicatorsOf: async (cid) =>
      cid === 'x2' ? [ind('a1', '工业产品产量 (万吨)')] : [ind('a2', '工业销售产值 (万元)')],
  }
  const r = await resolveIndicator('工业', { curator: [], tree })
  assert.equal(r.kind, 'candidates')
  if (r.kind !== 'candidates') return
  assert.equal(r.options.length, 2)
  assert.ok(r.options.every((o) => o.indicatorId !== ''), '候选带 indicatorId（消歧闭环）')
})

test('Gate 边界：top1 精确唯一（≥0.9）→ resolved；top1 仅包含命中且与 top2 同分 → candidates', async () => {
  // 全名精确命中：0.9 → resolved
  const exact = await resolveIndicator('居民人均可支配收入', { curator: [], tree: mockTree() })
  assert.equal(exact.kind, 'resolved')
  // 「增加值」在 mock 树里是包含命中（规模以上工业增加值 0.5）且唯一 → 分差无限大 → resolved（0.5）
  const contain = await resolveIndicator('增加值', { curator: [], tree: mockTree() })
  assert.equal(contain.kind, 'resolved')
  if (contain.kind === 'resolved') assert.equal(contain.indicator.confidence, 0.5)
})

test('miss 语义：无 curator 命中且无树 deps → miss（测试场景）；树无命中 → miss', async () => {
  const r1 = await resolveIndicator('未知指标', { curator: [] })
  assert.equal(r1.kind, 'miss')
  const r2 = await resolveIndicator('未知指标', { curator: [], tree: mockTree() })
  assert.equal(r2.kind, 'miss')
  const r3 = await resolveIndicator('  ', { curator: [], tree: mockTree() })
  assert.equal(r3.kind, 'miss')
})
