/**
 * 侧栏（Finder 式上下文展开栏）：随当前空间变化——展示该空间的列表/过滤/记录库入口。
 * 空间切换由 IconNav 承担（唯一导航），本栏是选中空间的「展开」，主区是选中条目的详情。
 */
import { Box } from '@mui/material'
import { COLORS, LAYOUT } from '../../data/constants'
import { useAppStore } from '../../store/app-store'
import { WorkbenchSidebar } from './sidebars/workbench-sidebar'
import { AgentSidebar } from './sidebars/agent-sidebar'
import { InfoPoolSidebar } from './sidebars/infopool-sidebar'
import { CompaniesSidebar } from './sidebars/companies-sidebar'
import { JobsSidebar } from './sidebars/jobs-sidebar'
import { ApplicationsSidebar } from './sidebars/applications-sidebar'
import { ResumesSidebar } from './sidebars/resumes-sidebar'
import { ArtifactsSidebar } from './sidebars/artifacts-sidebar'

export function SecondarySidebar() {
  const page = useAppStore((s) => s.currentPage)

  return (
    <Box
      component="aside"
      sx={{
        width: LAYOUT.secondaryDefault,
        minWidth: LAYOUT.secondaryDefault,
        borderRight: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {page === 'workbench' && <WorkbenchSidebar />}
      {page === 'agent' && <AgentSidebar />}
      {page === 'infopool' && <InfoPoolSidebar />}
      {page === 'companies' && <CompaniesSidebar />}
      {page === 'jobs' && <JobsSidebar />}
      {page === 'applications' && <ApplicationsSidebar />}
      {page === 'resumes' && <ResumesSidebar />}
      {page === 'artifacts' && <ArtifactsSidebar />}
      {page === 'settings' && null}
    </Box>
  )
}
