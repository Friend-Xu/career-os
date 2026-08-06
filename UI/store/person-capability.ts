import type { Person } from '../types'

/**
 * Person Capability Gate：初始化完成（PROFILE_READY）前，依赖画像的「产生新行为」
 * 被门控——决策写入、简历派生、非初始化 Agent 会话发送。
 * 只控制产生新事实的能力，不控制读取历史（会话可切换可浏览）。
 * 浏览/设置/信息池/公司库恒开放，不建模。
 * 纯函数派生自 initStatus（引擎协议零改动）；未来引擎出现「部分就绪」再演进契约。
 */
export interface PersonCapability {
  canChat: boolean
  canDecisionWrite: boolean
  canResumeGenerate: boolean
}

export function derivePersonCapability(initStatus?: Person['initStatus']): PersonCapability {
  // undefined = M6.5 前存量档案（无 init_state 字段）——默认可用，只有显式 in_progress 才门控
  const ready = initStatus !== 'pending'
  return { canChat: ready, canDecisionWrite: ready, canResumeGenerate: ready }
}
