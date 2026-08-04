/**
 * JD 建档 Dialog：双界面（AI 提取 / 手动填写），JD 池唯一入口。
 * - AI 提取：粘贴 JD 原文一键提取 公司/岗位/地点/薪资/技能 回填（jobs/extract，真实 LLM）；
 *   提取后展示结果摘要 + 缺失提醒（必填缺失警告 / 可选缺失提示，可切手动补充）
 * - 手动填写：完整表单（AI 提取结果自动带入，两界面共享同一份字段）
 * - 去重：同公司同岗位已存在 → 提示并跳转既有工作区，不重复建档
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useState } from 'react'
import { getEngine, useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS } from '../data/constants'

export function AddJdDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const jobs = useAppStore((s) => s.jobs)
  const createJob = useAppStore((s) => s.createJob)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const push = useToastStore((s) => s.push)
  const [tab, setTab] = useState<0 | 1>(0)
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [salary, setSalary] = useState('')
  const [jdText, setJdText] = useState('')
  const [requirements, setRequirements] = useState('')
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState(false)

  const missingRequired = [!company.trim() && '公司', !title.trim() && '岗位名'].filter(Boolean) as string[]
  const missingOptional = [
    !location.trim() && '工作地点',
    !salary.trim() && '薪资范围',
    !requirements.trim() && '技能要求',
  ].filter(Boolean) as string[]

  /** AI 提取：JD 原文 → 结构化字段回填（真实 LLM，jobs/extract）；提取后展示缺失提醒 */
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
      setExtracted(true)
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
    setExtracted(false)
    setTab(0)
  }

  const extractedFields = [
    company.trim() && '公司',
    title.trim() && '岗位名',
    location.trim() && '工作地点',
    salary.trim() && '薪资范围',
    requirements.trim() && '技能要求',
  ].filter(Boolean) as string[]

  return (
    <Dialog
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 460,
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
            borderRadius: '12px',
            border: `1px solid ${COLORS.borderStrong}`,
          },
        },
      }}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 0.5 }}>增加 JD</DialogTitle>
      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v as 0 | 1)}
        sx={{
          px: 3,
          minHeight: 36,
          '& .MuiTab-root': { minHeight: 36, fontSize: 12.5, py: 0 },
          '& .MuiTabs-indicator': { bgcolor: COLORS.accent },
        }}
      >
        <Tab label="AI 提取" />
        <Tab label="手动填写" />
      </Tabs>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '10px !important' }}>
        {tab === 0 ? (
          <>
            <Box>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>
                粘贴招聘信息全文（岗位描述/职责/任职要求），一键提取结构化字段
              </Typography>
              <TextField
                size="small"
                placeholder="粘贴 JD 全文…"
                value={jdText}
                onChange={(e) => {
                  setJdText(e.target.value)
                  setExtracted(false)
                }}
                multiline
                minRows={5}
                maxRows={9}
                fullWidth
              />
            </Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Button
                size="small"
                variant="contained"
                startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                disabled={extracting || !jdText.trim()}
                onClick={() => void extract()}
                sx={{
                  fontSize: 12,
                  bgcolor: COLORS.accent,
                  color: COLORS.onAccent,
                  '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
                }}
              >
                {extracting ? '提取中…' : 'AI 提取'}
              </Button>
              {!jdText.trim() && (
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                  无原文也可切「手动填写」建档
                </Typography>
              )}
            </Stack>
            {extracted && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ p: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: alpha(COLORS.accent, 0.05) }}>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, mb: 0.5 }}>
                    提取结果（{extractedFields.length}/5）
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                    {extractedFields.map((f) => (
                      <Chip
                        key={f}
                        size="small"
                        label={f}
                        sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.12), color: COLORS.accent }}
                      />
                    ))}
                  </Stack>
                </Box>
                {missingRequired.length > 0 && (
                  <Alert severity="warning" sx={{ py: 0, '& .MuiAlert-message': { fontSize: 11.5 } }}>
                    必填缺失：{missingRequired.join('、')}——AI 未能提取，请切「手动填写」补充
                  </Alert>
                )}
                {missingOptional.length > 0 && (
                  <Alert severity="info" sx={{ py: 0, '& .MuiAlert-message': { fontSize: 11.5 } }}>
                    以下信息未提取到，可切「手动填写」补充：{missingOptional.join('、')}
                  </Alert>
                )}
              </Box>
            )}
          </>
        ) : (
          <>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                label="公司"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoFocus
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label="岗位名"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                label="工作地点（可选）"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label="薪资范围（可选）"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>
            <TextField
              size="small"
              label="技能要求（可选，分号分隔，如 Python;SolidWorks）"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
            />
            <TextField
              size="small"
              label="JD 原文（可选；AI 提取的结果会回填到左侧字段）"
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              multiline
              minRows={3}
              maxRows={6}
            />
            {missingRequired.length > 0 && (
              <Alert severity="warning" sx={{ py: 0, '& .MuiAlert-message': { fontSize: 11.5 } }}>
                必填缺失：{missingRequired.join('、')}
              </Alert>
            )}
          </>
        )}
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
