import {
  Box,
  Button,
  Chip,
  Divider,
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
import AddIcon from '@mui/icons-material/Add'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, RISK_COLOR, RISK_LABEL } from '../data/constants'
import { ThemeToggle } from '../components/layout/theme-toggle'

export function SettingsPage() {
  const currentPersonId = useAppStore((s) => s.currentPersonId)
  const setPerson = useAppStore((s) => s.setPerson)
  const setPersonCreateDialogOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const archivePerson = useAppStore((s) => s.archivePerson)
  const push = useToastStore((s) => s.push)
  const { mode, setMode } = useColorScheme()
  const themeMode = mode === 'light' || mode === 'dark' ? mode : 'dark'
  const persons = useAppStore((s) => s.persons).filter((p) => !p.archived)

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Box sx={{ maxWidth: 720 }}>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>设置</Typography>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            size="small"
            onClick={() => push('success', '设置已保存（演示模式）')}
            sx={{ fontSize: 12.5 }}
          >
            保存设置
          </Button>
        </Stack>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 3 }}>
          人管理 / 模型配置 / 数据 / 外观
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
                  </Stack>
                ) : (
                  <Typography sx={{ fontSize: 12, color: COLORS.accent, px: 1 }}>当前</Typography>
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
        </Section>

        <Divider sx={{ my: 3 }} />

        {/* Model */}
        <Section title="模型配置">
          <Stack spacing={2}>
            <Field label="默认模型" defaultValue="claude-sonnet-4" />
            <Field label="API Endpoint" defaultValue="http://localhost:8080/v1" mono />
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography sx={{ fontSize: 13 }}>流式输出</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>Agent 对话实时渲染</Typography>
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
    </Box>
  )
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
