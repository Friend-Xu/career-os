/**
 * NBS curator 核心指标表（Indicator Resolver 的语义映射资产）：
 * 职业决策高频指标的手工 curated 映射（名称/别名/树路径/精确 id）。
 * - 来源纪律：indicatorId/catalogId 必须真机定向验证后写入（2026-08 已验 4 条；
 *   新增条目先用 .local probe 验证 id 再进表——不凭猜测写死）
 * - 覆盖哲学：只 curator 高频指标（~数十条），树搜索兜底其余——全量手工表不可维护，
 *   全树暴力搜索已实测不可行（超时 + WAF + 重名 ×79）
 * - 口径诚实：城市级 GDP 不属国家数据年度口径（真机勘察事实）——查询时如实降级提示
 */

export interface CuratorEntry {
  /** 语义名（用户/Agent 口语） */
  name: string
  /** 别名（包含匹配即命中） */
  aliases: string[]
  /** 树路径（人类可读，返回文本与候选展示用） */
  path: string
  /** 指标 id（定向验证值） */
  indicatorId: string
  /** 叶子分类 id */
  catalogId: string
  /** 口径说明（查询时随结果/降级提示呈现） */
  note?: string
  /** 口径维度（P4.5 维度一致性 Gate）：缺省 = total（总量口径）；
   *  per_capita 必须显式标注——查询含人均词时，total 条目不得静默承接（维度 Gate 拦截） */
  dimension?: 'total' | 'per_capita'
}

export const NBS_CURATOR: CuratorEntry[] = [
  {
    name: '国内生产总值',
    aliases: ['GDP', '地区生产总值', '生产总值'],
    path: '国民经济核算 > 国内生产总值',
    indicatorId: '7dc6a2ee6c614960b7059991e0cc4d96',
    catalogId: 'f7fd25aaad184414875632cf2327da60',
    note: '城市级 GDP 不属国家数据年度口径——城市查询请改用省级或相关产业指标',
  },
  {
    name: '人均国内生产总值',
    aliases: ['人均GDP', '人均生产总值'],
    path: '国民经济核算 > 国内生产总值',
    indicatorId: 'eb4d93f19d57495c89f98875e03e01be',
    catalogId: 'f7fd25aaad184414875632cf2327da60',
    dimension: 'per_capita',
    note: '城市级人均 GDP 不属国家数据年度口径——城市查询请改用省级或相关产业指标',
  },
  {
    name: '居民人均可支配收入',
    aliases: ['人均可支配收入', '居民收入', '可支配收入'],
    path: '人民生活 > 全国居民人均收入情况',
    indicatorId: '305bba1e881e413b91f32a06a4be65fd',
    catalogId: 'd153132154a549a78363017ef74ca784',
    dimension: 'per_capita',
  },
  {
    name: '社会消费品零售总额',
    aliases: ['社零', '社会消费品零售'],
    path: '社会消费品零售总额',
    indicatorId: '008350880eb14928acc53fe20b295415',
    catalogId: 'd5b51c4a56d646b3b3f00f2c9e31a217',
  },
  {
    name: '工业增加值',
    aliases: ['规模以上工业增加值', '规上工业增加值'],
    path: '国民经济核算 > 分行业增加值',
    indicatorId: '1e344d8fa0d040f88e80b5bf0b56dbac',
    catalogId: 'eb1beae0a5d9480ba195a624ec7ada43',
  },
]

/** curator 精确命中（语义名全等）；别名命中（包含） */
export function findCuratorExact(keyword: string): CuratorEntry | undefined {
  const q = keyword.trim()
  if (q.length === 0) return undefined
  return NBS_CURATOR.find((e) => e.name === q)
}

/** curator 别名命中：keyword 与别名精确相等，或 keyword 包含别名（如「苏州GDP」包含「GDP」）。
 *  单向包含——短关键词（「工业」）不得误命中长别名（「规模以上工业增加值」）；
 *  多命中取**最长**别名（最具体优先）——「人均GDP」应命中「人均GDP」而非「GDP」，不按表序先到先得。 */
export function findCuratorByAlias(keyword: string): CuratorEntry | undefined {
  const q = keyword.trim()
  if (q.length === 0) return undefined
  let best: CuratorEntry | undefined
  let bestLen = 0
  for (const e of NBS_CURATOR) {
    for (const a of e.aliases) {
      if ((q === a || q.includes(a)) && a.length > bestLen) {
        best = e
        bestLen = a.length
      }
    }
  }
  return best
}
