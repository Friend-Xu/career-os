import { Button, Typography } from '@mui/material'
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

  const label = isDark ? '切换浅色' : '切换深色'
  const iconSx = { fontSize: size === 'small' ? 15 : 16 }
  const height = size === 'small' ? 28 : 32

  return (
    <Button
      onClick={toggle}
      size={size}
      aria-label={label}
      aria-pressed={isDark}
      startIcon={
        isDark ? (
          <LightModeOutlinedIcon sx={iconSx} />
        ) : (
          <DarkModeOutlinedIcon sx={iconSx} />
        )
      }
      sx={{
        height,
        minWidth: 0,
        px: 1.25,
        gap: 0.75,
        color: COLORS.textSecondary,
        border: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgHover,
        borderRadius: '8px',
        '&:hover': {
          bgcolor: COLORS.bgActive,
          borderColor: COLORS.borderStrong,
          color: COLORS.text,
        },
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 500, lineHeight: 1 }}>
        {isDark ? '浅色' : '深色'}
      </Typography>
    </Button>
  )
}
