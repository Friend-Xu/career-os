import { useEffect, useRef, useState } from 'react'

interface UseSessionScrollOptions {
  sessionId?: string
  messageCount: number
  /** 流式内容增长信号（最后一条消息 content.length——流式累积不增加 messageCount，靠它执行跟随检查） */
  contentTick: number
  /** 任务运行中：流式期间持续跟随（近底时） */
  streaming: boolean
  /** 容器展开态（面板折叠→展开时滚底；页面恒 true） */
  open?: boolean
  /** 距底小于该值视为"正在底部"（px） */
  threshold?: number
}

/**
 * 会话滚动管理（Session Rendering Layer）：打开/切换会话滚到底；新内容到达时
 * 近底自动跟随、远底不打扰（阅读保护，记录新消息数）；用户手动回底清除提示。
 * 滚动位置是 View 层状态——不写入 session 数据。
 */
export function useSessionScroll({
  sessionId,
  messageCount,
  contentTick,
  streaming,
  open = true,
  threshold = 80,
}: UseSessionScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [newCount, setNewCount] = useState(0)
  /** 用户最后一次在底部时看到的 messageCount（上滚后新消息数的计算基准） */
  const lastSeenRef = useRef(messageCount)

  const nearBottom = () => {
    const el = containerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }

  const scrollToLatest = () => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastSeenRef.current = messageCount
    setHasNewContent(false)
    setNewCount(0)
  }

  // 挂载 / 打开 / 切换会话 → 无条件滚到底（看到最新）
  useEffect(() => {
    scrollToLatest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, open])

  // 新内容到达（消息数增加 / 流式内容增长 / 任务状态变化）：近底跟随；远底阅读保护 + 计数
  useEffect(() => {
    if (nearBottom()) {
      scrollToLatest()
    } else if (messageCount > lastSeenRef.current) {
      setHasNewContent(true)
      setNewCount(messageCount - lastSeenRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount, contentTick, streaming])

  // 用户手动滚回底部 → 清除提示（scrollToLatest 的兜底，覆盖"不点按钮直接滚回"场景）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
        setHasNewContent(false)
        setNewCount(0)
        lastSeenRef.current = messageCount
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [messageCount, threshold])

  return { containerRef, scrollToLatest, hasNewContent, newCount }
}
