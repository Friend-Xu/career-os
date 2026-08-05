/**
 * Resume Assets（M3.5.5）：AI Read Projection Viewer——CareerContext 只读投影。
 * 不做资产管理（无写操作）：Claims（type/usable/usedByResume/provenance）、
 * Evidence（状态）、Exports（ExportRecord 历史）。数据来自引擎投影，UI 不重新 query。
 */
import { Box, Chip, Stack, Typography } from '@mui/material'
import { useAppStore } from '../store/app-store'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'

export function ResumeAssets() {
  const careerContext = useAppStore((s) => s.careerContext)
  const evidenceItems = useAppStore((s) => s.evidence)
  const claims = careerContext?.claims ?? []
  const exports = careerContext?.exports ?? []

  return (
    <Stack spacing={2}>
      {/* Claims */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Claims（可消费表达资产）</Typography>
        {claims.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无 Claim——从 trusted Evidence 生成后出现于此</Typography>
        ) : (
          <Stack spacing={1}>
            {claims.map((c) => {
              const evTitles = c.provenance.evidenceIds.map((eid) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid)
              return (
                <Box key={c.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                      {c.statement}
                    </Typography>
                    <Chip size="small" label={c.type === 'fact' ? '事实' : '归纳'} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(c.type === 'fact' ? RISK_COLOR.low : RISK_COLOR.medium, 0.1), color: c.type === 'fact' ? RISK_COLOR.low : RISK_COLOR.medium }} />
                    <Chip size="small" label={c.usable ? '可消费' : '不可消费'} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(c.usable ? RISK_COLOR.low : RISK_COLOR.high, 0.1), color: c.usable ? RISK_COLOR.low : RISK_COLOR.high }} />
                  </Stack>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                    证据：{evTitles.join('、') || '无'}
                    {c.usedByResume.length > 0 ? ` · 被使用于：${c.usedByResume.map((r) => r.slice(-6)).join('、')}` : ' · 未使用'}
                  </Typography>
                </Box>
              )
            })}
          </Stack>
        )}
      </Box>

      {/* Evidence */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Evidence（事实资产）</Typography>
        {evidenceItems.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无 Evidence——通过主动沉淀或 JD 驱动收集</Typography>
        ) : (
          <Stack spacing={1}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              Active · {evidenceItems.filter((e) => e.lifecycle !== 'legacy').length}
            </Typography>
            {evidenceItems.filter((e) => e.lifecycle !== 'legacy').map((e) => (
              <Box key={e.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                    {e.event.title}
                  </Typography>
                  <Chip size="small" label={e.status} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(e.status === 'trusted' ? RISK_COLOR.low : COLORS.textMuted, 0.1), color: e.status === 'trusted' ? RISK_COLOR.low : COLORS.textMuted }} />
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{e.contribution}</Typography>
              </Box>
            ))}
            {(() => {
              const legacy = evidenceItems.filter((e) => e.lifecycle === 'legacy')
              if (legacy.length === 0) return null
              return (
                <>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 1 }}>
                    Historical（legacy·开发期/历史，不进新表达）· {legacy.length}
                  </Typography>
                  {legacy.map((e) => (
                    <Box key={e.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: alpha(COLORS.textMuted, 0.04) }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, flex: 1, minWidth: 0 }} noWrap>
                          {e.event.title}
                        </Typography>
                        <Chip size="small" label="legacy" sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.textMuted, 0.1), color: COLORS.textMuted }} />
                      </Stack>
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, opacity: 0.8 }}>{e.contribution}</Typography>
                    </Box>
                  ))}
                </>
              )
            })()}
          </Stack>
        )}
      </Box>

      {/* Exports */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Exports（导出历史）</Typography>
        {exports.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无导出记录——版本导出成功后才生成 ExportRecord</Typography>
        ) : (
          <Stack spacing={1}>
            {exports.map((e, i) => (
              <Box key={i} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1 }}>简历 {e.resumeId.slice(-6)}</Typography>
                  <Chip size="small" label={e.format.toUpperCase()} sx={{ height: 18, fontSize: 10.5 }} />
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{e.exportedAt.slice(0, 19).replace('T', ' ')}</Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}
