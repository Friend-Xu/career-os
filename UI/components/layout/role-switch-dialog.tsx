import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { ROLES } from '../../data/mock-data'
import { COLORS } from '../../data/constants'

export function RoleSwitchDialog() {
  const open = useAppStore((s) => s.roleSwitchDialogOpen)
  const pendingRoleId = useAppStore((s) => s.pendingRoleId)
  const currentRole = useAppStore((s) => s.currentRole())
  const confirm = useAppStore((s) => s.confirmRoleSwitch)
  const cancel = useAppStore((s) => s.cancelRoleSwitch)
  const push = useToastStore((s) => s.push)

  const pending = ROLES.find((r) => r.id === pendingRoleId)

  const confirmAndToast = (keepSession: boolean) => {
    confirm(keepSession)
    push('success', `已切换为「${pending?.name ?? ''}」`)
  }

  return (
    <Dialog open={open} onClose={cancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>切换角色</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          当前会话归入角色「{currentRole.name}」。切换到「{pending?.name ?? ''}」时，如何处理当前会话？
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={cancel} color="inherit" size="small">
          取消
        </Button>
        <Button onClick={() => confirmAndToast(false)} variant="outlined" size="small">
          丢弃会话
        </Button>
        <Button onClick={() => confirmAndToast(true)} variant="contained" size="small">
          保留会话
        </Button>
      </DialogActions>
    </Dialog>
  )
}
