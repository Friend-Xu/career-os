/** Shared layout dimensions & visual tokens */

export const LAYOUT = {
  topBar: 60,
  statusBar: 32,
  iconNav: 80,
  secondaryMin: 160,
  /** 侧栏统一宽度（Finder 式：所有空间同一列宽，承载列表/过滤/记录库入口） */
  secondaryDefault: 268,
  secondaryMax: 268,
  agentPanel: 350,
  /** AI 面板收起态把手宽度（右侧竖条，点击呼出） */
  agentRail: 44,
  mainNarrow: 810,
  mainWide: 1160,
} as const

/**
 * App surface tokens — CSS variables switch with .light / .dark on <html>.
 * Defined in index.css (not theme styleOverrides — more reliable).
 *
 * Do NOT append hex alpha suffixes (e.g. `${COLORS.accent}18`) to these —
 * use `alpha(COLORS.x, 0.1)` or the solid hex palettes below.
 */
export const COLORS = {
  bg: 'var(--cos-bg)',
  bgElevated: 'var(--cos-bg-elevated)',
  bgHover: 'var(--cos-bg-hover)',
  bgActive: 'var(--cos-bg-active)',
  border: 'var(--cos-border)',
  borderStrong: 'var(--cos-border-strong)',
  accent: 'var(--cos-accent)',
  accentMuted: 'var(--cos-accent-muted)',
  text: 'var(--cos-text)',
  textSecondary: 'var(--cos-text-secondary)',
  textMuted: 'var(--cos-text-muted)',
  riskHigh: 'var(--cos-risk-high)',
  riskMedium: 'var(--cos-risk-medium)',
  riskLow: 'var(--cos-risk-low)',
  canvas: 'var(--cos-canvas)',
  onAccent: 'var(--cos-on-accent)',
  shadow: 'var(--cos-shadow)',
  /** 卡片分层阴影（极轻环境阴影：卡片从背景浮起而非贴平；浮层用 shadow） */
  cardShadow: 'var(--cos-card-shadow)',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace',
} as const

/** Solid hex risk colors — safe to use with hex-alpha suffixes like `${c}18`. */
export const RISK_COLOR = {
  low: '#7FD962',
  medium: '#E6B450',
  high: '#F07178',
} as const

export const RISK_LABEL = {
  low: '低',
  medium: '中',
  high: '高',
} as const

/**
 * Alpha helper that works with CSS variables AND hex colors.
 * @example alpha(COLORS.accent, 0.15)
 * @example alpha('#9081E4', 0.15)
 */
export function alpha(color: string, opacity: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, opacity)) * 100)
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/**
 * 统一缓动曲线（Linear 风格）——替代标准 ease。
 * 短促起步 + 长尾收尾，交互反馈"先快后稳"。
 */
export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * ADR-008：决策类型 → 视图名（决策链语义降级——决策不是链上阶段，是分析类型）。
 * 与引擎 decisionTypeOf 映射同源（direction→方向探索 等），UI 展示用。
 */
export const SKILL_VIEW_LABEL: Record<string, string> = {
  'career-path': '方向探索',
  'career-transition': '转行评估',
  'city-advisor': '城市评估',
  'company-screener': '公司筛选',
  'jd-analysis': 'JD分析',
  'resume-writing': '简历定制',
}

/**
 * Agent API 服务商预设（设置页 Base URL 一键填入）。
 * 只收录确认支持 Anthropic 兼容端点的服务商（DeepSeek 官方文档明示 /anthropic 端点；
 * 其余网关大多仅 OpenAI 兼容，不列以免误导）。
 */
export const PROVIDER_PRESETS: { id: string; label: string; desc: string; baseUrl: string }[] = [
  { id: 'anthropic', label: 'Anthropic 官方', desc: '默认端点', baseUrl: 'https://api.anthropic.com' },
  { id: 'deepseek', label: 'DeepSeek 兼容', desc: 'Anthropic 兼容端点，claude-* 模型名自动映射', baseUrl: 'https://api.deepseek.com/anthropic' },
]
