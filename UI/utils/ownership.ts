/**
 * 归属判断（ADR-013 单身份源）：personId 稳定标识优先，profile 人名兜底（存量迁移态）。
 * 双方都有 personId 才用精确比较（mock person 无 personId 时回退 profile）；
 * 迁移完成（M7 删除 profile 字段）后退化为 personId 单一比较。
 */
export function belongsToPerson(
  entity: { personId?: string; profile?: string },
  person: { personId?: string; name: string },
): boolean {
  if (entity.personId && person.personId) return entity.personId === person.personId
  return entity.profile === person.name
}
