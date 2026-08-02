import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import BuildIcon from '@mui/icons-material/Build'
import { useAppStore } from '../store/app-store'
import { COLORS } from '../data/constants'

/**
 * 工具调用授权弹窗：消费 store.pendingPermission。
 * 放行 / 拒绝 / 批量放行本次会话 —— 审批结果写回会话消息流
 * （system 反馈 + 工具 chip 状态流转），并 resolve 权限决策 promise。
 * 关闭弹窗（ESC/点外）视为拒绝。
 */
export function PermissionDialog() {
  const pending = useAppStore((s) => s.pendingPermission)
  const approve = useAppStore((s) => s.approvePermission)
  const deny = useAppStore((s) => s.denyPermission)
  const approveAll = useAppStore((s) => s.approveAllPermissions)

  return (
    <Dialog open={pending !== null} onClose={deny} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>工具调用授权</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <BuildIcon sx={{ fontSize: 15, color: COLORS.riskMedium }} />
            <Typography
              sx={{
                fontSize: 12.5,
                fontFamily: COLORS.mono,
                px: 1,
                py: 0.5,
                borderRadius: '6px',
                bgcolor: COLORS.bgHover,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              {pending?.toolName}
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: 13, lineHeight: 1.6 }}>{pending?.description}</Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            拒绝后 Agent 将调整方式继续，或由你手动完成该操作。
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={deny} color="inherit" size="small">
          拒绝
        </Button>
        <Button onClick={approveAll} variant="outlined" size="small">
          批量放行本次会话
        </Button>
        <Button onClick={approve} variant="contained" size="small">
          放行
        </Button>
      </DialogActions>
    </Dialog>
  )
}
