/**
 * Rewrite Feedback 记录（Phase 2B）：rewrite/feedback RPC 落盘。
 * - 契约：docs/contracts/Resume-Feedback-Contract-v1.md（只记录事件，不学习）
 * - 域：系统行为事件（logs/feedback/），与 workspace 用户事实域隔离
 * - 隐私：仅存 hash，不落原文/改写文本/JD 全文
 * - 边界校验：RPC 入口（用户输入）fail fast
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REASONS = ['inaccurate_claim', 'wrong_direction', 'wording_preference', 'missing_context', 'other'] as const
const HASH_MAX = 64

export function recordRewriteFeedback(feedbackDir: string, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('rewrite/feedback 需要 params { requestId, action, selectedTextHash }')
  }
  const p = raw as Record<string, unknown>
  if (typeof p.requestId !== 'string' || p.requestId.length === 0) throw new Error('params.requestId 缺失')
  if (p.action !== 'apply' && p.action !== 'reject') throw new Error('params.action 应为 apply/reject')
  if (typeof p.selectedTextHash !== 'string' || p.selectedTextHash.length === 0 || p.selectedTextHash.length > HASH_MAX) {
    throw new Error('params.selectedTextHash 缺失或非法（SHA-256 截断，≤64 字符）')
  }
  let reason: string | undefined
  if (p.reason !== undefined) {
    if (typeof p.reason !== 'string' || !(REASONS as readonly string[]).includes(p.reason)) {
      throw new Error(`params.reason 应为 ${REASONS.join('/')}`)
    }
    reason = p.reason
  }
  let standardUsed: string | undefined
  if (p.standardUsed !== undefined) {
    if (typeof p.standardUsed !== 'string' || p.standardUsed.length === 0) throw new Error('params.standardUsed 应为非空字符串')
    standardUsed = p.standardUsed
  }

  const record = {
    time: new Date().toISOString(),
    requestId: p.requestId,
    action: p.action,
    selectedTextHash: p.selectedTextHash,
    ...(reason !== undefined ? { reason } : {}),
    ...(standardUsed !== undefined ? { standardUsed } : {}),
  }
  mkdirSync(feedbackDir, { recursive: true })
  appendFileSync(join(feedbackDir, 'rewrite-feedback.jsonl'), JSON.stringify(record) + '\n', 'utf8')
}
