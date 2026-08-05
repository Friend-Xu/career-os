/**
 * reference-validator（M4-4.2，契约 ARTIFACT-REFERENCE-PROTOCOL-M4-v0.1 §4）。
 * 三层校验（纯函数，resolve 注入）：
 *   Level 1 结构：artifact/objectType 白名单、scopeId 规则、cover-letter 不可作 target
 *   Level 2 存在性：target 当前存在（ReferenceInvalid 显式，无 fallback）
 *   Level 3 关系约束：supports = acyclic dependency edge——双向事实支撑拒绝
 */
import type { ArtifactLocator, ArtifactReference, LocatorResolution } from '../ir/reference.ts'

const ARTIFACTS = ['resume', 'portfolio', 'interview', 'cover-letter'] as const
const OBJECT_TYPES = ['fact', 'claim'] as const
const RELATIONS = ['supports'] as const

/** locator 相等判定（all fields）——循环检测/反向检测用 */
export function sameLocator(a: ArtifactLocator, b: ArtifactLocator): boolean {
  return a.artifact === b.artifact && a.objectType === b.objectType && a.objectId === b.objectId && (a.scopeId ?? '') === (b.scopeId ?? '')
}

export interface ValidateReferenceOptions {
  resolve: (loc: ArtifactLocator) => LocatorResolution // 注入 resolver（保持纯函数）
  existing: ArtifactReference[] // 已声明引用集合（Level 3 循环检测——来自 owner 声明，无 registry）
}

export interface ReferenceValidationResult {
  valid: boolean
  errors: string[]
}

/** Level 1：结构校验（artifact/objectType 白名单 + scopeId 规则 + Fact Layer 边界） */
export function structuralErrors(loc: ArtifactLocator, role: 'owner' | 'target'): string[] {
  const errors: string[] = []
  if (!(ARTIFACTS as readonly string[]).includes(loc.artifact)) {
    errors.push(`${role}.artifact 非法：${JSON.stringify(loc.artifact)}（合法值：${ARTIFACTS.join('/')}）`)
    return errors
  }
  if (!(OBJECT_TYPES as readonly string[]).includes(loc.objectType)) {
    errors.push(`${role}.objectType 非法：${JSON.stringify(loc.objectType)}（v0.1 白名单：fact/claim——Expression 引用不存在）`)
    return errors
  }
  if (loc.artifact === 'cover-letter') {
    errors.push(`${role} 位置不支持 cover-letter：无 Fact Layer 对象（unit 是 Expression，并轨待未来）`)
    return errors
  }
  if (loc.objectType === 'claim' && loc.artifact !== 'resume') {
    errors.push(`${role}.claim 仅存在于 resume（claim 是 Resume 特例）`)
  }
  if (loc.objectType === 'fact' && loc.artifact !== 'portfolio' && loc.artifact !== 'interview') {
    errors.push(`${role}.fact 仅存在于 portfolio/interview`)
  }
  if (loc.objectType === 'fact' && loc.artifact !== 'resume' && !loc.scopeId) {
    errors.push(`${role} 的 fact 引用必须带 scopeId（Local Addressing：portfolio/projectA/fact_001）`)
  }
  return errors
}

/** 三层校验：结构 + 存在性 + supports 反向（纯函数，resolve/existing 注入） */
export function validateReference(ref: ArtifactReference, opts: ValidateReferenceOptions): ReferenceValidationResult {
  const errors: string[] = []
  // Level 1：结构
  errors.push(...structuralErrors(ref.owner, 'owner'))
  errors.push(...structuralErrors(ref.target, 'target'))
  if (!(RELATIONS as readonly string[]).includes(ref.relation)) {
    errors.push(`relation 非法：${JSON.stringify(ref.relation)}（v0.1 唯一实现：supports）`)
  }
  // Level 2：存在性（target 必须当前存在——ReferenceInvalid 显式，无 fallback/stale）
  if (errors.length === 0) {
    const resolution = opts.resolve(ref.target)
    if (!resolution.exists) {
      errors.push(`ReferenceInvalid：target 不存在（${resolution.error ?? '断链'}）`)
    }
  }
  // Level 3：supports = acyclic dependency edge——target 侧已存在指向 owner 的 supports → 拒绝
  if (errors.length === 0 && ref.relation === 'supports') {
    const reverse = opts.existing.some(
      (r) => r.relation === 'supports' && sameLocator(r.owner, ref.target) && sameLocator(r.target, ref.owner),
    )
    if (reverse) {
      errors.push('循环引用拒绝：supports 是 acyclic dependency edge——双向事实支撑不允许（mentions 无此约束，future）')
    }
  }
  return { valid: errors.length === 0, errors }
}
