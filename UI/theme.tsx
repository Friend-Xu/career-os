import { createTheme } from '@mui/material/styles'
import { EASE } from './data/constants'

/** Career OS design tokens — dark-first IDE aesthetic (Claude/Linear/Obsidian) */
const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'class',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: '#6B5BD6',
          light: '#8B7DE0',
          dark: '#4E41B8',
          contrastText: '#ffffff',
        },
        secondary: {
          main: '#71717a',
          light: '#a1a1aa',
          dark: '#52525b',
          contrastText: '#fafafa',
        },
        error: { main: '#d6454e', light: '#e27079', dark: '#b93a44' },
        warning: { main: '#c77b0f', light: '#db9632', dark: '#a0600a' },
        info: { main: '#2563eb', light: '#3b82f6', dark: '#1d4ed8' },
        success: { main: '#12805c', light: '#16a06f', dark: '#0d6b4c' },
        background: { default: '#F7F7F8', paper: '#FFFFFF' },
        text: { primary: '#1a1a1e', secondary: '#5e5e6a' },
        divider: 'rgba(0,0,0,0.1)',
        action: {
          hover: 'rgba(0,0,0,0.045)',
          selected: 'rgba(107,91,214,0.12)',
          disabled: 'rgba(0,0,0,0.3)',
          disabledBackground: 'rgba(0,0,0,0.06)',
        },
      },
    },
    dark: {
      palette: {
        primary: {
          main: '#9081E4',
          light: '#AB9EF0',
          dark: '#7162CC',
          contrastText: '#0D0F14',
        },
        secondary: {
          main: '#9BA1B0',
          light: '#C4C8D4',
          dark: '#6B7280',
          contrastText: '#0D0F14',
        },
        error: { main: '#F07178', light: '#F5A0A5', dark: '#E04B54' },
        warning: { main: '#E6B450', light: '#F0C978', dark: '#C9952E' },
        info: { main: '#59C2FF', light: '#8AD4FF', dark: '#2BA8F0' },
        success: { main: '#7FD962', light: '#A5E68A', dark: '#5BC040' },
        background: {
          default: '#0D0F14',
          paper: '#14171F',
        },
        text: {
          primary: '#E8EAED',
          secondary: '#8B92A5',
        },
        divider: 'rgba(255,255,255,0.08)',
        action: {
          hover: 'rgba(255,255,255,0.04)',
          selected: 'rgba(144,129,228,0.14)',
          disabled: 'rgba(255,255,255,0.3)',
          disabledBackground: 'rgba(255,255,255,0.06)',
        },
      },
    },
  },
  typography: {
    fontFamily:
      '"Geist Variable", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontSize: '1.5rem', fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em' },
    h2: { fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.35 },
    h3: { fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.4 },
    h4: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.4 },
    h5: { fontSize: '0.9375rem', fontWeight: 600, lineHeight: 1.45 },
    h6: { fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.45 },
    body1: { fontSize: '0.875rem', lineHeight: 1.55 },
    body2: { fontSize: '0.8125rem', lineHeight: 1.5 },
    caption: { fontSize: '0.75rem', lineHeight: 1.4 },
    overline: {
      fontSize: '0.75rem',
      fontWeight: 500,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      lineHeight: 1.4,
    },
    button: { textTransform: 'none', fontWeight: 500, fontSize: '0.8125rem' },
  },
  shape: { borderRadius: 6 },
  spacing: 4,
  shadows: [
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
  ],
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { height: '100%' },
        body: {
          height: '100%',
          overflow: 'hidden',
          backgroundColor: 'var(--cos-bg)',
        },
        '#root': { height: '100%' },
        '::-webkit-scrollbar': { width: 6, height: 6 },
        '::-webkit-scrollbar-track': { background: 'transparent' },
        '::-webkit-scrollbar-thumb': {
          background: 'var(--cos-border-strong)',
          borderRadius: 3,
        },
        '::-webkit-scrollbar-thumb:hover': {
          background: 'var(--cos-text-muted)',
        },
        '@keyframes pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(144,129,228,0.45)' },
          '70%': { boxShadow: '0 0 0 6px rgba(144,129,228,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(144,129,228,0)' },
        },
        '@keyframes fade-in': {
          from: { opacity: 0, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
    },
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiButton: {
      defaultProps: { disableElevation: true, disableRipple: true },
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
          fontSize: '0.8125rem',
          padding: '6px 14px',
          minHeight: 34,
          transition: `background-color 0.2s ${EASE}, border-color 0.2s ${EASE}, opacity 0.2s ${EASE}, transform 0.15s ${EASE}`,
          '&:active': { transform: 'scale(0.98)' },
        },
        sizeSmall: { padding: '4px 12px', fontSize: '0.8125rem', minHeight: 30 },
        sizeLarge: { padding: '9px 18px', fontSize: '0.875rem', minHeight: 40 },
        contained: {
          '&:hover': { opacity: 0.92 },
        },
        outlined: {
          borderColor: 'var(--cos-border-strong)',
          '&:hover': {
            borderColor: 'var(--cos-border-strong)',
            backgroundColor: 'var(--cos-bg-hover)',
          },
        },
        text: {
          '&:hover': { backgroundColor: 'var(--cos-bg-hover)' },
        },
      },
    },
    MuiIconButton: {
      defaultProps: { disableRipple: true },
      styleOverrides: {
        root: {
          borderRadius: 6,
          transition: `background-color 0.2s ${EASE}`,
          '&:hover': { backgroundColor: 'var(--cos-bg-hover)' },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
          fontSize: '0.75rem',
          height: 26,
        },
        sizeSmall: { height: 22, fontSize: '0.75rem' },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          backgroundImage: 'none',
          backgroundColor: 'var(--cos-bg-elevated)',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          boxShadow: 'none',
          border: '1px solid var(--cos-border)',
          backgroundImage: 'none',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 6,
            fontSize: '0.8125rem',
            '& fieldset': { borderColor: 'var(--cos-border)' },
            '&:hover fieldset': { borderColor: 'var(--cos-border-strong)' },
            '&.Mui-focused fieldset': { borderColor: 'var(--cos-accent)', borderWidth: 1 },
            '& input': { padding: '7px 10px' },
          },
        },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true, enterDelay: 400 },
      styleOverrides: {
        tooltip: {
          backgroundColor: 'var(--cos-bg-elevated)',
          color: 'var(--cos-text)',
          border: '1px solid var(--cos-border-strong)',
          fontSize: '0.75rem',
          borderRadius: 6,
          padding: '6px 10px',
        },
        arrow: { color: 'var(--cos-bg-elevated)' },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: 'var(--cos-border)' },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          borderRadius: 8,
          border: '1px solid var(--cos-border-strong)',
          backgroundImage: 'none',
          backgroundColor: 'var(--cos-bg-elevated)',
          boxShadow: 'var(--cos-shadow)',
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: '0.8125rem',
          minHeight: 34,
          borderRadius: 4,
          margin: '2px 4px',
          padding: '6px 10px',
          '&:hover': { backgroundColor: 'var(--cos-bg-hover)' },
          '&.Mui-selected': {
            backgroundColor: 'var(--cos-accent-muted)',
            '&:hover': { backgroundColor: 'var(--cos-accent-muted)' },
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 12,
          border: '1px solid var(--cos-border-strong)',
          backgroundImage: 'none',
          backgroundColor: 'var(--cos-bg-elevated)',
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontSize: '0.8125rem',
          fontWeight: 500,
          minHeight: 36,
          padding: '6px 12px',
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 36 },
        indicator: { height: 2, borderRadius: 1 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          borderRadius: 3,
          height: 6,
          backgroundColor: 'var(--cos-bg-hover)',
        },
      },
    },
    MuiSkeleton: {
      styleOverrides: {
        root: { backgroundColor: 'var(--cos-bg-hover)' },
      },
    },
  },
})

export default theme
