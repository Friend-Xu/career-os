/**
 * 模型选择：可用模型 options（引擎 settings/models 拉取：配置 apiKey 时来自 Anthropic API，
 * 否则空列表）+ 可选自由输入。Agent 聊天切换器 = 纯列表选择；设置页 = 允许自定义输入。
 * 样式（2026-08-28 美化）：圆角 10 + 底色卡片化 + 前缀模型徽标（首字母色块）+
 * hover/focus 主色描边，下拉列表圆角 + hover/选中态主色。
 */
import { Autocomplete, Box, TextField } from '@mui/material'
import { COLORS, alpha } from '../data/constants'

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
      popupIcon={null}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={compact ? '模型' : '选择或输入模型（留空 = 服务商默认）'}
          title="模型（留空 = 服务商默认模型）"
          sx={{
            '& .MuiOutlinedInput-root': {
              fontSize: compact ? 11.5 : 13,
              bgcolor: COLORS.bgElevated,
              py: 0,
              height: 28,
              borderRadius: '10px',
              border: `1px solid ${COLORS.border}`,
              '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
              '&:hover': { borderColor: alpha(COLORS.accent, 0.5) },
              '&.Mui-focused': { borderColor: COLORS.accent },
            },
            ...(compact ? { width: 148 } : {}),
          }}
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    mr: 0.6,
                    flexShrink: 0,
                    borderRadius: '50%',
                    bgcolor: alpha(COLORS.accent, 0.16),
                    color: COLORS.accent,
                    fontSize: 10,
                    fontWeight: 700,
                    overflow: 'hidden',
                  }}
                >
                  {(value || 'M').charAt(0).toUpperCase()}
                </Box>
              ),
            },
          }}
        />
      )}
      slotProps={{
        paper: {
          sx: {
            fontSize: 12,
            borderRadius: '12px',
            border: `1px solid ${COLORS.border}`,
            boxShadow: 3,
          },
        },
        listbox: {
          sx: {
            fontSize: 12,
            py: 0.5,
            '& .MuiAutocomplete-option': {
              borderRadius: '8px',
              mx: 0.5,
              '&:hover': { bgcolor: alpha(COLORS.accent, 0.1) },
              '&[aria-selected="true"]': { bgcolor: `${alpha(COLORS.accent, 0.14)} !important`, fontWeight: 600 },
            },
          },
        },
      }}
    />
  )
}
