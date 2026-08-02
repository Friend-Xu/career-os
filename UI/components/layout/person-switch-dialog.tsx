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
import { PERSONS } from '../../data/mock-data'
import { COLORS } from '../../data/constants'

export function PersonSwitchDialog() {
  const open = useAppStore((s) => s.personSwitchDialogOpen)
  const pendingPersonId = useAppStore((s) => s.pendingPersonId)
  const currentPerson = useAppStore((s) => s.currentPerson())
  const confirm = useAppStore((s) => s.confirmPersonSwitch)
  const cancel = useAppStore((s) => s.cancelPersonSwitch)
  const push = useToastStore((s) => s.push)

  const pending = PERSONS.find((p) => p.id === pendingPersonId)

  const confirmAndToast = (keepSession: boolean) => {
    confirm(keepSession)
    push('success', `已切换为「${pending?.name ?? ''}」`)
  }

  return (
    <Dialog open={open} onClose={cancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>切换人</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          当前会话归入人「{currentPerson.name}」。切换到「{pending?.name ?? ''}」时，如何处理当前会话？
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
