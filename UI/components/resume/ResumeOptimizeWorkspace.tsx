/**
 * 优化空间（R2.2）：Resume Alignment Projection 消费视图——四态 Requirement Card。
 * 契约：docs/domain/resume-alignment-projection-v0.1.md（resumes/alignment RPC，纯投影不落盘）。
 * P2.4：输入从「版本 × JD」迁移为「工作副本 × JD」——优化检查当前创作对象（ADR-023 §6），
 * 非历史版本；诊断引擎不变（working-copies/alignment 复用 computeResumeAlignment）。
 * - 四态：已覆盖 / 表达缺口 / 证据不足声明（红线）/ 能力缺口
 * - R2.2 边界：只展示四态 + 可追溯引用；不做 AI 改写 / 提案创建（P3 Opportunity Loop）
 * 派生模式（P2-2 提案通道）：源副本 × JD → 整份派生提案（Agent CLI 桥提交）→ 用户裁决
 * （accept → 引擎创建新工作副本；reject → 审计保留）。拆分视图 = 左源只读 / 右提案框，
 * 生成中毛玻璃蒙版覆盖右栏（backgroundTasks 'resume_derive'）。
 */
import { Box, Chip, MenuItem, Select, Stack, Typography, Button, CircularProgress, Checkbox, FormControlLabel } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { alpha, COLORS } from '../../data/constants'
import { workingCopyLabel } from '../../utils/resume-label'
import type { AlignmentState, ResumeAlignmentProjection } from '../../../engine/runtime/resume-alignment.ts'
import type { Opportunity } from '../../../engine/runtime/opportunity.ts'
import type { OpportunityProposal } from '../../../engine/storage/opportunity-proposal-registry.ts'
import type { ClaimProposal } from '../../../engine/storage/claim-proposal-registry.ts'
import type { DerivationProposal } from '../../../engine/storage/derivation-proposal-registry.ts'
import type { WorkingSection } from '../../../engine/ir/resume.ts'

const STATE_META: Record<AlignmentState, { icon: string; label: string; color: string }> = {
  covered: { icon: '✓', label: '已覆盖', color: COLORS.riskLow },
  expressive_gap: { icon: '△', label: '表达缺口', color: COLORS.riskMedium },
  unsupported_claim: { icon: '⚠', label: '证据不足声明', color: COLORS.riskHigh },
  capability_gap: { icon: '○', label: '能力缺口', color: COLORS.textMuted },
}

/** P3.5 UI Contract：机会用户语言映射——不暴露内部治理字段（claim/evidence/state） */
const OPPORTUNITY_META: Record<string, { icon: string; tag: string; color: string }> = {
  'improve_value': { icon: '🔴', tag: '提升表达覆盖', color: COLORS.riskMedium },
  'reduce_risk': { icon: '🔴', tag: '可信度检查', color: COLORS.riskHigh },
  'activate_asset': { icon: '🟡', tag: '可利用经历', color: COLORS.riskLow },
}

/** 派生提案状态（P2-2 提案通道——状态驱动视觉：待决定醒目，已决灰化留痕） */
const DERIVE_STATUS_META: Record<DerivationProposal['status'], { label: string; color: string }> = {
  pending: { label: '待决定', color: COLORS.riskMedium },
  accepted: { label: '已接受', color: COLORS.riskLow },
  rejected: { label: '已拒绝', color: COLORS.textMuted },
}

/** 影响范围（applyTarget 用户语言——不显示 blockId 系统标识） */
const TARGET_TEXT: Record<string, string> = {
  insert: '新增一条表达',
  rewrite: '改写已有表达',
  delete: '处理已有表达',
}

/** 拆分视图纸面渲染（只读 WorkingSection[] → A4 白纸样式；源副本与派生提案共用同一渲染器） */
function SectionPaper({ sections }: { sections: WorkingSection[] }) {
  if (sections.length === 0) {
    return (
      <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', py: 4 }}>
        暂无模块内容
      </Typography>
    )
  }
  return (
    <Box sx={{ bgcolor: '#fff', p: 3.5, borderRadius: '4px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', minHeight: 420 }}>
      {sections.map((s) => (
        <Box key={s.id} sx={{ mb: 2.5 }}>
          <Typography
            sx={{ fontSize: 13, fontWeight: 700, color: '#222', borderBottom: '1.5px solid #222', pb: 0.5, mb: 1, letterSpacing: '0.02em' }}
          >
            {s.title}
          </Typography>
          {(s.entries ?? []).map((e) => (
            <Box key={e.id} sx={{ mb: 1.25 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#222', lineHeight: 1.6 }}>
                {e.title}
                {e.role ? ` · ${e.role}` : ''}
                {e.period ? `（${e.period}）` : ''}
              </Typography>
              {e.description && (
                <Typography sx={{ fontSize: 12.5, color: '#555', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{e.description}</Typography>
              )}
              {e.blocks.map((b) => (
                <Typography key={b.id} sx={{ fontSize: 13, color: '#333', lineHeight: 1.65 }}>
                  • {b.text}
                </Typography>
              ))}
            </Box>
          ))}
          {s.blocks.map((b) => (
            <Typography key={b.id} sx={{ fontSize: 13, color: '#333', lineHeight: 1.65 }}>
              • {b.text}
            </Typography>
          ))}
          {(s.identity ?? []).map((f, i) => (
            <Typography key={i} sx={{ fontSize: 13, color: '#333', lineHeight: 1.65 }}>
              <Box component="span" sx={{ fontWeight: 700, color: '#222' }}>
                {f.label ? `${f.label}：` : ''}
              </Box>
              {f.body}
            </Typography>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export function ResumeOptimizeWorkspace() {
  const workingCopies = useAppStore((s) => s.workingCopies)
  const activeWorkingCopyId = useAppStore((s) => s.activeWorkingCopyId)
  const person = useAppStore((s) => s.currentPerson())
  const jobs = useAppStore((s) => s.jobs)
  const evidenceItems = useAppStore((s) => s.evidence)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const fetchWorkingCopyAlignment = useAppStore((s) => s.fetchWorkingCopyAlignment)
  const fetchWorkingCopyOpportunities = useAppStore((s) => s.fetchWorkingCopyOpportunities)
  const generateOpportunityProposals = useAppStore((s) => s.generateOpportunityProposals)
  const generateAssetCandidate = useAppStore((s) => s.generateAssetCandidate)
  const bindClaim = useAppStore((s) => s.bindClaim)
  const approveClaimProposal = useAppStore((s) => s.approveClaimProposal)
  const rejectClaimProposal = useAppStore((s) => s.rejectClaimProposal)
  const claimProposals = useAppStore((s) => s.claimProposals)
  const [wcId, setWcId] = useState('')
  const [jobId, setJobId] = useState('')
  const [projection, setProjection] = useState<ResumeAlignmentProjection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null)
  const [proposals, setProposals] = useState<OpportunityProposal[]>([])
  const [genState, setGenState] = useState<{ oppId: string; phase: string } | null>(null)
  const [genTick, setGenTick] = useState(0)
  const [applyResult, setApplyResult] = useState<{ proposalId: string; text: string; tone: 'ok' | 'conflict' } | null>(null)
  // P5.3 资产化面板：素材选择（用户主动——不自动扫描，ADR-027 边界）+ 生成状态
  const [assetPanel, setAssetPanel] = useState<{ oppId: string; selected: string[]; generating: boolean } | null>(null)
  const [bindResult, setBindResult] = useState<{ claimId: string; ok: boolean; text: string } | null>(null)
  // ─── 派生模式（P2-2 提案通道；mode 在 store——Dashboard 深链入口可直达派生 tab）──
  const mode = useAppStore((s) => s.resumeOptimizeMode)
  const setMode = useAppStore((s) => s.setResumeOptimizeMode)
  const [viewedProposalId, setViewedProposalId] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(true)
  const [deriveError, setDeriveError] = useState('')
  const derivationProposals = useAppStore((s) => s.derivationProposals)
  const backgroundTasks = useAppStore((s) => s.backgroundTasks)
  const generateDerivation = useAppStore((s) => s.generateDerivation)
  const decideDerivationProposal = useAppStore((s) => s.decideDerivationProposal)
  const cancelBackgroundTask = useAppStore((s) => s.cancelBackgroundTask)
  const push = useToastStore((s) => s.push)

  const personWorkingCopies = workingCopies.filter((w) => w.owner === person.personId)
  const wc = personWorkingCopies.find((w) => w.id === wcId) ?? personWorkingCopies.find((w) => w.id === activeWorkingCopyId)

  // 派生提案拉取（derivationProposalsChanged 事件驱动 store 全量刷新——本组件只读 store 投影）
  useEffect(() => {
    if (engineStatus !== 'connected') return
    void useAppStore.getState().listDerivationProposals()
  }, [engineStatus])

  // 进入派生模式：未显式选源 → 默认当前编辑对象（拆分视图左栏需要有源；覆盖 Dashboard 深链入口）
  useEffect(() => {
    if (mode === 'derive' && !wcId && activeWorkingCopyId) setWcId(activeWorkingCopyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  /** 当前配对（源副本 × JD）的提案（新在前）；viewed 缺省 = 最新 pending ?? 最新 */
  const pairProposals = useMemo(
    () =>
      derivationProposals
        .filter((p) => p.sourceWcId === wcId && p.jobId === jobId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [derivationProposals, wcId, jobId],
  )
  const viewed = pairProposals.find((p) => p.id === viewedProposalId) ?? pairProposals.find((p) => p.status === 'pending') ?? pairProposals[0] ?? null

  // 新候选自动聚焦：出现 pending 且当前未在看 pending → 重置到默认（最新 pending）
  useEffect(() => {
    const pending = pairProposals.find((p) => p.status === 'pending')
    if (pending && viewedProposalId !== pending.id) setViewedProposalId(null)
  }, [pairProposals, viewedProposalId])

  // 切换查看对象 → 变更说明重新展开
  useEffect(() => {
    setNotesOpen(true)
  }, [viewed?.id])

  // 切换配对 → 清除历史查看选择
  useEffect(() => {
    setViewedProposalId(null)
    setDeriveError('')
  }, [wcId, jobId])

  const deriveTaskEntry = Object.entries(backgroundTasks).find(([, t]) => t.type === 'resume_derive')
  const deriveRunning = Boolean(deriveTaskEntry)
  const pendingBadgeCount = derivationProposals.filter((p) => p.owner === person.personId && p.status === 'pending').length

  const startDerive = async () => {
    if (!wcId || !jobId) return
    setDeriveError('')
    try {
      await generateDerivation(wcId, jobId)
      push('info', '派生任务已启动——完成后右侧显示待确认提案')
    } catch (e: unknown) {
      setDeriveError(e instanceof Error ? e.message : '派生任务启动失败')
    }
  }

  const cancelDerive = async () => {
    if (!deriveTaskEntry) return
    try {
      await cancelBackgroundTask(deriveTaskEntry[0])
      push('info', '已取消派生任务')
    } catch (e: unknown) {
      setDeriveError(e instanceof Error ? e.message : '取消失败')
    }
  }

  const decideDerive = async (p: DerivationProposal, action: 'accept' | 'reject') => {
    setDeriveError('')
    try {
      if (action === 'accept') {
        const decided = await decideDerivationProposal(p.id, 'accept')
        push('success', `已接受派生——新副本「${selectedJob ? `${selectedJob.company} · ${selectedJob.title}` : decided.acceptedWcId ?? ''}」已创建`)
      } else {
        await decideDerivationProposal(p.id, 'reject')
        push('info', '已拒绝派生提案（审计保留，可重新生成）')
      }
    } catch (e: unknown) {
      setDeriveError(e instanceof Error ? e.message : '裁决失败')
    }
  }

  useEffect(() => {
    if (!wcId || !jobId || engineStatus !== 'connected') return
    let cancelled = false
    setLoading(true)
    setError('')
    fetchWorkingCopyAlignment(wcId, jobId)
      .then((p) => {
        if (!cancelled) setProjection(p)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setProjection(null)
          setError(e instanceof Error ? e.message : '对齐计算失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wcId, jobId, engineStatus, fetchWorkingCopyAlignment, genTick])

  /** 机会投影（P3.6：一等对象「为什么值得改」——选择变化/生成完成后重拉） */
  useEffect(() => {
    if (!wcId || !jobId || engineStatus !== 'connected') return
    let cancelled = false
    fetchWorkingCopyOpportunities(wcId, jobId)
      .then((ops) => {
        if (!cancelled) setOpportunities(ops)
      })
      .catch(() => {
        if (!cancelled) setOpportunities(null)
      })
    return () => {
      cancelled = true
    }
  }, [wcId, jobId, engineStatus, fetchWorkingCopyOpportunities, genTick])

  /** 机会 Proposal（P3.7：候选 diff——生成完成/采用/拒绝后重拉；业务状态轮询，不监听 agent 执行态） */
  useEffect(() => {
    if (engineStatus !== 'connected') return
    let cancelled = false
    useAppStore
      .getState()
      .listOpportunityProposals()
      .then((ps) => {
        if (!cancelled) setProposals(ps)
      })
      .catch(() => {
        if (!cancelled) setProposals([])
      })
    return () => {
      cancelled = true
    }
  }, [engineStatus, genTick])

  const titleOf = (eid: string) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid
  const selectedJob = jobs.find((j) => j.id === jobId)

  /** 候选「依据」用户化（P3.7：来源 = 证据事件标题——不显示 evidence id） */
  const proposalBasis = (o: Opportunity): string => {
    const titles = o.refs.evidenceIds.map(titleOf)
    return titles.length > 0 ? `来源：${titles.join('；')}` : '来源：暂无直接证据（需补充）'
  }

  const decide = async (p: OpportunityProposal, action: 'approve' | 'reject') => {
    try {
      if (action === 'approve') await useAppStore.getState().approveOpportunityProposal(p.id)
      else await useAppStore.getState().rejectOpportunityProposal(p.id)
      setGenTick((t) => t + 1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  /** 应用到简历（P3.8——approve ≠ apply 的 UI 表达：采用后单独「写入工作副本」；冲突 = 版本过期非失败） */
  const apply = async (p: OpportunityProposal) => {
    try {
      const res = await useAppStore.getState().applyOpportunityProposal(p.id)
      if (res.status === 'applied') {
        const ch = p.changes[0]
        setApplyResult({
          proposalId: p.id,
          text: `已应用 1 个表达调整${ch && ch.operation !== 'insert' && ch.before ? `：「${ch.before.slice(0, 30)}」→「${ch.after.slice(0, 30)}」` : ''} · Revision +1（${res.newRevision - 1} → ${res.newRevision}）`,
          tone: 'ok',
        })
      } else {
        setApplyResult({
          proposalId: p.id,
          text: `此建议基于旧版本生成（当时 Revision ${res.expectedRevision}），当前简历已有新的修改（Revision ${res.currentRevision}）——请重新生成候选。`,
          tone: 'conflict',
        })
      }
      setGenTick((t) => t + 1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '应用失败')
    }
  }

  /** 机会卡片标题（P3.5：用户语言——不暴露 state 内部名） */
  const opportunityTitle = useCallback(
    (o: Opportunity): string => {
      if (o.intent === 'improve_value') {
        const stmt =
          o.anchor.kind === 'alignment'
            ? jobs.find((j) => j.id === o.anchor.jobId)?.responsibilities.find((r) => r.id === o.anchor.responsibilityId)?.statement
            : undefined
        return `提升「${stmt ?? '岗位要求'}」的表达覆盖`
      }
      if (o.intent === 'reduce_risk') return '这段经历缺少当前岗位方向的支撑依据'
      return '岗位相关的经历尚未形成表达资产'
    },
    [jobs],
  )

  const opportunityReason = useCallback(
    (o: Opportunity): string => {
      if (o.intent === 'reduce_risk') {
        const stmt =
          o.anchor.kind === 'alignment'
            ? jobs.find((j) => j.id === o.anchor.jobId)?.responsibilities.find((r) => r.id === o.anchor.responsibilityId)?.statement
            : undefined
        return `简历中有表达与「${stmt ?? '岗位要求'}」相关，但缺少当前岗位方向的支撑依据——建议补充证据或调整表达。`
      }
      if (o.intent === 'activate_asset') {
        return `已有 ${o.refs.evidenceIds.length} 条经历与岗位相关，但尚未成为可引用的表达资产。`
      }
      return `${o.refs.evidenceIds.length} 条相关经历已有，但当前简历未体现——可在不新增事实的前提下补齐表达。`
    },
    [jobs],
  )

  const generate = async (o: Opportunity) => {
    setGenState({ oppId: o.id, phase: '生成改写方案中…' })
    try {
      await generateOpportunityProposals(o.id, wcId, person.personId ?? '')
      // 任务完成后轮询候选（agent 提交经引擎登记——以提案出现为完成信号）
      const deadline = Date.now() + 90_000
      const poll = async (): Promise<void> => {
        const proposals = await useAppStore.getState().listOpportunityProposals()
        if (proposals.some((p) => p.opportunityId === o.id)) {
          setGenState(null)
          setGenTick((t) => t + 1)
          return
        }
        if (Date.now() > deadline) {
          setGenState(null)
          return
        }
        setTimeout(() => void poll(), 2500)
      }
      void poll()
    } catch (e: unknown) {
      setGenState(null)
      setError(e instanceof Error ? e.message : '候选生成失败')
    }
  }

  // ─── P5.3 资产化（评审约束：素材选择用户主动——不自动扫描 Evidence，ADR-027 边界）──
  // 单用户个人工具：素材展示全部可信经历（不按 owner 隔离——历史数据归属迁移中）
  const usableEvidence = evidenceItems.filter((e) => e.lifecycle !== 'legacy' && e.status === 'trusted')
  const boundClaimIds = useMemo(() => {
    const s = new Set<string>()
    for (const w of workingCopies) for (const sec of w.sections) for (const b of sec.blocks) for (const c of b.provenanceLinks ?? []) s.add(c)
    return s
  }, [workingCopies])
  /** 资产提案本地增强：approve 返回的 claimId 关联（引擎 ClaimProposal 不持有——登记产物分离） */
  const [claimPairs, setClaimPairs] = useState<Record<string, string>>({})

  const toggleEvidence = (id: string) => {
    setAssetPanel((p) => (p ? { ...p, selected: p.selected.includes(id) ? p.selected.filter((x) => x !== id) : [...p.selected, id] } : p))
  }

  const generateAsset = async (o: Opportunity) => {
    if (!assetPanel || assetPanel.selected.length === 0) return
    setAssetPanel((p) => (p ? { ...p, generating: true } : p))
    try {
      await generateAssetCandidate(o.id, wcId, assetPanel.selected, person.personId ?? '')
      // 完成信号 = 关联机会的 ClaimProposal 出现（CLI 提交不经事件广播——轮询必须走 RPC 拉取）
      const deadline = Date.now() + 90_000
      const poll = async (): Promise<void> => {
        const list = await useAppStore.getState().listClaimProposals()
        if (list.some((p) => p.opportunityId === o.id)) {
          setAssetPanel((p) => (p ? { ...p, generating: false } : p))
          setGenTick((t) => t + 1)
          return
        }
        if (Date.now() > deadline) {
          setAssetPanel((p) => (p ? { ...p, generating: false } : p))
          return
        }
        setTimeout(() => void poll(), 2500)
      }
      void poll()
    } catch (e: unknown) {
      setAssetPanel((p) => (p ? { ...p, generating: false } : p))
      setError(e instanceof Error ? e.message : '资产候选生成失败')
    }
  }

  /** 采用资产候选（P1.1 通道：approve → Claim 登记；Claim 已生成 ≠ 已绑定——分开两步） */
  const approveAsset = async (cp: ClaimProposal) => {
    try {
      const { claimId } = await approveClaimProposal(cp.id)
      setClaimPairs((m) => ({ ...m, [cp.id]: claimId }))
      setGenTick((t) => t + 1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '采用失败')
    }
  }

  const rejectAsset = async (cp: ClaimProposal) => {
    try {
      await rejectClaimProposal(cp.id)
      setGenTick((t) => t + 1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '拒绝失败')
    }
  }

  /** 绑定到当前行（评审观察点：区分「资产已生成/等待绑定」vs「已绑定」） */
  const bindAsset = async (o: Opportunity, cp: ClaimProposal) => {
    const claimId = claimPairs[cp.id]
    const blockId = o.applyTarget?.blockId
    if (!claimId || !blockId) {
      setBindResult({ claimId: cp.id, ok: false, text: '该机会无绑定落点——请用改写路径处理表达' })
      return
    }
    try {
      const r = await bindClaim(wcId, blockId, claimId)
      setBindResult({
        claimId: cp.id,
        ok: r.status === 'bound',
        text:
          r.status === 'bound'
            ? '已绑定——该表达已挂接职业资产'
            : r.status === 'conflict'
              ? '绑定冲突：目标行已变化——刷新后重试（资产已保留）'
              : '绑定失败',
      })
      setGenTick((t) => t + 1)
    } catch (e: unknown) {
      setBindResult({ claimId: cp.id, ok: false, text: e instanceof Error ? e.message : '绑定失败' })
    }
  }

  /** 模式切换（store 态——Dashboard 深链与 tab 点击共用同一写入点） */
  const switchMode = (m: 'diagnose' | 'derive') => {
    setMode(m)
  }

  return (
    <Box sx={{ p: 2, maxWidth: mode === 'derive' ? 1180 : 860, mx: 'auto' }}>
      {/* 选择区：工作副本 × 目标 JD（P2.4——优化检查当前创作对象，非历史版本）+ 模式切换 */}
      <Box
        sx={{
          p: 1.5,
          mb: 2,
          borderRadius: '10px',
          border: `1px solid ${alpha(COLORS.border, 0.8)}`,
          boxShadow: COLORS.cardShadow,
          bgcolor: COLORS.bgElevated,
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
          <AutoAwesomeIcon sx={{ fontSize: 15, color: COLORS.accent }} />
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mr: 0.5 }}>对齐分析</Typography>
          <Select
            size="small"
            displayEmpty
            value={wcId}
            onChange={(e) => {
              setWcId(e.target.value as string)
              setProjection(null)
            }}
            sx={{ minWidth: 190, '& .MuiSelect-select': { fontSize: 12.5, py: 0.75 } }}
          >
            <MenuItem value="" disabled>
              选择工作副本
            </MenuItem>
            {personWorkingCopies.map((w) => (
              <MenuItem key={w.id} value={w.id} sx={{ fontSize: 12.5 }}>
                {workingCopyLabel(w, jobs)} · {w.status === 'promoted' ? '已发布' : '编辑中'}
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            displayEmpty
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value as string)
              setProjection(null)
            }}
            sx={{ minWidth: 220, '& .MuiSelect-select': { fontSize: 12.5, py: 0.75 } }}
          >
            <MenuItem value="" disabled>
              选择目标岗位
            </MenuItem>
            {jobs.map((j) => (
              <MenuItem key={j.id} value={j.id} sx={{ fontSize: 12.5 }}>
                {j.company} · {j.title}
              </MenuItem>
            ))}
          </Select>
          {engineStatus !== 'connected' && (
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>引擎离线——对齐计算不可用</Typography>
          )}
          {/* 模式切换：诊断（逐条提案）/ 派生（整份重写提案）——粒度不同所以层级并列 */}
          <Box
            sx={{
              ml: 'auto',
              display: 'flex',
              flexShrink: 0,
              borderRadius: '8px',
              border: `1px solid ${COLORS.border}`,
              overflow: 'hidden',
            }}
          >
            <Button
              size="small"
              disableRipple
              onClick={() => switchMode('diagnose')}
              sx={{
                px: 1.5,
                py: 0.5,
                borderRadius: 0,
                fontSize: 12,
                minWidth: 0,
                textTransform: 'none',
                fontWeight: mode === 'diagnose' ? 700 : 400,
                color: mode === 'diagnose' ? COLORS.accent : COLORS.textMuted,
                bgcolor: mode === 'diagnose' ? alpha(COLORS.accent, 0.1) : 'transparent',
              }}
            >
              诊断
            </Button>
            <Button
              size="small"
              disableRipple
              onClick={() => switchMode('derive')}
              sx={{
                px: 1.5,
                py: 0.5,
                borderRadius: 0,
                fontSize: 12,
                minWidth: 0,
                textTransform: 'none',
                fontWeight: mode === 'derive' ? 700 : 400,
                color: mode === 'derive' ? COLORS.accent : COLORS.textMuted,
                bgcolor: mode === 'derive' ? alpha(COLORS.accent, 0.1) : 'transparent',
              }}
            >
              派生
              {pendingBadgeCount > 0 && (
                <Box
                  component="span"
                  sx={{ ml: 0.5, fontSize: 10, px: 0.75, borderRadius: 8, bgcolor: COLORS.riskMedium, color: '#fff', lineHeight: '15px' }}
                >
                  {pendingBadgeCount}
                </Box>
              )}
            </Button>
          </Box>
        </Stack>
        {wc && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>当前分析对象：</Typography>
            <Chip
              size="small"
              label={`${workingCopyLabel(wc, jobs)} · 更新 ${wc.updatedAt.slice(5, 16).replace('T', ' ')}`}
              sx={{ height: 20, fontSize: 11, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
            />
            {selectedJob && (
              <Chip size="small" label={`目标岗位 ${selectedJob.company} · ${selectedJob.title}`} sx={{ height: 20, fontSize: 11, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }} />
            )}
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>诊断基于当前编辑内容（未资产化内容不参与证据投影）</Typography>
          </Stack>
        )}
      </Box>

      {/* ─── 诊断模式：对齐投影 + 发现机会（逐条提案——外科手术） ─── */}
      {mode === 'diagnose' && (
        <>
      {/* 引导态：未选择 */}
      {!wcId || !jobId ? (
        <Box
          sx={{
            p: 3,
            borderRadius: '10px',
            border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.5 }}>
            选择工作副本与目标岗位，查看岗位要求覆盖情况
          </Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
            对齐分析基于已有事实——检查「要求是否被可信表达覆盖」，不预测招聘系统
          </Typography>
        </Box>
      ) : loading ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>对齐计算中…</Typography>
        </Box>
      ) : error ? (
        <Box
          sx={{
            p: 2,
            borderRadius: '8px',
            bgcolor: alpha(COLORS.riskHigh, 0.08),
            border: `1px solid ${alpha(COLORS.riskHigh, 0.3)}`,
          }}
        >
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>{error}</Typography>
        </Box>
      ) : projection && projection.rows.length === 0 ? (
        <Box
          sx={{
            p: 3,
            borderRadius: '10px',
            border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.5 }}>
            该岗位尚未完成 JD 分析（无证据期望）
          </Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            先在 JD 空间完成分析后，此处可对齐岗位要求
          </Typography>
        </Box>
      ) : (
        projection && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>岗位要求覆盖</Typography>
              <Chip
                size="small"
                label={`${projection.rows.length} 项责任`}
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
              />
            </Stack>
            {projection.rows.map((row) => {
              const meta = STATE_META[row.state]
              return (
                <Box
                  key={row.responsibilityId}
                  sx={{
                    p: 1.5,
                    borderRadius: '10px',
                    border: `1px solid ${alpha(meta.color, row.state === 'unsupported_claim' ? 0.5 : 0.3)}`,
                    bgcolor:
                      row.state === 'unsupported_claim'
                        ? alpha(COLORS.riskHigh, 0.05)
                        : row.state === 'capability_gap'
                          ? alpha(COLORS.bgHover, 0.5)
                          : 'transparent',
                    boxShadow: COLORS.cardShadow,
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                    <Typography sx={{ fontSize: 11, fontFamily: COLORS.mono, color: meta.color, flexShrink: 0 }}>
                      {meta.icon}
                    </Typography>
                    <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>
                      {row.statement}
                    </Typography>
                    <Chip
                      size="small"
                      label={meta.label}
                      sx={{ height: 20, fontSize: 11, bgcolor: alpha(meta.color, 0.12), color: meta.color }}
                    />
                  </Stack>
                  <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                    {row.explanation}
                  </Typography>
                  {(row.evidenceRefs.length > 0 || row.claimRefs.length > 0) && (
                    <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5, lineHeight: 1.5 }}>
                      {row.evidenceRefs.length > 0 && `依据事实：${row.evidenceRefs.map(titleOf).join('、')}`}
                      {row.evidenceRefs.length > 0 && row.claimRefs.length > 0 ? ' · ' : ''}
                      {row.claimRefs.length > 0 && `${row.claimRefs.length} 条表达资产`}
                      {row.bulletRefs.length > 0 && ` · 简历表达：「${row.bulletRefs.join('；')}」`}
                    </Typography>
                  )}
                </Box>
              )
            })}
          </Stack>
        )
      )}

      {/* 发现机会（P3.6——契约 opportunity-ui-contract：系统发现「值得考虑的变化」，用户语言四段卡片） */}
      {wcId && jobId && (
        <Box sx={{ mt: 3 }}>
          {applyResult && (
            <Box
              sx={{
                p: 1.25,
                mb: 1,
                borderRadius: '10px',
                bgcolor: applyResult.tone === 'ok' ? alpha(COLORS.riskLow, 0.08) : alpha(COLORS.riskHigh, 0.07),
                border: `1px solid ${alpha(applyResult.tone === 'ok' ? COLORS.riskLow : COLORS.riskHigh, 0.3)}`,
              }}
            >
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>{applyResult.text}</Typography>
              {applyResult.tone === 'conflict' && (
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.5 }}>重新生成候选后即可应用新版本建议。</Typography>
              )}
            </Box>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700 }}>发现机会</Typography>
            <Chip
              size="small"
              label={`${opportunities?.length ?? 0} 项值得考虑的变化`}
              sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
            />
          </Stack>
          {!opportunities || opportunities.length === 0 ? (
            <Box
              sx={{
                p: 2,
                borderRadius: '10px',
                border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
                textAlign: 'center',
              }}
            >
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>当前工作副本与目标岗位无待处理变化</Typography>
            </Box>
          ) : (
            <Stack spacing={1}>
              {opportunities.map((o) => {
                const meta = OPPORTUNITY_META[o.intent] ?? { icon: '•', tag: o.intent, color: COLORS.textMuted }
                return (
                  <Box
                    key={o.id}
                    sx={{
                      p: 1.5,
                      borderRadius: '10px',
                      border: `1px solid ${alpha(meta.color, 0.3)}`,
                      bgcolor: 'transparent',
                      boxShadow: COLORS.cardShadow,
                    }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                      <Typography sx={{ fontSize: 12, flexShrink: 0 }}>{meta.icon}</Typography>
                      <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>{opportunityTitle(o)}</Typography>
                      <Chip size="small" label={meta.tag} sx={{ height: 20, fontSize: 11, bgcolor: alpha(meta.color, 0.12), color: meta.color }} />
                    </Stack>
                    <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>{opportunityReason(o)}</Typography>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.75, flexWrap: 'wrap', gap: 0.5 }}>
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                        影响：{o.applyTarget ? TARGET_TEXT[o.applyTarget.action] : '形成表达资产（走素材通道）'}
                      </Typography>
                      {/* P5.3 评审约束 ③：表达调整与资产补充是两个动作——不混合（防回退成简历魔改工具）。
                          仅红线型（refs 非空——有匹配证据待绑定）显示资产化入口；原生型无证据资产化无意义 */}
                      {o.anchor.state === 'unsupported_claim' && o.refs.evidenceIds.length > 0 && (
                        <Button
                          size="small"
                          onClick={() => setAssetPanel((p) => (p?.oppId === o.id ? null : { oppId: o.id, selected: [], generating: false }))}
                          sx={{
                            ml: 'auto',
                            fontSize: 11.5,
                            textTransform: 'none',
                            color: COLORS.riskHigh,
                            border: `1px solid ${alpha(COLORS.riskHigh, 0.35)}`,
                            borderRadius: '8px',
                            px: 1.25,
                            py: 0.25,
                            '&:hover': { bgcolor: alpha(COLORS.riskHigh, 0.08) },
                          }}
                        >
                          {assetPanel?.oppId === o.id ? '收起资产面板' : '补充职业资产'}
                        </Button>
                      )}
                      <Button
                        size="small"
                        disabled={genState?.oppId === o.id}
                        onClick={() => void generate(o)}
                        sx={{
                          fontSize: 11.5,
                          textTransform: 'none',
                          color: COLORS.accent,
                          border: `1px solid ${alpha(COLORS.accent, 0.35)}`,
                          borderRadius: '8px',
                          px: 1.25,
                          py: 0.25,
                          '&:hover': { bgcolor: alpha(COLORS.accent, 0.08) },
                        }}
                      >
                        {genState?.oppId === o.id ? <CircularProgress size={12} sx={{ mr: 0.75 }} /> : null}
                        {genState?.oppId === o.id ? genState.phase : o.intent === 'activate_asset' ? '生成表达资产' : '调整表达'}
                      </Button>
                    </Stack>
                    {/* P5.3 资产化面板（评审约束：素材选择用户主动——不自动扫描 Evidence） */}
                    {assetPanel?.oppId === o.id && (
                      <Box
                        sx={{
                          mt: 1,
                          p: 1.25,
                          borderRadius: '8px',
                          border: `1px solid ${alpha(COLORS.riskHigh, 0.25)}`,
                          bgcolor: alpha(COLORS.riskHigh, 0.04),
                        }}
                      >
                        <Typography sx={{ fontSize: 11.5, fontWeight: 600, mb: 0.5 }}>
                          补充职业资产——表达已存在，缺少可信资产绑定
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.75, lineHeight: 1.5 }}>
                          选择已有经历作为该表达的事实来源（系统不会自动搜索素材——由你决定）。
                        </Typography>
                        {usableEvidence.length === 0 ? (
                          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, py: 1 }}>暂无可用素材——先补充职业经历（素材库）</Typography>
                        ) : (
                          <Stack spacing={0.25} sx={{ maxHeight: 130, overflowY: 'auto', mb: 0.75 }}>
                            {usableEvidence.map((e) => (
                              <FormControlLabel
                                key={e.id}
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={assetPanel.selected.includes(e.id)}
                                    onChange={() => toggleEvidence(e.id)}
                                    sx={{ '& .MuiSvgIcon-root': { fontSize: 16 } }}
                                  />
                                }
                                label={
                                  <Typography sx={{ fontSize: 11.5 }}>
                                    {e.event.title}
                                    <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted }}>
                                      {' · '}
                                      {e.role}
                                    </Typography>
                                  </Typography>
                                }
                                sx={{ '& .MuiFormControlLabel-label': { minWidth: 0 } }}
                              />
                            ))}
                          </Stack>
                        )}
                        <Button
                          size="small"
                          disabled={assetPanel.selected.length === 0 || assetPanel.generating}
                          onClick={() => void generateAsset(o)}
                          sx={{
                            fontSize: 11.5,
                            textTransform: 'none',
                            color: COLORS.riskHigh,
                            border: `1px solid ${alpha(COLORS.riskHigh, 0.4)}`,
                            borderRadius: '8px',
                            px: 1.25,
                            py: 0.25,
                            '&:hover': { bgcolor: alpha(COLORS.riskHigh, 0.08) },
                          }}
                        >
                          {assetPanel.generating ? <CircularProgress size={12} sx={{ mr: 0.75 }} /> : null}
                          {assetPanel.generating ? '生成资产候选…' : `生成资产候选（已选 ${assetPanel.selected.length} 条经历）`}
                        </Button>
                        {/* 资产候选（P1.1 通道：AI 提供候选 → 用户采用 → Claim 登记 → 绑定） */}
                        {claimProposals
                          .filter((p) => p.opportunityId === o.id && p.source === 'opportunity_bridge')
                          .map((cp) => {
                            const claimId = claimPairs[cp.id]
                            const bound = Boolean(claimId) && boundClaimIds.has(claimId)
                            return (
                              <Box key={cp.id} sx={{ mt: 1, p: 1.25, borderRadius: '8px', border: `1px solid ${alpha(COLORS.border, 0.9)}`, bgcolor: alpha(COLORS.bgHover, 0.35) }}>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                                  <Typography sx={{ fontSize: 11.5, fontWeight: 700, flex: 1 }}>资产候选</Typography>
                                  <Chip
                                    size="small"
                                    label={cp.status === 'approved' ? (bound ? '已绑定 ✓' : '资产已生成，等待绑定') : cp.status === 'rejected' ? '已拒绝' : '待决定'}
                                    sx={{
                                      height: 18,
                                      fontSize: 10.5,
                                      bgcolor:
                                        cp.status === 'approved'
                                          ? bound
                                            ? alpha(COLORS.riskLow, 0.15)
                                            : alpha(COLORS.riskMedium, 0.12)
                                          : cp.status === 'rejected'
                                            ? alpha(COLORS.textMuted, 0.12)
                                            : alpha(COLORS.riskMedium, 0.12),
                                      color:
                                        cp.status === 'approved' ? (bound ? COLORS.riskLow : COLORS.riskMedium) : cp.status === 'rejected' ? COLORS.textMuted : COLORS.riskMedium,
                                    }}
                                  />
                                </Stack>
                                <Typography sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>{cp.proposedClaim.statement}</Typography>
                                <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.25, lineHeight: 1.5 }}>{cp.explanation}</Typography>
                                <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.25 }}>基于 {cp.evidenceRefs.length} 条已有经历</Typography>
                                {cp.status === 'pending' && (
                                  <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                                    <Button
                                      size="small"
                                      onClick={() => void approveAsset(cp)}
                                      sx={{
                                        fontSize: 11.5,
                                        textTransform: 'none',
                                        color: COLORS.riskLow,
                                        border: `1px solid ${alpha(COLORS.riskLow, 0.4)}`,
                                        borderRadius: '8px',
                                        px: 1.25,
                                        py: 0.25,
                                        '&:hover': { bgcolor: alpha(COLORS.riskLow, 0.08) },
                                      }}
                                    >
                                      采用
                                    </Button>
                                    <Button
                                      size="small"
                                      onClick={() => void rejectAsset(cp)}
                                      sx={{
                                        fontSize: 11.5,
                                        textTransform: 'none',
                                        color: COLORS.textMuted,
                                        border: `1px solid ${alpha(COLORS.border, 1)}`,
                                        borderRadius: '8px',
                                        px: 1.25,
                                        py: 0.25,
                                        '&:hover': { bgcolor: alpha(COLORS.bgHover, 0.6) },
                                      }}
                                    >
                                      拒绝
                                    </Button>
                                  </Stack>
                                )}
                                {cp.status === 'approved' && !bound && (
                                  <Button
                                    size="small"
                                    onClick={() => void bindAsset(o, cp)}
                                    sx={{
                                      mt: 0.75,
                                      fontSize: 11.5,
                                      textTransform: 'none',
                                      color: COLORS.riskLow,
                                      border: `1px solid ${alpha(COLORS.riskLow, 0.4)}`,
                                      borderRadius: '8px',
                                      px: 1.25,
                                      py: 0.25,
                                      '&:hover': { bgcolor: alpha(COLORS.riskLow, 0.08) },
                                    }}
                                  >
                                    绑定到当前行
                                  </Button>
                                )}
                                {bindResult?.claimId === cp.id && (
                                  <Typography sx={{ fontSize: 11, color: bindResult.ok ? COLORS.riskLow : COLORS.riskHigh, mt: 0.5 }}>
                                    {bindResult.text}
                                  </Typography>
                                )}
                              </Box>
                            )
                          })}
                      </Box>
                    )}
                    {/* 候选 diff（P3.7——契约：围绕 Proposal 不围绕文本；依据用户化；reject 保留） */}
                    {proposals.filter((p) => p.opportunityId === o.id).map((p) => {
                      const ch = p.changes[0]
                      return (
                        <Box
                          key={p.id}
                          sx={{
                            mt: 1,
                            p: 1.25,
                            borderRadius: '8px',
                            border: `1px solid ${alpha(COLORS.border, 0.9)}`,
                            bgcolor: alpha(COLORS.bgHover, 0.35),
                          }}
                        >
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
                            <Typography sx={{ fontSize: 11.5, fontWeight: 700, flex: 1 }}>候选方案</Typography>
                            <Chip
                              size="small"
                              label={p.status === 'approved' ? '已采用' : p.status === 'rejected' ? '已拒绝' : '待决定'}
                              sx={{
                                height: 18,
                                fontSize: 10.5,
                                bgcolor:
                                  p.status === 'approved'
                                    ? alpha(COLORS.riskLow, 0.15)
                                    : p.status === 'rejected'
                                      ? alpha(COLORS.textMuted, 0.12)
                                      : alpha(COLORS.riskMedium, 0.12),
                                color: p.status === 'approved' ? COLORS.riskLow : p.status === 'rejected' ? COLORS.textMuted : COLORS.riskMedium,
                              }}
                            />
                          </Stack>
                          {ch && (
                            <>
                              <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                                原表达{ch.operation === 'insert' ? '（新增）' : ''}：{ch.before || '（无）'}
                              </Typography>
                              <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>↓</Typography>
                              <Typography sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>
                                {ch.operation === 'delete' ? '删除该表达' : ch.after}
                              </Typography>
                              <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5 }}>{proposalBasis(o)}</Typography>
                            </>
                          )}
                          {p.status === 'pending' && (
                            <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                              <Button
                                size="small"
                                onClick={() => void decide(p, 'approve')}
                                sx={{
                                  fontSize: 11.5,
                                  textTransform: 'none',
                                  color: COLORS.riskLow,
                                  border: `1px solid ${alpha(COLORS.riskLow, 0.4)}`,
                                  borderRadius: '8px',
                                  px: 1.25,
                                  py: 0.25,
                                  '&:hover': { bgcolor: alpha(COLORS.riskLow, 0.08) },
                                }}
                              >
                                采用方案
                              </Button>
                              <Button
                                size="small"
                                onClick={() => void decide(p, 'reject')}
                                sx={{
                                  fontSize: 11.5,
                                  textTransform: 'none',
                                  color: COLORS.textMuted,
                                  border: `1px solid ${alpha(COLORS.border, 1)}`,
                                  borderRadius: '8px',
                                  px: 1.25,
                                  py: 0.25,
                                  '&:hover': { bgcolor: alpha(COLORS.bgHover, 0.6) },
                                }}
                              >
                                拒绝
                              </Button>
                            </Stack>
                          )}
                          {p.status === 'approved' && (
                            <Button
                              size="small"
                              onClick={() => void apply(p)}
                              sx={{
                                mt: 0.75,
                                fontSize: 11.5,
                                textTransform: 'none',
                                color: COLORS.riskLow,
                                border: `1px solid ${alpha(COLORS.riskLow, 0.4)}`,
                                borderRadius: '8px',
                                px: 1.25,
                                py: 0.25,
                                '&:hover': { bgcolor: alpha(COLORS.riskLow, 0.08) },
                              }}
                            >
                              应用到简历
                            </Button>
                          )}
                        </Box>
                      )
                    })}
                  </Box>
                )
              })}
            </Stack>
          )}
        </Box>
      )}
        </>
      )}

      {/* ─── 派生模式：拆分视图（整份重写提案——左源只读 / 右提案框；毛玻璃蒙版覆盖右栏） ─── */}
      {mode === 'derive' && (
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'stretch' }}>
          {/* 左：源副本（只读——生成中保持可读，用户对照原稿） */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              maxHeight: 'calc(100vh - 250px)',
              overflow: 'auto',
              borderRadius: '10px',
              border: `1px solid ${alpha(COLORS.border, 0.8)}`,
              bgcolor: '#FAFAFA',
              p: 1.5,
            }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 700, color: COLORS.textSecondary, flex: 1 }}>源副本（只读）</Typography>
              {wc && <Chip size="small" label={workingCopyLabel(wc, jobs)} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.08), color: COLORS.accent }} />}
            </Stack>
            {wc ? (
              <SectionPaper sections={wc.sections} />
            ) : (
              <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', py: 4 }}>
                先在左上选择区选择源副本
              </Typography>
            )}
          </Box>

          {/* 右：派生提案框（提案 = 右栏的框——内容、元信息、决策动作同一容器） */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              position: 'relative',
              maxHeight: 'calc(100vh - 250px)',
              overflow: 'auto',
              borderRadius: '10px',
              border: `1px solid ${alpha(COLORS.border, 0.8)}`,
              bgcolor: '#FAFAFA',
              p: 1.5,
            }}
          >
            {viewed ? (
              <>
                {/* 提案头：状态 + 决策动作 + 历史下拉 + 可折叠变更说明 */}
                <Box
                  sx={{
                    mb: 1,
                    p: 1.25,
                    borderRadius: '8px',
                    border: `1px solid ${alpha(viewed.status === 'pending' ? COLORS.accent : COLORS.border, 0.6)}`,
                    bgcolor: alpha(COLORS.bgHover, 0.35),
                  }}
                >
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>派生提案</Typography>
                    <Chip
                      size="small"
                      label={DERIVE_STATUS_META[viewed.status].label}
                      sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(DERIVE_STATUS_META[viewed.status].color, 0.12), color: DERIVE_STATUS_META[viewed.status].color }}
                    />
                    <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>生成于 {viewed.createdAt.slice(11, 16)}</Typography>
                    {viewed.status === 'accepted' && viewed.acceptedWcId && (
                      <Typography sx={{ fontSize: 11, color: COLORS.riskLow }}>已创建副本 {viewed.acceptedWcId}（选择器可见）</Typography>
                    )}
                    {pairProposals.length > 1 && (
                      <Select
                        size="small"
                        value={viewed.id}
                        onChange={(e) => setViewedProposalId(e.target.value as string)}
                        sx={{ ml: 'auto', fontSize: 11, height: 24, '& .MuiSelect-select': { py: 0.5, fontSize: 11 } }}
                      >
                        {pairProposals.map((p) => (
                          <MenuItem key={p.id} value={p.id} sx={{ fontSize: 11 }}>
                            {p.id.slice(-6)} · {DERIVE_STATUS_META[p.status].label}
                          </MenuItem>
                        ))}
                      </Select>
                    )}
                    {viewed.status === 'pending' && (
                      <>
                        <Button
                          size="small"
                          onClick={() => void decideDerive(viewed, 'accept')}
                          sx={{
                            ml: pairProposals.length > 1 ? 0 : 'auto',
                            fontSize: 11.5,
                            textTransform: 'none',
                            color: COLORS.riskLow,
                            border: `1px solid ${alpha(COLORS.riskLow, 0.4)}`,
                            borderRadius: '8px',
                            px: 1.25,
                            py: 0.25,
                            '&:hover': { bgcolor: alpha(COLORS.riskLow, 0.08) },
                          }}
                        >
                          接受
                        </Button>
                        <Button
                          size="small"
                          onClick={() => void decideDerive(viewed, 'reject')}
                          sx={{
                            fontSize: 11.5,
                            textTransform: 'none',
                            color: COLORS.textMuted,
                            border: `1px solid ${alpha(COLORS.border, 1)}`,
                            borderRadius: '8px',
                            px: 1.25,
                            py: 0.25,
                            '&:hover': { bgcolor: alpha(COLORS.bgHover, 0.6) },
                          }}
                        >
                          拒绝
                        </Button>
                      </>
                    )}
                    {viewed.status === 'rejected' && (
                      <Button
                        size="small"
                        disabled={deriveRunning}
                        onClick={() => void startDerive()}
                        sx={{
                          ml: 'auto',
                          fontSize: 11.5,
                          textTransform: 'none',
                          color: COLORS.accent,
                          border: `1px solid ${alpha(COLORS.accent, 0.35)}`,
                          borderRadius: '8px',
                          px: 1.25,
                          py: 0.25,
                          '&:hover': { bgcolor: alpha(COLORS.accent, 0.08) },
                        }}
                      >
                        重新生成
                      </Button>
                    )}
                  </Stack>
                  {/* 变更说明（决策时参考材料——默认展开，看完折叠让位全文） */}
                  <Button
                    size="small"
                    disableRipple
                    onClick={() => setNotesOpen((v) => !v)}
                    sx={{
                      mt: 0.75,
                      p: 0,
                      minWidth: 0,
                      fontSize: 11,
                      textTransform: 'none',
                      color: COLORS.textMuted,
                      '&:hover': { bgcolor: 'transparent', color: COLORS.accent },
                    }}
                  >
                    {notesOpen ? '收起变更说明 ▴' : `变更说明（${viewed.changeNotes.length} 条） ▾`}
                  </Button>
                  {notesOpen && (
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      {viewed.changeNotes.map((n, i) => (
                        <Typography key={i} sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                          • {n}
                        </Typography>
                      ))}
                    </Stack>
                  )}
                  {deriveError && (
                    <Typography sx={{ fontSize: 11.5, color: COLORS.riskHigh, mt: 0.5, lineHeight: 1.6 }}>{deriveError}</Typography>
                  )}
                </Box>
                <SectionPaper sections={viewed.sections} />
              </>
            ) : (
              /* 空态：生成入口 */
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, minHeight: 320, p: 3, textAlign: 'center' }}>
                <AutoAwesomeIcon sx={{ fontSize: 22, color: COLORS.accent }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                  {!wcId ? '先在左上选择区选择源副本与目标岗位' : '基于源副本与目标 JD 生成整份派生简历'}
                </Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.7, maxWidth: 340 }}>
                  派生结果先作为提案呈现——对照左栏原稿审核，接受后才创建新副本；拒绝则审计保留
                </Typography>
                {deriveError && (
                  <Typography sx={{ fontSize: 11.5, color: COLORS.riskHigh, lineHeight: 1.6, maxWidth: 340 }}>{deriveError}</Typography>
                )}
                <Button
                  size="small"
                  variant="contained"
                  disabled={!wcId || !jobId || engineStatus !== 'connected' || deriveRunning}
                  onClick={() => void startDerive()}
                  sx={{ mt: 0.5, fontSize: 12.5 }}
                >
                  生成派生
                </Button>
              </Box>
            )}
            {/* 生成中：毛玻璃蒙版只覆盖右栏（左栏源副本保持可读） */}
            {deriveRunning && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 3,
                  borderRadius: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1,
                  p: 2,
                  backdropFilter: 'blur(10px) saturate(150%)',
                  WebkitBackdropFilter: 'blur(10px) saturate(150%)',
                  bgcolor: alpha(COLORS.bgElevated, 0.55),
                  border: `1px solid ${alpha(COLORS.accent, 0.3)}`,
                }}
              >
                <CircularProgress size={22} sx={{ color: COLORS.accent }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>AI 正在生成派生简历…</Typography>
                <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>对照左栏原稿，完成后右侧显示待确认提案</Typography>
                <Button
                  size="small"
                  onClick={() => void cancelDerive()}
                  sx={{ mt: 0.5, px: 1, fontSize: 11, color: COLORS.riskHigh, border: `1px solid ${alpha(COLORS.riskHigh, 0.35)}` }}
                >
                  取消任务
                </Button>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}
