import { Alert, Stack } from '@mui/material'
import { useToastStore } from '../store/toast-store'
import { COLORS, EASE, LAYOUT } from '../data/constants'

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <Stack
      spacing={1}
      sx={{
        position: 'fixed',
        bottom: LAYOUT.statusBar + 16,
        right: 16,
        zIndex: 1400,
        maxWidth: 380,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <Alert
          key={t.id}
          severity={t.kind}
          onClose={() => dismiss(t.id)}
          sx={{
            pointerEvents: 'auto',
            borderRadius: '8px',
            bgcolor: COLORS.bgElevated,
            border: `1px solid ${COLORS.borderStrong}`,
            boxShadow: '0 8px 32px rgba(23,19,48,0.55)',
            fontSize: 13,
            animation: `fade-in 0.25s ${EASE}`,
            '& .MuiAlert-icon': { fontSize: 18 },
          }}
        >
          {t.message}
        </Alert>
      ))}
    </Stack>
  )
}
