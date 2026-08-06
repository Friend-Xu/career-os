import { Box, Tooltip, Divider } from '@mui/material'
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import HubOutlinedIcon from '@mui/icons-material/HubOutlined'
import ApartmentOutlinedIcon from '@mui/icons-material/ApartmentOutlined'
import WorkIcon from '@mui/icons-material/Work'
import ViewKanbanOutlinedIcon from '@mui/icons-material/ViewKanbanOutlined'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import FolderCopyOutlinedIcon from '@mui/icons-material/FolderCopyOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import type { ComponentType } from 'react'
import type { SvgIconProps } from '@mui/material/SvgIcon'
import type { NavPageId } from '../../types'
import { useAppStore } from '../../store/app-store'
import { deriveNavigationState } from '../../store/navigation-state'
import type { NavAttention } from '../../store/navigation-state'
import { COLORS, EASE, LAYOUT } from '../../data/constants'

interface NavItem {
  id: NavPageId;
  label: string;
  icon: ComponentType<SvgIconProps>;
  shortcut: string;
}

const MAIN_NAV: NavItem[] = [
  { id: 'workbench', label: '工作台', icon: HomeOutlinedIcon, shortcut: '⌘1' },
  { id: 'agent', label: '决策 Agent', icon: AutoAwesomeOutlinedIcon, shortcut: '⌘2' },
  { id: 'infopool', label: '信息池', icon: HubOutlinedIcon, shortcut: '⌘3' },
  { id: 'jobs', label: 'JD', icon: WorkIcon, shortcut: '⌘4' },
  { id: 'companies', label: '公司探索', icon: ApartmentOutlinedIcon, shortcut: '⌘5' },
  { id: 'applications', label: '投递管理', icon: ViewKanbanOutlinedIcon, shortcut: '⌘6' },
  { id: 'artifacts', label: 'Artifact Studio', icon: FolderCopyOutlinedIcon, shortcut: '⌘7' },
  { id: 'resumes', label: '简历中心', icon: DescriptionOutlinedIcon, shortcut: '⌘8' },
]

const SHORT_LABEL: Record<NavPageId, string> = {
  workbench: '工作台',
  agent: 'Agent',
  infopool: '信息池',
  companies: '公司',
  jobs: 'JD',
  applications: '投递',
  artifacts: 'Artifacts',
  resumes: '简历',
  settings: '设置',
}

/** 导航角标：推荐（accent 呼吸 + 挂载脉冲）/ 等待（灰点）/ 完成（绿勾） */
function NavBadge({ attention }: { attention: NavAttention }) {
  if (attention.kind === 'completed') {
    return (
      <Box
        sx={{
          position: 'absolute',
          top: 7,
          right: 7,
          minWidth: 15,
          height: 15,
          px: 0.25,
          borderRadius: '999px',
          display: 'grid',
          placeItems: 'center',
          bgcolor: COLORS.riskLow,
          color: '#fff',
          fontSize: 9.5,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {attention.detail ?? '✓'}
      </Box>
    )
  }
  const pulse = attention.kind === 'recommended'
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: pulse ? COLORS.accent : COLORS.textMuted,
        boxShadow: `0 0 0 2px ${COLORS.bg}`,
        // 挂载时脉冲 2 次（CSS animation 只在元素挂载时执行一次）→ 回落为持续呼吸
        animation: pulse
          ? 'cos-attention-pulse 1.2s ease-out, cos-thinking-dot 2.4s ease-in-out infinite 1.2s'
          : undefined,
      }}
    />
  )
}

export function IconNav() {
  const currentPage = useAppStore((s) => s.currentPage)
  const setPage = useAppStore((s) => s.setPage)
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)
  const resumes = useAppStore((s) => s.resumes)
  const nav = deriveNavigationState(person, decisions, resumes)

  return (
    <Box
      component="nav"
      sx={{
        width: LAYOUT.iconNav,
        minWidth: LAYOUT.iconNav,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        py: 1.5,
        gap: 0.5,
        borderRight: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bg,
        zIndex: 15,
      }}
    >
      {MAIN_NAV.map((item) => {
        const active = currentPage === item.id
        const Icon = item.icon
        const attention = nav[item.id as keyof typeof nav]
        return (
          <Tooltip
            key={item.id}
            title={`${item.label} ${item.shortcut}${attention ? ` · ${attention.reason}` : ''}`}
            placement="right"
          >
            <Box
              component="button"
              onClick={() => setPage(item.id)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              sx={{
                width: 52,
                height: 52,
                border: 'none',
                borderRadius: '10px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.25,
                cursor: 'pointer',
                bgcolor: active ? COLORS.accentMuted : 'transparent',
                color: active ? COLORS.accent : COLORS.textSecondary,
                transition: `background-color 0.2s ${EASE}, color 0.2s ${EASE}`,
                position: 'relative',
                '&:hover': {
                  bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
                  color: active ? COLORS.accent : COLORS.text,
                },
                '&::before': active
                  ? {
                    content: '""',
                    position: 'absolute',
                    left: -6,
                    width: 3,
                    height: 20,
                    borderRadius: 2,
                    bgcolor: COLORS.accent,
                  }
                  : {},
              }}
            >
              <Icon sx={{ fontSize: 22 }} />
              {attention && <NavBadge attention={attention} />}
              <Box
                component="span"
                sx={{
                  fontSize: 11,
                  fontWeight: active ? 600 : 500,
                  lineHeight: 1,
                  letterSpacing: '-0.02em',
                }}
              >
                {SHORT_LABEL[item.id]}
              </Box>
            </Box>
          </Tooltip>
        )
      })}

      <Box sx={{ flex: 1 }} />

      <Divider sx={{ width: 32, my: 1, borderColor: COLORS.border }} />

      <Tooltip title="设置 ⌘," placement="right">
        <Box
          component="button"
          onClick={() => setPage('settings')}
          aria-label="设置"
          aria-current={currentPage === 'settings' ? 'page' : undefined}
          sx={{
            width: 52,
            height: 52,
            border: 'none',
            borderRadius: '10px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.25,
            cursor: 'pointer',
            bgcolor: currentPage === 'settings' ? COLORS.accentMuted : 'transparent',
            color: currentPage === 'settings' ? COLORS.accent : COLORS.textSecondary,
            '&:hover': {
              bgcolor: COLORS.bgHover,
              color: COLORS.text,
            },
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: 22 }} />
          <Box component="span" sx={{ fontSize: 11, fontWeight: 500 }}>
            设置
          </Box>
        </Box>
      </Tooltip>
    </Box>
  )
}
