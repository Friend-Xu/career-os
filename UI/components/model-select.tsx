/**
 * 模型选择：可用模型 options（引擎 settings/models 拉取：配置 apiKey 时来自 Anthropic API，
 * 否则空列表）+ 可选自由输入。Agent 聊天切换器 = 纯列表选择；设置页 = 允许自定义输入。
 */
import { Autocomplete, TextField } from '@mui/material'
import { COLORS } from '../data/constants'

export function ModelSelect({
  value,
  onChange,
  compact,
  options,
  freeInput,
}: {
  value: string
  onChange: (model: string) => void
  compact?: boolean
  options?: string[]
  /** 允许手动输入自定义模型 ID（设置页配置用；Agent 切换器纯列表选择） */
  freeInput?: boolean
}) {
  return (
    <Autocomplete
      size="small"
      freeSolo={freeInput}
      disableClearable
      options={options ?? []}
      value={value}
      onChange={(_e, v) => onChange(v ?? '')}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={compact ? '默认模型' : '选择或输入模型（留空 = CLI 默认）'}
          title="模型（留空 = 使用 claude CLI 默认模型）"
          sx={{
            '& .MuiOutlinedInput-root': {
              fontSize: compact ? 11.5 : 13,
              bgcolor: COLORS.bgElevated,
              py: 0,
            },
            ...(compact ? { width: 132 } : {}),
          }}
        />
      )}
      slotProps={{
        paper: { sx: { fontSize: 12.5 } },
        listbox: { sx: { fontSize: 12.5, py: 0.5 } },
      }}
    />
  )
}
