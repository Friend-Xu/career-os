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
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { SimulationNodeDatum } from 'd3-force'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Handle, MarkerType, Position, ReactFlow, useNodesState } from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { INFO_EDGES, INFO_NODES, POOL_HEALTH } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { computePoolStats } from '../store/engine-client'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'
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
  role: '#C7A252',
  skill: '#8AB4F8',
}

type ForceNode = InfoNode & SimulationNodeDatum
type ForceLinkDatum = SimulationNodeDatum & { source: string; target: string }

/** 节点渲染尺寸估算（与节点组件样式一致）——布局期矩形碰撞用（渲染后由 React Flow 实测） */
function estimateSize(n: ForceNode): { w: number; h: number } {
  return {
    w: n.label.length * 12.5 + 24,
    h: n.matchScore != null ? 46 : 28,
  }
}

/**
 * 矩形碰撞力（替代 forceCollide 圆形）：按节点文字矩形做 AABB 检测，
 * 重叠则沿最小分离轴推离。长文本节点（决策标题等）不再互相贴边。
 * - fixed=false：力随 alpha 衰减（布局期与其他力共同收敛）
 * - fixed=true：固定强度推离（阶段 2 纯分离用，强制清除残留重叠）
 */
function rectCollide(estimate: (n: ForceNode) => { w: number; h: number }, fixed = false) {
  let nodesArr: ForceNode[]
  function force(alpha: number): void {
    for (let i = 0; i < nodesArr.length; i++) {
      const a = nodesArr[i]!
      for (let j = i + 1; j < nodesArr.length; j++) {
        const b = nodesArr[j]!
        const ah = estimate(a)
        const bh = estimate(b)
        const dx = a.x! - b.x!
        const dy = a.y! - b.y!
        const ox = ah.w / 2 + bh.w / 2 - Math.abs(dx)
        const oy = ah.h / 2 + bh.h / 2 - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        // 沿最小分离轴推离（更贴近矩形的分离方向）；fixed 模式强度不衰减（强制分离）
        const push = Math.min(ox, oy) * (fixed ? 0.9 : alpha)
        if (ox < oy) {
          const dir = dx > 0 ? 1 : -1
          a.x! += (push / 2) * dir
          b.x! -= (push / 2) * dir
        } else {
          const dir = dy > 0 ? 1 : -1
          a.y! += (push / 2) * dir
          b.y! -= (push / 2) * dir
        }
      }
    }
  }
  force.initialize = (nodes: SimulationNodeDatum[]) => {
    nodesArr = nodes as ForceNode[]
  }
  return force
}

/** 检测布局中是否仍有矩形重叠（阶段 2 收敛判定） */
function hasOverlap(nodes: ForceNode[], estimate: (n: ForceNode) => { w: number; h: number }): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!
      const ah = estimate(a)
      const bh = estimate(b)
      const ox = ah.w / 2 + bh.w / 2 - Math.abs(a.x! - b.x!)
      const oy = ah.h / 2 + bh.h / 2 - Math.abs(a.y! - b.y!)
      if (ox > 0 && oy > 0) return true
    }
  }
  return false
}

// ─── React Flow 图谱（节点拖拽/缩放平移/右键内置；布局用 d3-force 一次性收敛）──

/** type 别名（非 interface）：满足 React Flow 12 的 Node data Record<string, unknown> 约束 */
type PoolFlowNodeData = {
  node: InfoNode & { isolated: boolean }
  onOpen: () => void // 键盘无障碍入口（鼠标点击已取消，详情走右键菜单）
}
type PoolFlowNode = Node<PoolFlowNodeData, 'pool'>

/** 节点组件：样式平移自原手写 Box（颜色/孤立虚线/hover/匹配度），MUI 浅色延续 */
function PoolNodeView({ data }: NodeProps<PoolFlowNode>) {
  const { node, onOpen } = data
  const color = TYPE_COLOR[node.type]
  return (
    <Box
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onOpen) {
          e.preventDefault()
          onOpen()
        }
      }}
      sx={{
        position: 'relative',
        px: 1.25,
        py: 0.75,
        borderRadius: node.type === 'person' ? '20px' : '8px',
        bgcolor: alpha(color, 0.1),
        border: `1.5px ${node.isolated ? 'dashed' : 'solid'} ${color}`,
        cursor: 'grab',
        width: 'max-content',
        '&:hover': { bgcolor: alpha(color, 0.16) },
        '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: 2 },
        zIndex: node.type === 'person' ? 5 : 2,
        boxShadow: node.type === 'person' ? `0 0 20px ${alpha(color, 0.2)}` : 'none',
      }}
    >
      {/* 透明锚点：边附着必需（无连线交互，仅渲染边） */}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Typography
        sx={{
          fontSize: 12.5,
          fontWeight: node.type === 'person' ? 600 : 500,
          color: COLORS.text,
          whiteSpace: 'nowrap',
        }}
      >
        {node.label}
      </Typography>
      {node.matchScore != null && (
        <Typography sx={{ fontSize: 11.5, color: color, fontFamily: COLORS.mono, textAlign: 'center' }}>
          {node.matchScore}
        </Typography>
      )}
    </Box>
  )
}

/** nodeTypes 必须模块级稳定引用（React Flow 要求，避免重挂载） */
const NODE_TYPES = { pool: PoolNodeView }

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
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<PoolFlowNode>([])

  /** 搜索/类型过滤（渲染层 hidden，布局保持稳定） */
  const hiddenIds = useMemo(() => {
    const q = search.trim().toLowerCase()
    return new Set(
      nodes
        .filter((n) => {
          const matchType = typeFilter === 'all' || n.type === typeFilter
          const matchSearch = !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
          return !(matchType && matchSearch)
        })
        .map((n) => n.id),
    )
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

  // 布局：静态坐标作种子 + 弱力微调 + 矩形碰撞，一次性收敛后喂给 React Flow（拖拽由它接管）
  useEffect(() => {
    if (nodes.length === 0) {
      setFlowNodes([])
      return
    }
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
          .distance(100)
          .strength(0.55),
      )
      .force('charge', forceManyBody<ForceNode>().strength(-110))
      .force('collide', rectCollide(estimateSize))
      .force('center', forceCenter(cx, cy))
      .alphaDecay(0.03)
      .stop()
    for (let i = 0; i < 500 && sim.alpha() > 0.001; i++) sim.tick()
    // 阶段 2：移除其余力，纯矩形分离固定强度收敛（清除 alpha 衰减期推不动的残留重叠）
    sim
      .force('link', null)
      .force('charge', null)
      .force('center', null)
      .force('collide', rectCollide(estimateSize, true))
      .alpha(1)
      .stop()
    for (let i = 0; i < 400 && hasOverlap(sim.nodes(), estimateSize); i++) sim.tick()
    const pos = new Map(sim.nodes().map((d) => [d.id, { x: d.x ?? 0, y: d.y ?? 0 }]))
    setFlowNodes(
      nodes.map((n) => ({
        id: n.id,
        type: 'pool',
        position: pos.get(n.id) ?? { x: n.x ?? 0, y: n.y ?? 0 },
        data: {
          node: { ...n, isolated: isolatedIds.has(n.id) },
          onOpen: () => onNodeClick(n),
        },
      })),
    )
  }, [nodes, edges, isolatedIds, onNodeClick, setFlowNodes])

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const stroke =
          e.strength === 'high'
            ? alpha('#7FD962', 0.45)
            : e.strength === 'medium'
              ? alpha('#59C2FF', 0.4)
              : alpha(COLORS.text, 0.12)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          style: {
            stroke,
            strokeWidth: e.strength === 'high' ? 2 : 1.2,
            strokeDasharray: e.strength === 'low' ? '4 3' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
        }
      }),
    [edges],
  )

  return (
    <Box
      sx={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: COLORS.canvas,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <ReactFlow<PoolFlowNode>
        nodes={flowNodes.map((n) => (hiddenIds.has(n.id) ? { ...n, hidden: true } : n))}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        nodeOrigin={[0.5, 0.5]}
        onNodesChange={onFlowNodesChange}
        onNodeContextMenu={(e, nd) => {
          e.preventDefault()
          onNodeContext(e as unknown as MouseEvent, nd.data.node)
        }}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      />

      {/* Legend */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          zIndex: 5,
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
              {{ person: '人', decision: '决策', direction: '方向', city: '城市', company: '公司', role: '岗位', skill: '技能' }[type]}
            </Typography>
          </Stack>
        ))}
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, ml: 1 }}>
          绿线高配 · 蓝线中配 · 虚线低配/风险
        </Typography>
      </Stack>
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
