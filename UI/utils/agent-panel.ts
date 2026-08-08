import type { NavPageId } from '../types'

/**
 * Agent Panel availability（单一事实源——app-shell 渲染条件与 store toggle 共用，
 * 防止「显示入口 ≠ 可执行能力」漂移）。
 *
 * 两层判定，对应两个不同问题：
 * - hasAgentPanelZone：页面是否**有面板区**（dock 可渲染）。无面板区 = 主区即 AI（agent）
 *   / 纯设置页（settings）。「无面板区」≠「AI 不可用」——resumes/infopool 的 AI 动作
 *   （startAnalysis）仍可唤起面板。
 * - canShowAgentPanelRail：是否显示**常驻把手**。resumes/infopool 是全屏主区，面板由
 *   页面内 AI 按钮唤起，无常驻入口；普通工作页显示把手。
 */
const NO_PANEL_PAGES: NavPageId[] = ['agent', 'settings']
const ACTION_DRIVEN_PANEL_PAGES: NavPageId[] = ['resumes', 'infopool']

export function hasAgentPanelZone(page: NavPageId): boolean {
  return !NO_PANEL_PAGES.includes(page)
}

export function canShowAgentPanelRail(page: NavPageId): boolean {
  return hasAgentPanelZone(page) && !ACTION_DRIVEN_PANEL_PAGES.includes(page)
}
