/**
 * JD 建档 Dialog：粘贴 JD → 引擎建 Job 实体（JD 池唯一入口）。
 * - JD 原文可选（内推/线下无原文也能建档，工作区提示分析受限）
 * - 去重：同公司同岗位已存在 → 提示并跳转既有工作区，不重复建档
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material'
import { useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { COLORS } from '../data/constants'

export function AddJdDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const jobs = useAppStore((s) => s.jobs)
  const createJob = useAppStore((s) => s.createJob)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const push = useToastStore((s) => s.push)
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [jdText, setJdText] = useState('')
  const [requirements, setRequirements] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!company.trim() || !title.trim()) {
      push('warning', '公司与岗位名必填')
      return
    }
    // 去重：同公司同岗位已建档 → 跳转既有工作区
    const dup = jobs.find((j) => j.company === company.trim() && j.title === title.trim())
    if (dup) {
      setSelectedJobId(dup.id)
      push('info', `「${company.trim()} · ${title.trim()}」已建档，跳转工作区`)
      reset()
      onClose()
      return
    }
    setSaving(true)
    try {
      const job = await createJob({
        company: company.trim(),
        title: title.trim(),
        requirements: requirements.trim() || undefined,
        jdText: jdText.trim() || undefined,
      })
      setSelectedJobId(job.id)
      push('success', `已建档：${company.trim()} · ${title.trim()}`)
      reset()
      onClose()
    } catch (err) {
      push('warning', `建档失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setCompany('')
    setTitle('')
    setJdText('')
    setRequirements('')
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 420,
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
            borderRadius: '12px',
            border: `1px solid ${COLORS.borderStrong}`,
          },
        },
      }}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>增加 JD</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
        <TextField size="small" label="公司" value={company} onChange={(e) => setCompany(e.target.value)} autoFocus />
        <TextField size="small" label="岗位名" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextField
          size="small"
          label="技能要求（可选，分号分隔，如 Python;SolidWorks）"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
        <TextField
          size="small"
          label="JD 原文（可选，粘贴招聘要求；内推/线下无原文可跳过）"
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          multiline
          minRows={3}
          maxRows={6}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onClose} sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={saving}
          onClick={() => void submit()}
          sx={{ fontSize: 12.5, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
        >
          {saving ? '保存中…' : '建档'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
