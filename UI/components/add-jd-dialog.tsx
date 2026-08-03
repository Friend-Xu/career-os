/**
 * JD 建档 Dialog：粘贴 JD → 引擎建 Job 实体（JD 池唯一入口）。
 * - AI 提取：JD 原文粘贴后一键提取 公司/岗位/地点/薪资/技能 回填（jobs/extract，真实 LLM）
 * - JD 原文可选（内推/线下无原文也能建档，工作区提示分析受限）
 * - 去重：同公司同岗位已存在 → 提示并跳转既有工作区，不重复建档
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useState } from 'react'
import { getEngine, useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { COLORS } from '../data/constants'

export function AddJdDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const jobs = useAppStore((s) => s.jobs)
  const createJob = useAppStore((s) => s.createJob)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const push = useToastStore((s) => s.push)
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [salary, setSalary] = useState('')
  const [jdText, setJdText] = useState('')
  const [requirements, setRequirements] = useState('')
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)

  /** AI 提取：JD 原文 → 结构化字段回填（真实 LLM，jobs/extract） */
  const extract = async () => {
    const engine = getEngine()
    if (!engine) {
      push('warning', '引擎离线，无法 AI 提取——可手动填写')
      return
    }
    setExtracting(true)
    try {
      const r = await engine.extractJd(jdText.trim())
      if (r.company) setCompany(r.company)
      if (r.title) setTitle(r.title)
      if (r.location) setLocation(r.location)
      if (r.salary) setSalary(r.salary)
      if (r.requirements.length > 0) setRequirements(r.requirements.join(';'))
      push('success', '已提取 JD 信息，确认后建档')
    } catch (err) {
      push('warning', `提取失败：${err instanceof Error ? err.message : String(err)}——可手动填写`)
    } finally {
      setExtracting(false)
    }
  }

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
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(salary.trim() ? { salary: salary.trim() } : {}),
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
    setLocation('')
    setSalary('')
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
            width: 440,
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
        <Stack direction="row" spacing={1.5}>
          <TextField size="small" label="公司" value={company} onChange={(e) => setCompany(e.target.value)} autoFocus sx={{ flex: 1 }} />
          <TextField size="small" label="岗位名" value={title} onChange={(e) => setTitle(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
        <Stack direction="row" spacing={1.5}>
          <TextField size="small" label="工作地点（可选）" value={location} onChange={(e) => setLocation(e.target.value)} sx={{ flex: 1 }} />
          <TextField size="small" label="薪资范围（可选）" value={salary} onChange={(e) => setSalary(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
        <TextField
          size="small"
          label="技能要求（可选，分号分隔，如 Python;SolidWorks）"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
        <TextField
          size="small"
          label="JD 原文（粘贴后可用 AI 提取；内推/线下无原文可跳过）"
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          multiline
          minRows={3}
          maxRows={6}
        />
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, flex: 1 }}>
            AI 提取自动回填公司/岗位/地点/薪资/技能
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
            disabled={extracting || !jdText.trim()}
            onClick={() => void extract()}
            sx={{ fontSize: 12, flexShrink: 0 }}
          >
            {extracting ? '提取中…' : 'AI 提取'}
          </Button>
        </Stack>
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
