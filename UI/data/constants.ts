/** Shared layout dimensions & visual tokens */

export const LAYOUT = {
  topBar: 60,
  statusBar: 32,
  iconNav: 80,
  secondaryMin: 160,
  secondaryDefault: 200,
  secondaryMax: 240,
  agentPanel: 350,
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
