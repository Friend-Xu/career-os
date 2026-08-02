/**
 * gap-calculator：V2 差距分析纯函数（知识层派生视图，幂等可测）。
 *
 * 输入：目标 Role 技能矩阵 + 某人的技能声明（PersonSkill[]）+ 技能词表（别名归一化用）
 * → GapResult：
 * - satisfied：声明技能命中 Role 需求且 level ≥ 3（可独立产出）
 * - transferable：命中但 level 1-2（有基础需补强）
 * - missing：未声明（SkillGap：需求名/essential/source/模板化 action）
 *
 * 匹配规则：以词表别名归一化反查——声明"机械设计"可命中 Role 需求"结构设计"
 * （同词表技能互为别名）；词表外的自由技能按名精确匹配。
 * 引擎不自己打分（只做清单分类，不产出分数/结论）；分数是 skill/Agent 分析产出。
 */
import type { GapResult, PersonSkill, Role, Skill, SkillGap } from '../ir/schema.ts'
import { buildSkillIndex } from '../storage/knowledge-watcher.ts'

/** 未声明技能的学习动作模板（missing 的 SkillGap.action） */
export function missingAction(name: string): string {
  return `学习 ${name} 基础（目标 2 级）`
}

/** 有基础（transferable）技能的补强动作模板（契约 transferable 条目不带 action 字段，供 UI/Agent 细化展示） */
export function transferableAction(name: string): string {
  return `补强 ${name} 至 3 级（案例练习）`
}

export function computeGap(opts: {
  role: Role
  person: string
  personSkills: PersonSkill[]
  skills: Skill[] // 词表（别名归一化反查）
}): GapResult {
  const { role, person, personSkills, skills } = opts
  const index = buildSkillIndex(skills)

  // 声明技能按规范名索引（同义词声明取级别最高者，避免顺序依赖）
  const declared = new Map<string, PersonSkill>()
  for (const ps of personSkills) {
    const canonical = index.get(ps.name) ?? ps.name
    const cur = declared.get(canonical)
    if (!cur || ps.level > cur.level) declared.set(canonical, ps)
  }

  const satisfied: { name: string; level: number }[] = []
  const transferable: { name: string; level: number }[] = []
  const missing: SkillGap[] = []
  for (const req of role.skills) {
    const canonical = index.get(req.name) ?? req.name
    const hit = declared.get(canonical)
    if (hit) {
      // 同一声明命中多个需求只列一次（satisfied 与 transferable 各自去重）
      const bucket = hit.level >= 3 ? satisfied : transferable
      if (!bucket.some((e) => e.name === hit.name)) bucket.push({ name: hit.name, level: hit.level })
    } else {
      missing.push({ name: req.name, essential: req.essential, source: req.source, action: missingAction(req.name) })
    }
  }
  return { role, person, satisfied, transferable, missing }
}
