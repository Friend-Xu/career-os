import { create } from 'zustand'
import type { NavPageId } from '../types'

export type AttentionLevel = 'success' | 'warning' | 'info'
export type WorkbenchView = 'dashboard' | 'directions' | 'cities' | 'decisions' | 'profile'
/**
 * 来源分层：Attention 是「行动入口层」，生产方分两类——
 * - system：系统状态事件（规则驱动，本轮实现）
 * - agent：Agent 洞察（未来经 Recommendation Engine 过滤/去重/生命周期判断后接入，
 *   不直接控制提示——Agent 输出不一定是任务）
 */
export type AttentionSource = 'system' | 'agent'

/** 需要用户注意的系统事件 + 行动入口（Attention Layer 基础模块，非业务组件）。
 *  与 toast 的区别：toast 瞬时反馈自动消失；attention 持久等待用户处理（跳转/关闭）。
 *  生命周期：runtime 内存态（不持久化）；关闭后刷新重新提示（导航角标仍在引导）。 */
export interface AttentionItem {
  id: string
  level: AttentionLevel
  title: string
  description?: string
  /** 点击跳转目标（本地 state 导航：页面 + 可选子视图）；缺省 = 仅提示可关闭 */
  target?: { page: NavPageId; view?: WorkbenchView }
  source: AttentionSource
  /** 来源事件溯源（agent 通道接入后绑定 Recommendation id） */
  originId?: string
  createdAt: number
}

interface AttentionState {
  attention: AttentionItem | null
  /** 全局唯一：新事件覆盖旧事件（用户同一时刻只处理最重要的一个） */
  addAttention: (item: Omit<AttentionItem, 'createdAt'>) => void
  dismissAttention: () => void
}

export const useAttentionStore = create<AttentionState>((set) => ({
  attention: null,
  addAttention: (item) => set({ attention: { ...item, createdAt: Date.now() } }),
  dismissAttention: () => set({ attention: null }),
}))
