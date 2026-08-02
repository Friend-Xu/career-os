import { useEffect, useState } from 'react'
import { Box, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'
import { getEngine, useAppStore } from '../store/app-store'
import type { GapResult } from '../types'

type GapStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 差距分析（V2）：公司详情抽屉内的岗位差距区块。
 * 知识层岗位档案（knowledge.roles，store 实时派生）× 当前人技能声明 → knowledgeGap RPC 实时拉取。
 * 诚实空态：知识层未就绪（引擎旧代码/离线）/ 该公司无岗位档案 / 画像未声明技能，均显式标注，不假装可用。
 */
export function GapAnalysisSection({ companyName }: { companyName: string }) {
  const personName = useAppStore((s) => s.currentPerson().name)
  const knowledge = useAppStore((s) => s.knowledge)
  const [gap, setGap] = useState<GapResult | null>(null)
  const [status, setStatus] = useState<GapStatus>('idle')

  // 该公司岗位档案（可能多个 → 取第一个，最小实现）；知识层未就绪时不消费空 roles（避免误报"无档案"）
  const role = knowledge.status === 'ready' ? knowledge.roles.find((r) => r.company === companyName) : undefined

  useEffect(() => {
    let cancelled = false
    setGap(null)
    if (!role) {
      setStatus('idle')
      return
    }
    setStatus('loading')
    const engine = getEngine()
    if (!engine) {
      setStatus('error')
      return
    }
    engine
      .knowledgeGap({ person: personName, roleId: role.id })
      .then((result) => {
        if (cancelled) return
        setGap(result)
        setStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [role, personName])

  let body
  if (knowledge.status !== 'ready') {
    body = <EmptyNote text="知识层未就绪（引擎未连接或未实现 knowledge RPC）" />
  } else if (!role) {
    body = <EmptyNote text="该公司暂无岗位档案（knowledge/roles.md 未建）" />
  } else if (status === 'idle' || status === 'loading') {
    body = (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={13} thickness={5} />
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>正在对比「{role.name}」技能矩阵…</Typography>
      </Stack>
    )
  } else if (status === 'error') {
    body = <EmptyNote text="知识层未就绪（knowledge/gap 调用失败）" />
  } else {
    body = gap ? <GapResultView gap={gap} /> : null
  }

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: '8px',
        bgcolor: COLORS.canvas,
        border: `1px solid ${COLORS.border}`,
        mb: 2,
      }}
    >
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1 }}>差距分析</Typography>
      {body}
    </Box>
  )
}

function GapResultView({ gap }: { gap: GapResult }) {
  // 画像无技能声明：满足/有基础为空且缺失覆盖岗位全量技能 → 结论存疑
  const noDeclaration =
    gap.satisfied.length === 0 &&
    gap.transferable.length === 0 &&
    gap.missing.length > 0 &&
    gap.missing.length === gap.role.skills.length

  return (
    <>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600 }}>对「{gap.role.name}」的差距</Typography>
        <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>{gap.person}</Typography>
      </Stack>

      {noDeclaration && (
        <Box
          sx={{
            p: 1,
            borderRadius: '6px',
            bgcolor: alpha(RISK_COLOR.medium, 0.08),
            border: `1px solid ${alpha(RISK_COLOR.medium, 0.3)}`,
            mb: 1.5,
          }}
        >
          <Typography sx={{ fontSize: 11.5, color: RISK_COLOR.medium, lineHeight: 1.6 }}>
            画像未声明技能（profiles/ 加 ## 技能 段落），结论存疑
          </Typography>
        </Box>
      )}

      <LevelList title={`满足 · ${gap.satisfied.length}`} color={RISK_COLOR.low} items={gap.satisfied} />
      <LevelList title={`有基础待补强 · ${gap.transferable.length}`} color={RISK_COLOR.medium} items={gap.transferable} />
      <MissingList items={gap.missing} />
    </>
  )
}

/** 有水平声明清单（满足/有基础）：技能名 + 1-5 级圆点 */
function LevelList({
  title,
  color,
  items,
}: {
  title: string
  color: string
  items: { name: string; level: number }[]
}) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>{title}</Typography>
      </Stack>
      {items.length === 0 ? (
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, pl: 1.25 }}>无</Typography>
      ) : (
        <Stack spacing={0.5}>
          {items.map((it) => (
            <Stack key={it.name} direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography sx={{ fontSize: 12 }}>{it.name}</Typography>
              <LevelDots level={it.level} color={color} />
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  )
}

function LevelDots({ level, color }: { level: number; color: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Box
          key={i}
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: i <= level ? color : alpha(COLORS.text, 0.1),
          }}
        />
      ))}
      <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted, ml: 0.5, fontFamily: COLORS.mono }}>
        L{level}
      </Typography>
    </Stack>
  )
}

/** 缺失清单：技能 + 必需/可选标记 + 为什么（source）+ 怎么办（action） */
function MissingList({ items }: { items: GapResult['missing'] }) {
  return (
    <Box>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: RISK_COLOR.high }} />
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>
          缺失 · {items.length}
        </Typography>
      </Stack>
      {items.length === 0 ? (
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, pl: 1.25 }}>无</Typography>
      ) : (
        <Stack spacing={0.75}>
          {items.map((m) => (
            <Box
              key={m.name}
              sx={{
                p: 1,
                borderRadius: '6px',
                bgcolor: alpha(RISK_COLOR.high, 0.05),
                border: `1px solid ${alpha(RISK_COLOR.high, 0.22)}`,
              }}
            >
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{m.name}</Typography>
                <Box
                  component="span"
                  sx={{
                    px: 0.6,
                    py: 0.1,
                    borderRadius: '4px',
                    fontSize: 10,
                    fontWeight: 600,
                    bgcolor: m.essential ? alpha(RISK_COLOR.high, 0.14) : alpha(COLORS.text, 0.08),
                    color: m.essential ? RISK_COLOR.high : COLORS.textMuted,
                  }}
                >
                  {m.essential ? '必需' : '可选'}
                </Box>
              </Stack>
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.25, lineHeight: 1.6 }}>
                为什么：{m.source}
              </Typography>
              <Typography sx={{ fontSize: 11, color: COLORS.textSecondary, mt: 0.25, lineHeight: 1.6 }}>
                怎么办：{m.action}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6 }}>{text}</Typography>
}
