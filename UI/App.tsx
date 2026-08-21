import { useEffect, useRef } from 'react'
import { AppShell } from './components/layout/app-shell'
import { GlobalAttentionCard } from './components/layout/global-attention-card'
import { ToastHost } from './components/toast-host'
import { PermissionDialog } from './components/permission-dialog'
import { connectEngine, useAppStore } from './store/app-store'
import { useAttentionStore } from './store/attention-store'
import { deriveNavigationState } from './store/navigation-state'

/**
 * 导航推荐状态 → 引导卡片（会话级一次）：
 * 存在 recommended 角标（如方向未探索 → 工作台 ✨）时，进入系统弹一次引导卡。
 * 事件卡（初始化完成等）优先——已有卡片时不覆盖；用户处理完事件卡后自动接上。
 * 关闭后本会话不再弹（角标持续引导）；刷新 = 新会话重新弹。
 * 方向决策产生（推荐状态消失）后不再出现。
 */
function useNavRecommendationCard(): void {
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)
  const resumes = useAppStore((s) => s.resumeVersions)
  const attentionId = useAttentionStore((s) => s.attention?.id)
  const shownRef = useRef(false)

  useEffect(() => {
    if (shownRef.current) return
    const nav = deriveNavigationState(person, decisions, resumes)
    if (nav.workbench?.kind !== 'recommended') return
    if (useAttentionStore.getState().attention !== null) return // 事件卡优先
    useAttentionStore.getState().addAttention({
      id: 'nav-recommend-workbench',
      level: 'info',
      title: '可以开始探索职业方向',
      description: '基于当前档案状态，这是最值得开始的一步',
      target: { page: 'workbench', view: 'directions' },
      source: 'system',
    })
    shownRef.current = true
  }, [person, decisions, resumes, attentionId])
}

export default function App() {
  useEffect(() => {
    connectEngine()
  }, [])
  useNavRecommendationCard()

  return (
    <>
      <AppShell />
      <GlobalAttentionCard />
      <ToastHost />
      <PermissionDialog />
    </>
  )
}
