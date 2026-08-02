import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  Menu,
  MenuItem,
  InputAdornment,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import CloseIcon from '@mui/icons-material/Close'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ListIcon from '@mui/icons-material/List'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { SimulationNodeDatum } from 'd3-force'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { INFO_EDGES, INFO_NODES, POOL_HEALTH } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { computePoolStats } from '../store/engine-client'
import { alpha, COLORS, EASE, RISK_COLOR } from '../data/constants'
import type { InfoNode } from '../types'

/**
 * 类型色与风险色（绿/黄/红）完全错开，避免红色节点被误读为高风险。
 * person 紫 / decision 蓝 / direction 橙 / city 青 / company 粉
 */
const TYPE_COLOR: Record<InfoNode['type'], string> = {
  person: '#9081E4',
  decision: '#59C2FF',
  direction: '#F29A5E',
  city: '#5CE0B0',
  company: '#E77FC3',
}

type ForceNode = InfoNode & SimulationNodeDatum
type ForceLinkDatum = SimulationNodeDatum & { source: string; target: string }

function GraphCanvas({
  nodes,
  edges,
  typeFilter,
  search,
  onNodeContext,
  onNodeClick,
}: {
  nodes: InfoNode[];
  edges: typeof INFO_EDGES;
  typeFilter: string;
  search: string;
  onNodeContext: (e: MouseEvent, node: InfoNode) => void;
  onNodeClick: (node: InfoNode) => void;
}) {
  const [scale, setScale] = useState(1)

  /** 力导向位置缓存：全量节点布局，搜索/类型过滤只影响渲染、不重启模拟 */
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() =>
    Object.fromEntries(nodes.map((n) => [n.id, { x: n.x ?? 400, y: n.y ?? 280 }])),
  )

  /** 搜索/类型过滤（渲染层） */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return nodes.filter((n) => {
      const matchType = typeFilter === 'all' || n.type === typeFilter
      const matchSearch = !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
      return matchType && matchSearch
    })
  }, [nodes, search, typeFilter])

  /** 孤立节点：edges 中无任何连接的节点（健康检查，桥接真实数据后自动生效） */
  const isolatedIds = useMemo(() => {
    const linked = new Set<string>()
    for (const e of edges) {
      linked.add(e.source)
      linked.add(e.target)
    }
    return new Set(nodes.filter((n) => !linked.has(n.id)).map((n) => n.id))
  }, [nodes, edges])

  // 力导向：静态坐标作种子（保留语义布局）+ 弱力微调防重叠；nodes 全量变化才重启
  useEffect(() => {
    const cx = 520
    const cy = 300
    const sim = forceSimulation<ForceNode>(
      nodes.map((n) => ({
        ...n,
        x: n.x ?? cx + (Math.random() - 0.5) * 80,
        y: n.y ?? cy + (Math.random() - 0.5) * 80,
      })),
    )
      .force(
        'link',
        forceLink<ForceNode, ForceLinkDatum>(
          edges.map((e) => ({ source: e.source, target: e.target })),
        )
          .id((d) => d.id)
          .distance(88)
          .strength(0.55),
      )
      .force('charge', forceManyBody<ForceNode>().strength(-85))
      .force('collide', forceCollide(38))
      .force('center', forceCenter(cx, cy))
      .alphaDecay(0.06)
    sim.on('tick', () => {
      setPositions(
        Object.fromEntries(sim.nodes().map((d) => [d.id, { x: d.x ?? 0, y: d.y ?? 0 }])),
      )
    })
    return () => {
      sim.stop()
    }
  }, [nodes, edges])

  return (
    <Box
      onWheel={(e) => {
        e.preventDefault()
        setScale((s) => Math.min(2, Math.max(0.5, s - e.deltaY * 0.0015)))
      }}
      onDoubleClick={() => setScale(1)}
      sx={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: COLORS.canvas,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          transform: `scale(${scale})`,
          transformOrigin: 'center',
          transition: `transform 0.15s ${EASE}`,
        }}
      >
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={alpha(COLORS.text, 0.15)} />
          </marker>
        </defs>
        {edges.map((e) => {
          const s = positions[e.source]
          const t = positions[e.target]
          if (!s || !t) return null
          const stroke =
            e.strength === 'high'
              ? alpha('#7FD962', 0.45)
              : e.strength === 'medium'
                ? alpha('#59C2FF', 0.4)
                : alpha(COLORS.text, 0.12)
          const dash = e.strength === 'low' ? '4 3' : undefined
          const width = e.strength === 'high' ? 2 : 1.2
          return (
            <line
              key={e.id}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dash}
            />
          )
        })}
      </svg>

      {filtered.map((n, i) => {
        const color = TYPE_COLOR[n.type]
        const pos = positions[n.id] ?? { x: n.x ?? 0, y: n.y ?? 0 }
        const isolated = isolatedIds.has(n.id)
        return (
          <Box
            key={n.id}
            role="button"
            tabIndex={0}
            onClick={() => onNodeClick(n)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNodeClick(n)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onNodeContext(e, n)
            }}
            sx={{
              position: 'absolute',
              left: pos.x,
              top: pos.y,
              transform: 'translate(-50%, -50%)',
              px: 1.25,
              py: 0.75,
              borderRadius: n.type === 'person' ? '20px' : '8px',
              bgcolor: alpha(color, 0.1),
              border: `1.5px ${isolated ? 'dashed' : 'solid'} ${color}`,
              cursor: 'pointer',
              transition: `opacity 0.2s ${EASE}, border-color 0.2s ${EASE}, transform 0.15s ${EASE}`,
              animation: `fade-in 0.4s ${EASE} ${i * 0.04}s both`,
              '&:hover': {
                transform: 'translate(-50%, -50%) scale(1.06)',
                bgcolor: alpha(color, 0.16),
              },
              '&:focus-visible': {
                outline: `2px solid ${color}`,
                outlineOffset: 2,
              },
              zIndex: n.type === 'person' ? 5 : 2,
              boxShadow: n.type === 'person' ? `0 0 20px ${alpha(color, 0.2)}` : 'none',
            }}
          >
            <Typography sx={{ fontSize: 12.5, fontWeight: n.type === 'person' ? 600 : 500, color: COLORS.text, whiteSpace: 'nowrap' }}>
              {n.label}
            </Typography>
            {n.matchScore != null && (
              <Typography sx={{ fontSize: 11.5, color: color, fontFamily: COLORS.mono, textAlign: 'center' }}>
                {n.matchScore}
              </Typography>
            )}
          </Box>
        )
      })}

      {/* Legend */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          px: 1.5,
          py: 0.75,
          borderRadius: '8px',
          bgcolor: alpha(COLORS.canvas, 0.85),
          border: `1px solid ${COLORS.border}`,
        }}
      >
        {Object.entries(TYPE_COLOR).map(([type, color]) => (
          <Stack key={type} direction="row" sx={{ alignItems: 'center' }} spacing={0.5}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              {{ person: '人', decision: '决策', direction: '方向', city: '城市', company: '公司' }[type]}
            </Typography>
          </Stack>
        ))}
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, ml: 1 }}>
          绿线高配 · 蓝线中配 · 虚线低配/风险
        </Typography>
      </Stack>
      </Box>
    </Box>
  )
}

export function InfoPoolPage() {
  const [tab, setTab] = useState(0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<InfoNode | null>(null)
  const [menu, setMenu] = useState<{ anchor: { top: number; left: number }; node: InfoNode } | null>(null)
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const infopoolFilter = useAppStore((s) => s.infopoolFilter)
  const decisions = useAppStore((s) => s.decisions)
  const companies = useAppStore((s) => s.companies)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const poolGraph = useAppStore((s) => s.poolGraph)
  const push = useToastStore((s) => s.push)

  const nodes = useMemo(() => poolGraph?.nodes ?? INFO_NODES, [poolGraph])
  const edges = poolGraph?.edges ?? INFO_EDGES

  /** 孤立节点数（真实计算：edges 无连接的节点） */
  const isolatedCount = useMemo(() => (poolGraph ? computePoolStats(poolGraph).isolated : 0), [poolGraph])

  const healthPercent =
    engineStatus === 'connected' && nodes.length > 0
      ? Math.round((1 - isolatedCount / nodes.length) * 100)
      : POOL_HEALTH.healthPercent

  /** 当前右键节点的公司档案（仅 company 节点可能命中）。 */
  const menuCompany = menu ? companies.find((c) => c.name === menu.node.label) : undefined

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return nodes.filter((n) => {
      const matchType = infopoolFilter === 'all' || n.type === infopoolFilter
      const matchSearch =
        !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
      return matchType && matchSearch
    })
  }, [nodes, search, infopoolFilter])

  /** IR 降级：validation.invalid 的决策记录 + 公司档案（引擎已把它们排除出图谱，列表视图单独呈现） */
  const invalidItems = useMemo(
    () => [
      ...decisions
        .filter((d) => d.validation?.status === 'invalid')
        .map((d) => ({
          id: d.id,
          kind: 'decision' as const,
          label: d.title,
          reason: (d.validation?.issues ?? []).map((i) => i.reason).join('；'),
        })),
      ...companies
        .filter((c) => c.validation?.status === 'invalid')
        .map((c) => ({
          id: c.id,
          kind: 'company' as const,
          label: c.name,
          reason: (c.validation?.issues ?? []).map((i) => i.reason).join('；'),
        })),
    ],
    [decisions, companies],
  )

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>信息池</Typography>
        <Chip
          size="small"
          label={`健康 ${healthPercent}% · ${nodes.length} 节点 · 孤立 ${isolatedCount}`}
          sx={{ height: 22, fontSize: 12, bgcolor: alpha(COLORS.riskLow, 0.1), color: COLORS.riskLow }}
        />
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          placeholder="搜索节点…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: COLORS.textMuted }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: 200, '& .MuiOutlinedInput-root': { height: 30, fontSize: 12 } }}
        />
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30 }}>
          <Tab icon={<AccountTreeIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="图谱" sx={{ minHeight: 30 }} />
          <Tab icon={<ListIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="列表" sx={{ minHeight: 30 }} />
        </Tabs>
      </Stack>

      {tab === 0 ? (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          typeFilter={infopoolFilter}
          search={search}
          onNodeClick={setSelected}
          onNodeContext={(e, node) => {
            setMenu({ anchor: { top: e.clientY, left: e.clientX }, node })
          }}
        />
      ) : (
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            borderRadius: '10px',
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.bgElevated,
          }}
        >
          {infopoolFilter === 'invalid' ? (
            invalidItems.length === 0 ? (
              <Typography sx={{ p: 4, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
                无待人工处理的记录
              </Typography>
            ) : (
              invalidItems.map((d) => (
                <Stack
                  key={d.id}
                  direction="row"
                  spacing={1.5}
                  sx={{
                    alignItems: 'center',
                    px: 2,
                    py: 1.25,
                    borderBottom: `1px solid ${COLORS.border}`,
                    borderLeft: `3px solid ${RISK_COLOR.high}`,
                  }}
                >
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: RISK_COLOR.high, flexShrink: 0 }} />
                  <Stack sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap>
                      {d.label}
                    </Typography>
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }} noWrap>
                      {d.reason}
                    </Typography>
                  </Stack>
                  <Chip
                    size="small"
                    label={d.kind === 'decision' ? '决策' : '公司'}
                    sx={{
                      height: 20,
                      fontSize: 11.5,
                      bgcolor: alpha(RISK_COLOR.high, 0.1),
                      color: RISK_COLOR.high,
                      flexShrink: 0,
                    }}
                  />
                </Stack>
              ))
            )
          ) : filteredNodes.length === 0 ? (
            <Typography sx={{ p: 4, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              无此类节点（演示数据未包含）
            </Typography>
          ) : (
            filteredNodes.map((n) => (
              <Stack
                key={n.id}
                direction="row"
                spacing={1.5}
                onClick={() => setSelected(n)}
                sx={{
                  alignItems: 'center',
                  px: 2,
                  py: 1.25,
                  borderBottom: `1px solid ${COLORS.border}`,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: COLORS.bgHover },
                }}
              >
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TYPE_COLOR[n.type] }} />
                <Typography sx={{ fontSize: 13, flex: 1 }}>{n.label}</Typography>
                <Chip size="small" label={n.type} sx={{ height: 20, fontSize: 11.5 }} />
                {n.matchScore != null && (
                  <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}>
                    {n.matchScore}
                  </Typography>
                )}
              </Stack>
            ))
          )}
        </Box>
      )}

      <Menu
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu?.anchor}
      >
        <MenuItem
          onClick={() => {
            if (menu) setSelected(menu.node)
            setMenu(null)
          }}
        >
          查看详情
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) {
              startAnalysis(`请重新评估信息池节点「${menu.node.label}」：更新匹配度与风险`)
              push('info', '已预置「重新评估」上下文')
            }
            setMenu(null)
          }}
        >
          重新评估
        </MenuItem>
        {/* 尽调/投递仅对公司节点开放：有档案 → 更新尽调 / 加入投递；无档案 → 提示先建档案 */}
        {menu?.node.type === 'company' &&
          (menuCompany ? (
            <>
              <MenuItem
                onClick={() => {
                  setLocateTarget(menuCompany.id)
                  setMenu(null)
                  setPage('companies')
                  push('info', `已定位「${menuCompany.name}」· 更新尽调`)
                }}
              >
                更新尽调
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenu(null)
                  setPage('applications')
                  push('info', `「${menuCompany.name}」· 投递写入将在阶段 3 接入`)
                }}
              >
                加入投递
              </MenuItem>
            </>
          ) : (
            <MenuItem
              onClick={() => {
                setMenu(null)
                push('info', `「${menu?.node.label}」无对应公司档案，尽调需先创建档案（阶段 3 接入）`)
              }}
            >
              开始尽调
            </MenuItem>
          ))}
      </Menu>

      <Drawer
        anchor="right"
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        slotProps={{
          paper: {
            sx: {
              width: 360,
              bgcolor: COLORS.bgElevated,
              borderLeft: `1px solid ${COLORS.border}`,
              backgroundImage: 'none',
            },
          },
        }}
      >
        {selected && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
              <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{selected.label}</Typography>
              <IconButton size="small" onClick={() => setSelected(null)}>
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Stack>
            <Chip
              size="small"
              label={selected.type}
              sx={{ mb: 2, bgcolor: alpha(TYPE_COLOR[selected.type], 0.13), color: TYPE_COLOR[selected.type] }}
            />
            <Stack spacing={1.25}>
              <Row label="类型" value={selected.type} />
              {selected.matchScore != null && <Row label="匹配度" value={`${selected.matchScore}%`} />}
              {selected.riskLevel && (
                <Row
                  label="风险"
                  value={selected.riskLevel}
                  color={RISK_COLOR[selected.riskLevel]}
                />
              )}
              <Row label="协议" value="info-pool v2.1" />
            </Stack>
            <Stack spacing={1} sx={{ mt: 3 }}>
              <Button
                variant="outlined"
                fullWidth
                size="small"
                onClick={() => push('info', '演示模式：文件系统接入将在阶段 3 实现')}
              >
                打开记录文件
              </Button>
              <Button
                variant="contained"
                fullWidth
                size="small"
                onClick={() => {
                  setSelected(null)
                  setPage('companies')
                }}
              >
                跳转公司探索
              </Button>
            </Stack>
          </Box>
        )}
      </Drawer>
    </Box>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 500, color: color ?? COLORS.text }}>{value}</Typography>
    </Stack>
  )
}
