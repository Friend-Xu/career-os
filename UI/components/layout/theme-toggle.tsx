import { IconButton, Tooltip } from '@mui/material'
import { useColorScheme } from '@mui/material/styles'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import { COLORS } from '../../data/constants'

/** Toggle between light and dark color schemes (top bar / settings). */
export function ThemeToggle({ size = 'medium' }: { size?: 'small' | 'medium' }) {
  const { mode, setMode, systemMode } = useColorScheme()

  // Resolve effective scheme (mode may be undefined on first paint)
  const resolved = mode === 'system' ? systemMode : mode
  const isDark = resolved !== 'light'

  const toggle = () => {
    setMode(isDark ? 'light' : 'dark')
  }

  const label = isDark ? '切换浅色主题' : '切换深色主题'
  const iconSx = { fontSize: size === 'small' ? 16 : 18, color: COLORS.textSecondary }

  return (
    <Tooltip title={label}>
      <IconButton
        onClick={toggle}
        size={size}
        aria-label={label}
        aria-pressed={isDark}
        sx={{
          width: size === 'small' ? 28 : 34,
          height: size === 'small' ? 28 : 34,
          border: `1px solid ${COLORS.border}`,
          bgcolor: COLORS.bgHover,
          borderRadius: '8px',
          '&:hover': {
            bgcolor: COLORS.bgActive,
            borderColor: COLORS.borderStrong,
          },
        }}
      >
        {isDark ? <LightModeOutlinedIcon sx={iconSx} /> : <DarkModeOutlinedIcon sx={iconSx} />}
      </IconButton>
    </Tooltip>
  )
}
