import { Box } from '@mui/material'
import { useEffect } from 'react'
import { useAppStore } from '../../store/app-store'
import { COLORS } from '../../data/constants'
import { TopBar } from './top-bar'
import { IconNav } from './icon-nav'
import { SecondarySidebar } from './secondary-sidebar'
import { AgentPanel } from './agent-panel'
import { StatusBar } from './status-bar'
import { CommandPalette } from './command-palette'
import { RoleSwitchDialog } from './role-switch-dialog'
import { WorkbenchPage } from '../../pages/workbench-page'
import { AgentPage } from '../../pages/agent-page'
import { InfoPoolPage } from '../../pages/infopool-page'
import { CompaniesPage } from '../../pages/companies-page'
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

export function AppShell() {
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const toggleAgentPanel = useAppStore((s) => s.toggleAgentPanel)
  const setPage = useAppStore((s) => s.setPage)
  const createSession = useAppStore((s) => s.createSession)
  const currentPage = useAppStore((s) => s.currentPage)
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen)

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
        const pages = ['workbench', 'agent', 'infopool', 'companies', 'applications', 'resumes'] as const
        setPage(pages[Number(e.key) - 1])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setCommandPaletteOpen, toggleAgentPanel, setPage, createSession, currentPage])

  const showAgent =
    agentPanelOpen && currentPage !== 'agent' && currentPage !== 'resumes' && currentPage !== 'settings'

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
        <SecondarySidebar />

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

        {showAgent && <AgentPanel />}
      </Box>

      <StatusBar />
      <CommandPalette />
      <RoleSwitchDialog />
    </Box>
  )
}
