import { Box } from '@mui/material'
import { useEffect } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS } from '../../data/constants'
import { TopBar } from './top-bar'
import { IconNav } from './icon-nav'
import { SecondarySidebar } from './secondary-sidebar'
import { AgentPanel } from './agent-panel'
import { AgentPanelTab } from './agent-panel-tab'
import { StatusBar } from './status-bar'
import { CommandPalette } from './command-palette'
import { PersonSwitchDialog } from './person-switch-dialog'
import { PersonCreateDialog } from './person-create-dialog'
import { WorkbenchPage } from '../../pages/workbench-page'
import { AgentPage } from '../../pages/agent-page'
import { InfoPoolPage } from '../../pages/infopool-page'
import { CompaniesPage } from '../../pages/companies-page'
import { JobsPage } from '../../pages/jobs-page'
import { ApplicationsPage } from '../../pages/applications-page'
import { ResumesPage } from '../../pages/resumes-page'
import { SettingsPage } from '../../pages/settings-page'

function MainContent() {
  const page = useAppStore((s) => s.currentPage)
  switch (page) {
  case 'workbench':
    return <WorkbenchPage />
  case 'agent':
    return <AgentPage />
  case 'infopool':
    return <InfoPoolPage />
  case 'companies':
    return <CompaniesPage />
  case 'jobs':
    return <JobsPage />
  case 'applications':
    return <ApplicationsPage />
  case 'resumes':
    return <ResumesPage />
  case 'settings':
    return <SettingsPage />
  default:
    return <WorkbenchPage />
  }
}

/** 计算 hex 颜色感知亮度（0-1），决定强调色按钮上的文字用深/浅。 */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function AppShell() {
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const toggleAgentPanel = useAppStore((s) => s.toggleAgentPanel)
  const setPage = useAppStore((s) => s.setPage)
  const createSession = useAppStore((s) => s.createSession)
  const currentPage = useAppStore((s) => s.currentPage)
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen)
  const person = useAppStore((s) => s.currentPerson())

  // 人的主题色 = 全局强调色（方案书 3.2）：切人即换界面强调色；短暂开启全站过渡避免瞬时跳变（6.7）
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--cos-accent', person.color)
    root.style.setProperty('--cos-accent-muted', alpha(person.color, 0.14))
    root.style.setProperty(
      '--cos-on-accent',
      luminance(person.color) > 0.6 ? '#1a1a1e' : '#ffffff',
    )
    root.classList.add('cos-theme-transition')
    const t = setTimeout(() => root.classList.remove('cos-theme-transition'), 400)
    return () => clearTimeout(t)
  }, [person.color])

  // Global shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
      }
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleAgentPanel()
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        setPage('settings')
      }
      if (meta && e.key.toLowerCase() === 'n' && currentPage === 'agent') {
        e.preventDefault()
        createSession()
      }
      if (meta && e.key >= '1' && e.key <= '6') {
        e.preventDefault()
        const pages = ['workbench', 'agent', 'infopool', 'companies', 'jobs', 'applications'] as const
        setPage(pages[Number(e.key) - 1])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setCommandPaletteOpen, toggleAgentPanel, setPage, createSession, currentPage])

  // AI 面板交互模型：Agent 页主区即 AI（无面板区）；设置页隐藏。
  // 其余页面默认收起 → 44px 把手；显式动作（把手/⌘B/AI 动作）展开 → 350px Dock。
  const panelZone = currentPage !== 'agent' && currentPage !== 'settings'
  const showAgent = agentPanelOpen && panelZone
  const showAgentTab = !agentPanelOpen && panelZone

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: COLORS.bg,
        color: COLORS.text,
        overflow: 'hidden',
        minWidth: 1280,
      }}
    >
      <TopBar />

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <IconNav />
        <div className="cos-print-hidden" style={{ display: 'contents' }}>
          <SecondarySidebar />
        </div>

        <Box
          component="main"
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            bgcolor: COLORS.bg,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <MainContent />
        </Box>

        {showAgent && (
          <div className="cos-print-hidden" style={{ display: 'contents' }}>
            <AgentPanel />
          </div>
        )}
        {showAgentTab && (
          <div className="cos-print-hidden" style={{ display: 'contents' }}>
            <AgentPanelTab />
          </div>
        )}
      </Box>

      <StatusBar />
      <CommandPalette />
      <PersonSwitchDialog />
      <PersonCreateDialog />
    </Box>
  )
}
