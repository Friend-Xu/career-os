import {
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { useColorScheme } from '@mui/material/styles'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import MapIcon from '@mui/icons-material/Map'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, PROVIDER_PRESETS, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { AgentProviderView } from '../store/engine-client'
import type { Person } from '../types'
import { ThemeToggle } from '../components/layout/theme-toggle'

export function SettingsPage() {
  const currentPersonId = useAppStore((s) => s.currentPersonId)
  const setPerson = useAppStore((s) => s.setPerson)
  const setPersonCreateDialogOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const archivePerson = useAppStore((s) => s.archivePerson)
  const resetInitialization = useAppStore((s) => s.resetInitialization)
  const deletePerson = useAppStore((s) => s.deletePerson)
  const providers = useAppStore((s) => s.agentSettings.providers)
  const saveAgentSettings = useAppStore((s) => s.saveAgentSettings)
  const permissionMode = useAppStore((s) => s.agentSettings.permissionMode)
  const push = useToastStore((s) => s.push)
  const { mode, setMode } = useColorScheme()
  const themeMode = mode === 'light' || mode === 'dark' ? mode : 'dark'
  const persons = useAppStore((s) => s.persons).filter((p) => !p.archived)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Person | null>(null)
  const documentVision = useAppStore((s) => s.agentSettings.documentVision)
  const [docProvider, setDocProvider] = useState<'zhipu' | 'deepseek'>(documentVision.provider)
  const [docKey, setDocKey] = useState(documentVision.apiKey)
  const [docModel, setDocModel] = useState(documentVision.model)
  useEffect(() => {
    setDocProvider(documentVision.provider)
    setDocKey(documentVision.apiKey)
    setDocModel(documentVision.model)
  }, [documentVision])

  /** Document Extraction 视觉模型保存（config.json document.vision；provider 缺省按模型名推断） */
  const saveDocumentVision = async () => {
    try {
      // 模型框残留旧服务商默认值 → 视为「未改模型」：留空由引擎按 provider 补默认（防 glm↔Exp 错配）
      const staleDefault =
        (docProvider === 'deepseek' && docModel.trim() === 'glm-4.6v-flash') ||
        (docProvider === 'deepseek' && docModel.trim() === 'glm-4v-flash')
      await saveAgentSettings({
        documentVision: {
          provider: docProvider,
          model: staleDefault ? undefined : docModel.trim() || undefined,
          apiKey: docKey.trim(),
        },
      })
      // 本地立即反映（引擎按 provider 补默认）；staleDefault 时同步清空模型框
      if (staleDefault) setDocModel('')
      push('success', docKey.trim() ? '文档提取设置已保存' : '已清除视觉模型配置（图片型 PDF 提取不可用）')
    } catch (err) {
      push('warning', `保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 合并更新某服务商（不存在则新建），即时写回引擎 */
  const updateProvider = async (id: string, patch: Partial<AgentProviderView>) => {
    const cur = providers
    const exists = cur.find((p) => p.id === id)
    const next = exists
      ? cur.map((p) => (p.id === id ? { ...p, ...patch } : p))
      : [{ ...(patch as AgentProviderView), id, enabled: patch.enabled ?? false }]
    try {
      await saveAgentSettings({ providers: next })
    } catch (err) {
      push('warning', `保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const removeProvider = async (id: string) => {
    try {
      await saveAgentSettings({ providers: providers.filter((p) => p.id !== id) })
      push('success', '已删除自定义服务商')
    } catch (err) {
      push('warning', `删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const addCustomProvider = async (label: string, baseUrl: string, apiKey: string) => {
    const id = `custom-${Date.now()}`
    await updateProvider(id, {
      label: label.trim() || '自定义',
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      models: [],
    })
    push('success', `已添加「${label.trim() || '自定义'}」，展开配置密钥与模型`)
  }

  const customProviders = providers.filter((p) => !PROVIDER_PRESETS.some((pre) => pre.id === p.id))

  /** 工具授权：bypassPermissions = 全部自动放行；其余（ask/acceptEdits）= 逐个确认 */
  const autoApprove = permissionMode === 'bypassPermissions'
  const modeLabel = {
    bypassPermissions: '自动放行全部工具',
    acceptEdits: '基础工具自动放行，其余逐个确认',
    ask: '逐个确认',
  }[permissionMode] ?? `未知模式（${permissionMode}）`
  const savePermissionMode = async (on: boolean) => {
    try {
      await saveAgentSettings({ permissionMode: on ? 'bypassPermissions' : 'ask' })
      push('success', on ? '已开启自动授权（AI 工具全部自动放行）' : '已关闭自动授权（工具调用需逐个确认）')
    } catch (err) {
      push('warning', `保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Box sx={{ maxWidth: 720 }}>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>设置</Typography>
          <Box sx={{ flex: 1 }} />
        </Stack>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 3 }}>
          人管理 / 模型服务 / 数据 / 外观
        </Typography>

        {/* Persons */}
        <Section title="人管理">
          <Stack spacing={1}>
            {persons.map((person) => (
              <Stack
                key={person.id}
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: 'center',
                  p: 1.5,
                  borderRadius: '8px',
                  border: `1px solid ${person.id === currentPersonId ? alpha(COLORS.accent, 0.35) : COLORS.border}`,
                  bgcolor: person.id === currentPersonId ? COLORS.accentMuted : COLORS.bgElevated,
                }}
              >
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: '8px',
                    bgcolor: alpha(person.color, 0.13),
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 18,
                  }}
                >
                  {person.emoji}
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{person.name}</Typography>
                  <Typography sx={{ fontSize: 12, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                    {person.profilePath}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  label={`匹配 ${person.matchScore}%`}
                  sx={{ height: 22, fontSize: 12 }}
                />
                <Chip
                  size="small"
                  label={`风险${RISK_LABEL[person.riskLevel]}`}
                  sx={{
                    height: 22,
                    fontSize: 12,
                    color: RISK_COLOR[person.riskLevel],
                    bgcolor: alpha(RISK_COLOR[person.riskLevel], 0.12),
                  }}
                />
                {person.id !== currentPersonId ? (
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => {
                        archivePerson(person.id)
                        push('info', `已归档人「${person.name}」`)
                      }}
                      sx={{ fontSize: 12, color: COLORS.textMuted }}
                    >
                      归档
                    </Button>
                    <Button size="small" onClick={() => setPerson(person.id)} sx={{ fontSize: 12 }}>
                      切换
                    </Button>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => resetInitialization(person.id)}
                      sx={{ fontSize: 12, color: COLORS.textMuted }}
                    >
                      重置初始化
                    </Button>
                    <Button size="small" color="error" onClick={() => setDeleteTarget(person)} sx={{ fontSize: 12 }}>
                      删除
                    </Button>
                  </Stack>
                ) : (
                  <Stack direction="row" spacing={0.5}>
                    <Typography sx={{ fontSize: 12, color: COLORS.accent, px: 1 }}>当前</Typography>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => resetInitialization(person.id)}
                      sx={{ fontSize: 12, color: COLORS.textMuted }}
                    >
                      重置初始化
                    </Button>
                  </Stack>
                )}
              </Stack>
            ))}
            <Button
              variant="outlined"
              size="small"
              startIcon={<AddIcon sx={{ fontSize: 14 }} />}
              sx={{ alignSelf: 'flex-start', mt: 0.5 }}
              onClick={() => setPersonCreateDialogOpen(true)}
            >
              创建新人
            </Button>
          </Stack>

          <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
            <DialogTitle>删除「{deleteTarget?.name}」？</DialogTitle>
            <DialogContent>
              <Typography sx={{ fontSize: 13, mb: 1 }}>将永久移除该档案的全部资产：</Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 13, color: COLORS.textMuted }}>
                <li>档案 manifest</li>
                <li>初始化对话记录（intake/）</li>
                <li>候选数据（extraction/）</li>
                <li>决议事件（events/）</li>
              </Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 1.5 }}>
                此操作不可恢复。关联的决策 / 公司 / 投递记录保留（不属于 Person 生命周期）。
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button size="small" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button
                size="small"
                color="error"
                variant="contained"
                onClick={() => {
                  const target = deleteTarget
                  setDeleteTarget(null)
                  if (target) void deletePerson(target.id)
                }}
              >
                删除
              </Button>
            </DialogActions>
          </Dialog>
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* 模型服务：服务商卡片列表（Cherry Studio 式：卡片 + 详情 + 校验 + 模型勾选） */}
        <Section title="模型服务">
          <Stack spacing={1.5}>
            {PROVIDER_PRESETS.map((preset) => {
              const provider = providers.find((p) => p.id === preset.id)
              return (
                <ProviderCard
                  key={preset.id}
                  preset={preset}
                  provider={provider}
                  onUpdate={(patch) => void updateProvider(preset.id, patch)}
                />
              )
            })}
            {customProviders.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isCustom
                onUpdate={(patch) => void updateProvider(p.id, patch)}
                onRemove={() => void removeProvider(p.id)}
              />
            ))}
            <Button
              variant="outlined"
              size="small"
              startIcon={<AddIcon sx={{ fontSize: 14 }} />}
              sx={{ alignSelf: 'flex-start', mt: 0.5 }}
              onClick={() => setAddDialogOpen(true)}
            >
              添加自定义服务商
            </Button>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              已启用服务商勾选的模型会出现在 Agent 面板的模型切换器中。内置服务商自动匹配 API 地址，无需填写。
            </Typography>
          </Stack>
          <Stack spacing={2} sx={{ mt: 2.5 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>流式输出</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>AI 对话实时渲染</Typography>
              </Box>
              <Switch defaultChecked size="small" />
            </Stack>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>确认式写入</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                  决策记录需用户确认后落盘
                </Typography>
              </Box>
              <Switch defaultChecked size="small" />
            </Stack>
          </Stack>
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* Agent 工具授权：工具调用权限模式（config.json agent.permissionMode；默认全部授权） */}
        <Section title="AI 工具授权">
          <Stack spacing={1.5}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>自动授权所有工具</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted, maxWidth: 440, lineHeight: 1.6 }}>
                  开启后 AI 助手调用工具（搜索 / 读文件 / 写文件 / 执行命令）不再逐个询问，方向探索等长任务更流畅。
                  关闭后每个工具调用需在弹窗中确认。
                </Typography>
              </Box>
              <Switch size="small" checked={autoApprove} onChange={(e) => void savePermissionMode(e.target.checked)} />
            </Stack>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              当前模式：{modeLabel}
              （写操作影响工作区文件，开启即表示信任 Agent 在 workspace 内自主读写）
            </Typography>
          </Stack>
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* Document Extraction：PDF 简历视觉提取（config.json document.vision，与 LLM key 同保护） */}
        <Section title="文档提取">
          <Stack spacing={1.5}>
            <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              PDF 简历智能解析——文本型 PDF 本地解析（免费）；图片型/扫描 PDF 渲染多页后由视觉模型逐页识别。
              免费模型 glm-4.6v-flash（智谱）或 deepseek-v4-flash-vision-exp（DeepSeek 多模态）可选。
            </Typography>
            <Box sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bgElevated }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>视觉模型</Typography>
                <Chip
                  size="small"
                  label={docKey.trim() ? `✓ 已连接 ${docProvider === 'deepseek' ? 'deepseek-v4-flash-vision-exp' : docModel.trim() || 'glm-4.6v-flash'}` : '⚠ 未配置'}
                  sx={{ height: 20, fontSize: 11 }}
                  color={docKey.trim() ? 'success' : 'default'}
                />
              </Stack>
              <Stack direction="row" spacing={1}>
                <TextField
                  select
                  size="small"
                  label="服务商"
                  value={docProvider}
                  onChange={(e) => setDocProvider(e.target.value as 'zhipu' | 'deepseek')}
                  sx={{ width: 120, '& .MuiOutlinedInput-root': { fontSize: 12.5 } }}
                >
                  <MenuItem value="zhipu">智谱（免费）</MenuItem>
                  <MenuItem value="deepseek">DeepSeek（Exp）</MenuItem>
                </TextField>
                <TextField
                  size="small"
                  type="password"
                  placeholder={`API Key（${docProvider === 'deepseek' ? 'DeepSeek 开放平台' : '智谱开放平台'}）`}
                  value={docKey}
                  onChange={(e) => setDocKey(e.target.value)}
                  sx={{ flex: 1, '& .MuiOutlinedInput-root': { fontSize: 12.5 } }}
                />
                <TextField
                  size="small"
                  placeholder="模型（留空 = 默认）"
                  value={docModel}
                  onChange={(e) => setDocModel(e.target.value)}
                  sx={{ width: 170, '& .MuiOutlinedInput-root': { fontSize: 12.5 } }}
                />
                <Button size="small" variant="contained" onClick={() => void saveDocumentVision()} sx={{ fontSize: 12.5 }}>
                  保存
                </Button>
              </Stack>
            </Box>
          </Stack>
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* 地图服务：高德 JS API key（与 LLM key 同存 config.json，受同一 gitignore 保护） */}
        <Section title="地图服务">
          <MapServiceCard />
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* Data */}
        <Section title="数据">
          <Stack spacing={2}>
            <Field label="工作区路径" defaultValue="workspace/career-advisor" mono />
            <Field label="画像目录" defaultValue="profiles/" mono />
            <Field label="决策目录" defaultValue="decisions/" mono />
            <Field label="公司目录" defaultValue="companies/" mono />
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => push('success', '备份完成（演示）：workspace/career-advisor 已打包')}
              >
                立即备份
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => push('info', '演示模式：导出将在阶段 3 接入')}
              >
                导出全部数据
              </Button>
              <Button
                variant="outlined"
                size="small"
                color="warning"
                onClick={() => push('info', '演示模式：重建索引将在阶段 3 接入')}
              >
                重建索引
              </Button>
            </Stack>
          </Stack>
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* Appearance */}
        <Section title="外观">
          <Stack spacing={2}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>主题</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                  深色为默认 IDE 风格 · 浅色同步切换全局色板
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <ThemeToggle size="small" />
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={themeMode}
                  onChange={(_, v: 'light' | 'dark' | null) => {
                    if (v) setMode(v)
                  }}
                  sx={{
                    '& .MuiToggleButton-root': {
                      px: 1.25,
                      py: 0.5,
                      fontSize: 12,
                      textTransform: 'none',
                      borderColor: COLORS.border,
                      color: COLORS.textSecondary,
                      '&.Mui-selected': {
                        bgcolor: COLORS.accentMuted,
                        color: COLORS.accent,
                        borderColor: alpha(COLORS.accent, 0.35),
                        '&:hover': { bgcolor: COLORS.accentMuted },
                      },
                    },
                  }}
                >
                  <ToggleButton value="dark" aria-label="深色主题">
                    <DarkModeOutlinedIcon sx={{ fontSize: 14, mr: 0.5 }} />
                    深色
                  </ToggleButton>
                  <ToggleButton value="light" aria-label="浅色主题">
                    <LightModeOutlinedIcon sx={{ fontSize: 14, mr: 0.5 }} />
                    浅色
                  </ToggleButton>
                </ToggleButtonGroup>
              </Stack>
            </Stack>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>紧凑信息密度</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>IDE 风格高密度布局</Typography>
              </Box>
              <Switch defaultChecked size="small" />
            </Stack>
          </Stack>
        </Section>
      </Box>

      <AddProviderDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onAdd={(label, baseUrl, apiKey) => {
          setAddDialogOpen(false)
          void addCustomProvider(label, baseUrl, apiKey)
        }}
      />
    </Box>
  )
}

/** 服务商卡片：折叠 = 标识/状态/启用开关；展开 = Key 校验 + 模型勾选（Cherry Studio 式） */
function ProviderCard({
  preset,
  provider,
  isCustom,
  onUpdate,
  onRemove,
}: {
  preset?: { id: string; label: string; desc: string; baseUrl: string }
  provider?: AgentProviderView
  isCustom?: boolean
  onUpdate: (patch: Partial<AgentProviderView>) => void
  onRemove?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [urlInput, setUrlInput] = useState(provider?.baseUrl ?? preset?.baseUrl ?? '')
  const [showAdvanced, setShowAdvanced] = useState(Boolean(isCustom))
  const [busy, setBusy] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const loadAvailableModels = useAppStore((s) => s.loadAvailableModels)
  const push = useToastStore((s) => s.push)

  const label = provider?.label ?? preset?.label ?? '自定义'
  const connected = Boolean(provider?.apiKey)
  const baseUrl = urlInput.trim() || preset?.baseUrl || ''
  const models = provider?.models ?? []
  const enabled = provider?.enabled ?? false

  /** 验证密钥 + 获取模型列表（一次请求两用）：成功写回 Key/URL，模型默认全勾 */
  const checkAndFetch = async () => {
    const key = keyInput.trim() || provider?.apiKey
    if (!key) {
      push('warning', '请先填写 API Key')
      return
    }
    setBusy(true)
    setFetchError(null)
    try {
      await loadAvailableModels({ apiKey: key, ...(baseUrl ? { baseUrl } : {}) })
      const m = useAppStore.getState().availableModels
      if (m.source === 'api' && m.models.length > 0) {
        const merged = [...models, ...m.models.filter((x) => !models.includes(x))]
        onUpdate({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), models: merged })
        setFetchedModels(m.models)
        setKeyInput('')
        push('success', `连接成功 · 获取 ${m.models.length} 个模型，取消勾选不需要的`)
      } else if (m.source === 'api_error') {
        setFetchError(modelErrorHint(m.error))
        push('warning', `连接失败：${modelErrorHint(m.error)}`)
      } else {
        setFetchError('未获取到模型（端点无模型列表，可手动添加模型 ID）')
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleModel = (mid: string) => {
    const next = models.includes(mid) ? models.filter((m) => m !== mid) : [...models, mid]
    onUpdate({ models: next })
  }

  return (
    <Box
      sx={{
        borderRadius: '10px',
        border: `1px solid ${enabled ? alpha(COLORS.accent, 0.3) : COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        overflow: 'hidden',
      }}
    >
      {/* 折叠态头部 */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          px: 1.5,
          py: 1.25,
          cursor: 'pointer',
          '&:hover': { bgcolor: COLORS.bgHover },
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: '7px',
            display: 'grid',
            placeItems: 'center',
            fontSize: 13,
            fontWeight: 600,
            mr: 1.25,
            bgcolor: connected ? alpha(COLORS.accent, 0.13) : COLORS.bgHover,
            color: connected ? COLORS.accent : COLORS.textMuted,
          }}
        >
          {label.slice(0, 2)}
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
            {label}
            {isCustom && <Typography component="span" sx={{ fontSize: 11.5, color: COLORS.textMuted, ml: 0.75 }}>自定义</Typography>}
          </Typography>
          <Typography sx={{ fontSize: 12, color: connected ? COLORS.riskLow : COLORS.textMuted }}>
            {connected
              ? `已连接 · ${models.length ? models.join(' / ') : '未勾选模型'}`
              : '未配置'}
          </Typography>
        </Box>
        {onRemove && (
          <IconButton
            size="small"
            aria-label="删除服务商"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            sx={{ color: COLORS.textMuted }}
          >
            <DeleteIcon sx={{ fontSize: 16 }} />
          </IconButton>
        )}
        <Switch
          size="small"
          checked={enabled}
          disabled={!connected}
          title={connected ? '启用/停用该服务商' : '配置密钥后可启用'}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdate({ enabled: e.target.checked })}
          sx={{ mr: 0.5 }}
        />
        <IconButton
          size="small"
          aria-label={expanded ? '折叠配置' : '展开配置'}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          sx={{ color: COLORS.textSecondary }}
        >
          {expanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}
        </IconButton>
      </Stack>

      <Collapse in={expanded}>
        <Stack spacing={1.5} sx={{ px: 1.5, py: 1.5, borderTop: `1px solid ${COLORS.border}` }}>
          {isCustom && (
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>名称</Typography>
              <TextField
                fullWidth
                size="small"
                value={label}
                onChange={(e) => onUpdate({ label: e.target.value || undefined })}
                placeholder="如：我的主力号"
                sx={{ '& .MuiOutlinedInput-root': { fontSize: 13, bgcolor: COLORS.bg } }}
              />
            </Box>
          )}
          <Box>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>API 密钥</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField
                size="small"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={connected ? '已配置（留空 = 用已保存的）' : '在此粘贴 sk-…'}
                sx={{
                  flex: 1,
                  '& .MuiOutlinedInput-root': { fontSize: 13, fontFamily: COLORS.mono, bgcolor: COLORS.bg },
                }}
              />
              <Button
                variant="outlined"
                size="small"
                disabled={busy}
                onClick={() => void checkAndFetch()}
                sx={{ fontSize: 12, mt: 0.5, whiteSpace: 'nowrap' }}
              >
                {busy ? '验证中…' : '验证并获取模型'}
              </Button>
            </Stack>
          </Box>
          <Box>
            <Typography
              sx={{
                fontSize: 11.5,
                color: COLORS.textMuted,
                cursor: 'pointer',
                userSelect: 'none',
                '&:hover': { color: COLORS.textSecondary },
              }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '▾' : '▸'} API 地址（内置已匹配，一般无需修改）
            </Typography>
            <Collapse in={showAdvanced}>
              <TextField
                fullWidth
                size="small"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://api.anthropic.com"
                sx={{ mt: 0.75, '& .MuiOutlinedInput-root': { fontSize: 12.5, fontFamily: COLORS.mono, bgcolor: COLORS.bg } }}
              />
            </Collapse>
          </Box>
          {fetchError && (
            <Typography sx={{ fontSize: 12, color: RISK_COLOR.high }}>{fetchError}</Typography>
          )}
          {fetchedModels.length > 0 && (
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>
                模型（勾选要用的）
              </Typography>
              <Stack spacing={0.25}>
                {fetchedModels.map((mid) => (
                  <Stack
                    key={mid}
                    direction="row"
                    spacing={0.75}
                    sx={{ alignItems: 'center', borderRadius: '6px', '&:hover': { bgcolor: COLORS.bgHover } }}
                  >
                    <Checkbox
                      size="small"
                      checked={models.includes(mid)}
                      onChange={() => toggleModel(mid)}
                      sx={{ p: 0.5 }}
                    />
                    <Typography sx={{ fontSize: 12.5, fontFamily: COLORS.mono }}>{mid}</Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}
          {connected && fetchedModels.length === 0 && models.length > 0 && (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
              已勾选：{models.join(' / ')}（重新「验证并获取模型」可调整）
            </Typography>
          )}
        </Stack>
      </Collapse>
    </Box>
  )
}

/** 添加自定义服务商弹窗：名称 + API 地址 + API Key 三步 */
function AddProviderDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  onAdd: (label: string, baseUrl: string, apiKey: string) => void
}) {
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    if (open) {
      setLabel('')
      setBaseUrl('')
      setApiKey('')
    }
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15 }}>添加自定义服务商</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
        <TextField
          size="small"
          label="名称"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="如：本地 Ollama"
          sx={{ '& .MuiInputLabel-root': { fontSize: 13 } }}
        />
        <TextField
          size="small"
          label="API 地址（基础链接）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/anthropic"
          sx={{ '& .MuiInputLabel-root': { fontSize: 13 } }}
        />
        <TextField
          size="small"
          label="API 密钥"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="在此粘贴 sk-…"
          sx={{ '& .MuiInputLabel-root': { fontSize: 13 } }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" color="inherit" onClick={onClose} sx={{ fontSize: 12.5 }}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!label.trim() || !baseUrl.trim()}
          onClick={() => onAdd(label, baseUrl, apiKey)}
          sx={{ fontSize: 12.5 }}
        >
          添加
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function modelErrorHint(error?: 'auth' | 'no_endpoint' | 'network'): string {
  if (error === 'auth') return '🔐 密钥不对，请重新复制粘贴一下'
  if (error === 'network') return '🌍 网络不通，检查电脑是否联网，或尝试切换代理'
  return '端点不支持模型列表：检查 API 地址，或手动添加模型 ID（DeepSeek 类网关可填 claude-* 名自动映射）'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 1 }}>
      <Typography
        sx={{
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: '0.04em',
          mb: 1.5,
        }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  )
}

function Field({
  label,
  defaultValue,
  mono,
}: {
  label: string;
  defaultValue: string;
  mono?: boolean;
}) {
  return (
    <Box>
      <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>{label}</Typography>
      <TextField
        fullWidth
        size="small"
        defaultValue={defaultValue}
        sx={{
          '& .MuiOutlinedInput-root': {
            fontSize: 13,
            fontFamily: mono ? COLORS.mono : 'inherit',
            bgcolor: COLORS.bgElevated,
          },
        }}
      />
    </Box>
  )
}

/** 地图服务卡片：高德 JS API key（存 config.json map 段，gitignore 保护；公司地图探索消费） */
function MapServiceCard() {
  const map = useAppStore((s) => s.agentSettings.map)
  const saveAgentSettings = useAppStore((s) => s.saveAgentSettings)
  const push = useToastStore((s) => s.push)
  const [keyDraft, setKeyDraft] = useState(map?.apiKey ?? '')
  const [codeDraft, setCodeDraft] = useState(map?.securityJsCode ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await saveAgentSettings({ map: { apiKey: keyDraft.trim(), securityJsCode: codeDraft.trim() } })
      push(
        'success',
        keyDraft.trim() || codeDraft.trim()
          ? '高德配置已保存（config.json，gitignore 保护）'
          : '已清除高德配置',
      )
    } catch (err) {
      push('warning', `保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const configured = Boolean(map?.apiKey && map?.securityJsCode)

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: '10px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
        bgcolor: COLORS.bgElevated,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1.25 }}>
        <MapIcon sx={{ fontSize: 15, color: COLORS.accent, mr: 0.75 }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>高德地图（Web JS API）</Typography>
        <Chip
          size="small"
          label={configured ? '已配置' : '未配置'}
          sx={{
            height: 20,
            fontSize: 11,
            bgcolor: configured ? alpha(COLORS.riskLow, 0.12) : COLORS.bgHover,
            color: configured ? COLORS.riskLow : COLORS.textMuted,
          }}
        />
      </Stack>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.25, lineHeight: 1.6 }}>
        公司空间「地图探索」视图的真实地图底图。Key 与安全密钥同存 config.json（已 gitignore，不会进入远程仓库）。
      </Typography>
      <Stack spacing={1}>
        <TextField
          fullWidth
          size="small"
          type="password"
          placeholder="粘贴高德 Web 端 JS API Key"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          sx={{ '& .MuiOutlinedInput-root': { fontSize: 13 } }}
        />
        <TextField
          fullWidth
          size="small"
          type="password"
          placeholder="粘贴安全密钥（securityJsCode）"
          value={codeDraft}
          onChange={(e) => setCodeDraft(e.target.value)}
          sx={{ '& .MuiOutlinedInput-root': { fontSize: 13 } }}
        />
        <Button
          size="small"
          variant="contained"
          disabled={saving}
          onClick={() => void save()}
          sx={{
            alignSelf: 'flex-start',
            fontSize: 12,
            bgcolor: COLORS.accent,
            color: COLORS.onAccent,
            '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
          }}
        >
          保存
        </Button>
      </Stack>
      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 1 }}>
        申请：高德开放平台 → 应用管理 → 创建应用 → Web 端(JS API) → 安全域名填 localhost 和 127.0.0.1；安全密钥在「应用详情」获取。
      </Typography>
    </Box>
  )
}
