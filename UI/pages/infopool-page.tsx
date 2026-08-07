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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { SimulationNodeDatum } from 'd3-force'
import ForceGraph2D from 'react-force-graph-2d'
import { INFO_EDGES, INFO_NODES, POOL_HEALTH } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { computePoolStats } from '../store/engine-client'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'
import { resolveCompanyReference } from '../data/company-ref'
import type { InfoNode } from '../types'

/**
 * 类型色与风险色（绿/黄/红）完全错开，避免红色节点被误读为高风险。
 * person 紫 / decision 蓝 / direction 橙 / city 青 / company 粉 / role 金 / skill 浅蓝
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

// ─── 关系图谱（react-force-graph-2d）：实时力导向 + 拖拽让位 + hover 联动（Obsidian 关系图谱同款模式）──
// 标签防重叠（调研 d3-force-registry / d3-bboxCollide 定案，手写实现、零新增依赖）：
// 1. 标签框矩形碰撞力——AABB，position-based 硬约束（每 tick 直接改坐标、全强度 + 2 次迭代）
// 2. 链接长度随两端标签宽自适应（d3LinkDistance 访问器）——相连节点线长拉够，标签不被拉回重叠
// 3. 碰撞几何与绘制一致（离屏 measureText 实测字宽 + 标签框位于圆点上方）

type FgNode = InfoNode & { isolated: boolean }
type FgLink = { id: string; source: string; target: string; strength: 'high' | 'medium' | 'low' }

/** 边/节点强度配色（浅色主题，绿=高配 蓝=中配 灰=低配） */
const LINK_COLOR: Record<FgLink['strength'], string> = {
  high: '#7FD962',
  medium: '#59C2FF',
  low: '#9a9aa5',
}

/** 标签框碰撞几何：与 drawNode 绘制一致——label 框在圆点上方（高 22/24），下方可选 matchScore 小框。
 * hw=实测字宽/2+余量（绘制 padding 16 + 字体测量误差 4），hh 覆盖上下全高，offY=框中心相对节点的纵向偏移（负=上方） */
interface BoxGeom { hw: number; hh: number; offY: number }

// 离屏 canvas 实测字宽（与绘制同字体；按 label 缓存，避免碰撞力每 tick 重复 measureText）
let measureCtx: CanvasRenderingContext2D | null = null
const widthCache = new Map<string, number>()
function labelWidth(label: string, type: InfoNode['type']): number {
  const cached = widthCache.get(label)
  if (cached !== undefined) return cached
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = `600 ${type === 'person' ? 13.5 : 13}px "Geist", system-ui, sans-serif`
  const w = measureCtx.measureText(label).width
  widthCache.set(label, w)
  return w
}

/** 长标签像素截断（绘制 + 碰撞共用）：超长标签（"我 — 转行分析：xxx" 可到 297px）会把布局撑开，
 * 截断显示、碰撞按截断宽算；完整标签由 hover 提示（nodeLabel）与侧边栏详情兜底 */
const MAX_LABEL_PX = 110
function displayLabel(label: string, type: InfoNode['type']): string {
  if (labelWidth(label, type) <= MAX_LABEL_PX) return label
  let s = label
  while (s.length > 1 && labelWidth(s + '…', type) > MAX_LABEL_PX) s = s.slice(0, -1)
  return s + '…'
}

function boxGeom(n: { type: InfoNode['type']; label: string; matchScore?: number }): BoxGeom {
  const r = n.type === 'person' ? 8 : 6
  const boxH = n.type === 'person' ? 24 : 22
  const top = r + 8 + boxH // 标签框上沿
  const bottom = n.matchScore != null ? r + 22 : r + 8 // matchScore 小框下沿；无则到圆点
  return { hw: (labelWidth(displayLabel(n.label, n.type), n.type) + 20) / 2, hh: (top + bottom) / 2, offY: (bottom - top) / 2 }
}

/** 标签框之间的最小间距（px）——碰撞力与链接距离共用，保证链接目标 ≥ 碰撞需要 */
const COLLIDE_PAD = 4

/**
 * 标签框矩形碰撞力（替代圆形 collide——d3 内置 forceCollide 只支持圆形）。
 * d3-bboxCollide / d3.forceRectCollide 同款模式（position-based AABB + iterations(2)），
 * 推离随 alpha 缩放：初始（alpha 高）强推散开、冷却（alpha→0）弱化——让链接力主导最终布局。
 * 不重叠由"链接目标 ≥ 碰撞最小间距"保证（见 distance 访问器），碰撞力只负责过渡期与拖拽让位。
 * 通过 d3Force 添加（新增力安全；替换 link/charge 会破坏 force-graph 内部渲染，勿动）。
 */
function labelRectCollide(pad = COLLIDE_PAD) {
  let nodesArr: ForceNodeArr
  const geom = new WeakMap<FgNode, BoxGeom>()
  const geomOf = (n: FgNode): BoxGeom => {
    let g = geom.get(n)
    if (!g) {
      g = boxGeom(n)
      geom.set(n, g)
    }
    return g
  }
  function force(alpha: number): void {
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < nodesArr.length; i++) {
        const a = nodesArr[i]!
        const ga = geomOf(a)
        for (let j = i + 1; j < nodesArr.length; j++) {
          const b = nodesArr[j]!
          const gb = geomOf(b)
          const dx = a.x! - b.x!
          const dy = a.y! + ga.offY - (b.y! + gb.offY) // 框中心（含纵向偏移）
          const ox = ga.hw + gb.hw + pad - Math.abs(dx)
          const oy = ga.hh + gb.hh + pad - Math.abs(dy)
          if (ox <= 0 || oy <= 0) continue
          // 沿最小分离轴各推一半（矩形最短分离方向）；推离随 alpha 衰减但保留最低强度——
          // 冷却（alpha→0）时仍能消除被挤压产生的重叠（无链接节点对无链接力兜底，
          // 拖拽钉住的节点压住邻居时也靠它把邻居推开）
          const push = Math.min(ox, oy) * Math.max(alpha, 0.5)
          if (ox < oy) {
            const dir = dx > 0 ? 1 : -1
            a.x! += (push / 2) * dir
            b.x! -= (push / 2) * dir
          } else {
            const dir = dy > 0 ? 1 : -1
            a.y! += (oy / 2) * dir
            b.y! -= (oy / 2) * dir
          }
        }
      }
    }
  }
  force.initialize = (nodes: SimulationNodeDatum[]) => {
    nodesArr = nodes as ForceNodeArr
  }
  return force
}

type ForceNodeArr = (FgNode & SimulationNodeDatum)[]

/**
 * 语义预设布局：按节点类型摆位（人中心、决策环、方向/城市左簇、公司-角色-技能右簇）——
 * 种子距离与链接目标（≤130）同量级，链接力只需微调即可收敛（种子过远 + 强度有限 = 拉不到）。
 */
function semanticLayout(nodes: InfoNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const byType: Record<string, InfoNode[]> = {}
  for (const n of nodes) {
    ;(byType[n.type] ??= []).push(n)
  }
  // 人：中心
  ;(byType.person ?? []).forEach((n) => pos.set(n.id, { x: 0, y: 0 }))
  // 决策：人周围环
  ;(byType.decision ?? []).forEach((n, i) => {
    const a = (i / Math.max(1, byType.decision!.length)) * 2 * Math.PI
    pos.set(n.id, { x: Math.cos(a) * 150, y: Math.sin(a) * 130 })
  })
  // 方向/城市：左侧簇（贴近环，避免链式悬空）
  ;(byType.direction ?? []).forEach((n, i) => pos.set(n.id, { x: -160, y: 50 + i * 100 }))
  ;(byType.city ?? []).forEach((n, i) => pos.set(n.id, { x: -160, y: -60 - i * 100 }))
  // 公司：右侧簇（上下分布）
  ;(byType.company ?? []).forEach((n, i) => pos.set(n.id, { x: 200, y: -100 + i * 80 }))
  // 角色：公司簇下方
  ;(byType.role ?? []).forEach((n, i) => pos.set(n.id, { x: 200, y: 130 + i * 80 }))
  // 技能：最右网格
  ;(byType.skill ?? []).forEach((n, i) => {
    const col = Math.floor(i / 4)
    const row = i % 4
    pos.set(n.id, { x: 320 + col * 150, y: -100 + row * 85 })
  })
  // 未分组兜底：中心附近随机
  let fallback = 0
  for (const n of nodes) {
    if (!pos.has(n.id)) {
      const a = (fallback++ / Math.max(1, nodes.length)) * 2 * Math.PI
      pos.set(n.id, { x: Math.cos(a) * 200, y: Math.sin(a) * 180 })
    }
  }
  return pos
}

function GraphCanvas({
  nodes,
  edges,
  typeFilter,
  search,
  onNodeContext,
}: {
  nodes: InfoNode[];
  edges: typeof INFO_EDGES;
  typeFilter: string;
  search: string;
  onNodeContext: (e: MouseEvent, node: InfoNode) => void;
}) {
  // hover 状态存 ref（非 React state）：force-graph 的 nodeCanvasObject prop 更新链路不可靠，
  // drawNode 每帧执行时直接读 ref 最新值 → 重绘反映 hover（autoPauseRedraw=false 保证渲染循环常驻）
  const hoveredRef = useRef<string | null>(null)
  const fgRef = useRef<any>(undefined)

  /** 孤立节点：edges 中无任何连接的节点（健康检查，桥接真实数据后自动生效） */
  const linkedIds = useMemo(() => {
    const linked = new Set<string>()
    for (const e of edges) {
      linked.add(e.source)
      linked.add(e.target)
    }
    return linked
  }, [edges])

  /** hover 邻居索引：节点 id → { 邻居节点集, 相连边集 }（联动高亮用） */
  const neighborSets = useMemo(() => {
    const map = new Map<string, { nodes: Set<string>; links: Set<string> }>()
    for (const e of edges) {
      for (const id of [e.source, e.target]) {
        let s = map.get(id)
        if (!s) {
          s = { nodes: new Set([id]), links: new Set() }
          map.set(id, s)
        }
        s.nodes.add(e.source === id ? e.target : e.source)
        s.links.add(e.id)
      }
    }
    return map
  }, [edges])

  /** 搜索/类型过滤：graphData 子集 + 语义预设布局（团簇间距可控，力导向微调） */
  const data = useMemo(() => {
    const q = search.trim().toLowerCase()
    const visible = nodes.filter((n) => {
      const matchType = typeFilter === 'all' || n.type === typeFilter
      const matchSearch = !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
      return matchType && matchSearch
    })
    const visibleIds = new Set(visible.map((n) => n.id))
    const layout = semanticLayout(visible)
    return {
      nodes: visible.map((n) => {
        const p = layout.get(n.id) ?? { x: 0, y: 0 }
        return {
          ...n,
          isolated: !linkedIds.has(n.id),
          x: p.x,
          y: p.y,
          // person 钉在中心（人中心布局的语义锚点；拖拽时 force-graph 以 fx/fy 跟随，松手后停在拖拽处）
          fx: n.type === 'person' ? p.x : undefined,
          fy: n.type === 'person' ? p.y : undefined,
        }
      }),
      links: edges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((e) => ({ id: e.id, source: e.source, target: e.target, strength: e.strength })),
    }
  }, [nodes, edges, typeFilter, search, linkedIds])

  // 布局平衡（整体居中 + 团簇间距 + 标签框防重叠）：
  // - 标签框矩形碰撞力（position-based 硬约束，见 labelRectCollide）；随 data 重注册以绑定新节点数组
  // - 链接长度随两端标签宽自适应——标签宽则线长，相连节点不会被 link 力拉回重叠
  //   （react-force-graph-2d 类型未暴露 d3LinkDistance prop，forceLink.distance 访问器运行时具备，契约边界 cast）
  // - zoomToFit 由 onEngineStop 触发（布局稳定后整体居中）
  // 链接力参数（期望间距 + 统一强度）：每 tick 幂等重设——force-graph 内部 initSimulation 会重建
  // link force 实例抹掉直接设置（ref 仅暴露方法子集，无 linkDistance/linkStrength accessor），
  // onEngineTick 兜底保证任何重建后下一 tick 恢复
  const linkParamsRef = useRef<() => void>(() => {})
  linkParamsRef.current = () => {
    const lf = fgRef.current?.d3Force('link') as
      | { distance(fn: (link: unknown) => number): void; strength(v: number): void }
      | undefined
    if (!lf) return
    lf.distance((link) => {
      const l = link as { source: FgNode; target: FgNode }
      // 期望间距 = 标签自适应（上限 130），但不低于碰撞最小间距（hw 和 + pad）——
      // 保证链接力能真正拉近（目标 ≥ 碰撞需要时碰撞不顶开），吸附生效且冷却后标签不重叠
      const need = boxGeom(l.source).hw + boxGeom(l.target).hw + COLLIDE_PAD
      return Math.max(Math.min(boxGeom(l.source).hw + boxGeom(l.target).hw + 48, 130), need)
    })
    // 统一强度：默认按度倒数（单连叶节点满强度 1.0），0.5 均匀吸附（person 已钉中心，无拉偏风险）
    lf.strength(0.5)
    // 消除默认 charge 斥力（-30 会把团簇推开），布局完全由链接 + 碰撞决定
    ;(fgRef.current?.d3Force('charge') as { strength(v: number): void } | undefined)?.strength(0)
  }

  // 布局平衡（整体居中 + 团簇间距 + 标签框防重叠）：
  // - 标签框矩形碰撞力（见 labelRectCollide）；随 data 重注册以绑定新节点数组
  // - zoomToFit 由 onEngineStop 触发（布局稳定后整体居中）
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('collide', labelRectCollide())
    linkParamsRef.current()
  }, [data])

  /** 节点绘制：光晕圆点 + 标签（按 scale 分级显隐防重叠）；hover 时非邻居淡出（读 ref 最新值） */
  const drawNode = useCallback(
    (node: FgNode & { x: number; y: number }, ctx: CanvasRenderingContext2D, scale: number) => {
      const color = TYPE_COLOR[node.type]
      const r = node.type === 'person' ? 8 : 6
      const hovered = hoveredRef.current
      const dim = hovered !== null && hovered !== node.id && !neighborSets.get(hovered)?.nodes.has(node.id)
      ctx.save()
      ctx.globalAlpha = dim ? 0.12 : 1
      // 光晕（hover 增强）
      ctx.shadowColor = color
      ctx.shadowBlur = hovered === node.id ? 26 : 14
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = color
      ctx.fill()
      // 孤立节点：虚线外环
      if (node.isolated) {
        ctx.setLineDash([2, 2])
        ctx.strokeStyle = color
        ctx.lineWidth = 1.2
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.shadowBlur = 0
      // 标签分级显隐（Obsidian 式）：核心节点（人/公司/方向）早显示，细节节点（决策/技能/岗位）放大才显示——
      // 默认视图不糊在一起，缩放逐级展开；标签带半透明背景框（文字与线/节点清晰分离）
      const labelThreshold = node.type === 'person' || node.type === 'company' || node.type === 'direction' ? 0.7 : 1.2
      if (scale > labelThreshold) {
        const dLabel = displayLabel(node.label, node.type)
        ctx.font = `600 ${node.type === 'person' ? 13.5 : 13}px "Geist", system-ui, sans-serif`
        ctx.textAlign = 'center'
        const tw = ctx.measureText(dLabel).width
        const boxW = tw + 16
        const boxH = node.type === 'person' ? 24 : 22
        const bx = node.x - boxW / 2
        const by = node.y - r - 8 - boxH
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.strokeStyle = alpha(COLORS.border, 0.7)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(bx, by, boxW, boxH, 6)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = 'rgba(26, 26, 30, 0.92)'
        ctx.fillText(dLabel, node.x, by + boxH - 6.5)
        if (node.matchScore != null && scale > 1.1) {
          ctx.font = '11px ui-monospace, monospace'
          const mw = ctx.measureText(String(node.matchScore)).width
          const mbx = node.x - mw / 2 - 8
          const mby = node.y + r + 6
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.strokeStyle = alpha(COLORS.border, 0.6)
          ctx.beginPath()
          ctx.roundRect(mbx, mby, mw + 16, 16, 4)
          ctx.fill()
          ctx.stroke()
          ctx.fillStyle = color
          ctx.fillText(String(node.matchScore), node.x, mby + 11)
        }
      }
      ctx.restore()
    },
    [neighborSets],
  )

  /** 边绘制：线性渐变（source 实 → target 虚）+ hover 非邻居淡出 */
  const drawLink = useCallback(
    (link: FgLink & { source: { x: number; y: number }; target: { x: number; y: number } }, ctx: CanvasRenderingContext2D) => {
      const { source: s, target: t } = link
      if (s.x == null || t.x == null) return
      const hovered = hoveredRef.current
      const dim = hovered !== null && !neighborSets.get(hovered)?.links.has(link.id)
      ctx.save()
      ctx.globalAlpha = dim ? 0.06 : 1
      const grad = ctx.createLinearGradient(s.x, s.y, t.x, t.y)
      grad.addColorStop(0, `${LINK_COLOR[link.strength]}cc`)
      grad.addColorStop(1, `${LINK_COLOR[link.strength]}1f`)
      ctx.strokeStyle = grad
      ctx.lineWidth = link.strength === 'high' ? 1.6 : 1
      if (link.strength === 'low') ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(t.x, t.y)
      ctx.stroke()
      ctx.restore()
    },
    [neighborSets],
  )

  return (
    <Box
      sx={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: COLORS.canvas,
        borderRadius: '10px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
      }}
    >
      <ForceGraph2D
        ref={fgRef}
        // force-graph 链接类型为解析后节点对象；字符串 id 是运行时合法输入（内部映射），cast 处理
        graphData={data as any}
        nodeCanvasObject={drawNode}
        linkCanvasObject={drawLink}
        // 长标签截断后完整名称走 hover 提示（默认 HTML tooltip）
        nodeLabel={(node) => (node as FgNode).label}
        // 指针命中区域与绘制一致（自定义 nodeCanvasObject 后默认命中半径仅 1px，hover/右键都点不中）
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as FgNode
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, n.type === 'person' ? 7 : 5, 0, 2 * Math.PI)
          ctx.fill()
        }}
        onNodeHover={(node) => {
          hoveredRef.current = node ? (node as FgNode).id : null
        }}
        onNodeRightClick={(node, e) => onNodeContext(e as unknown as MouseEvent, node as FgNode)}
        // 拖拽后钉住节点（Obsidian 同款：拖到哪就留在哪）+ reheat 让碰撞力推开被压住的邻居
        // （force-graph 默认松手后清除 fx/fy 弹回原簇，且不 reheat——钉住后模拟已停、重叠残留）
        onNodeDragEnd={(node) => {
          const n = node as FgNode & SimulationNodeDatum
          n.fx = n.x
          n.fy = n.y
          fgRef.current?.d3ReheatSimulation()
        }}
        // 模拟冷却（布局稳定）后整体适配居中——初始 zoomToFit 太早（节点未散开，fit 范围错误）
        onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
        // 每 tick 幂等重设链接力参数（force-graph 重建 link force 时兜底恢复，见 linkParamsRef）
        onEngineTick={() => linkParamsRef.current()}
        // Obsidian 式行为：warmup 快速散开 → 冷却静止；拖拽自动 reheat（邻居让位）+ hover 联动
        // autoPauseRedraw=false：渲染循环常驻（hover/点击检测依赖它；冷却后停渲染则 hover 永不触发）
        autoPauseRedraw={false}
        d3AlphaMin={0.001}
        d3AlphaDecay={0.02}
        // 模拟冷却阈值调大：默认 cooldownTicks 150 在种子重叠未收敛时就停（布局停在中间态），
        // 600 tick（≈alpha 自然衰减到 0.001 的 340 tick 之上）保证链接力充分收敛
        cooldownTicks={600}
        d3VelocityDecay={0.35}
        warmupTicks={140}
        nodeRelSize={1}
        backgroundColor="rgba(0, 0, 0, 0)"
        minZoom={0.3}
        maxZoom={4}
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
          pointerEvents: 'none',
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
  const health = useAppStore((s) => s.health)
  const poolGraph = useAppStore((s) => s.poolGraph)
  const push = useToastStore((s) => s.push)

  const nodes = useMemo(() => poolGraph?.nodes ?? INFO_NODES, [poolGraph])
  const edges = poolGraph?.edges ?? INFO_EDGES

  /** 孤立节点数（真实计算：edges 无连接的节点） */
  const isolatedCount = useMemo(() => (poolGraph ? computePoolStats(poolGraph).isolated : 0), [poolGraph])

  // 健康投影（契约 v1）：优先 engine health 角标；offline → 图谱本地估算 → mock
  const healthPercent =
    health && engineStatus === 'connected'
      ? health.overallScore
      : engineStatus === 'connected' && nodes.length > 0
        ? Math.round((1 - isolatedCount / nodes.length) * 100)
        : POOL_HEALTH.healthPercent

  /** 当前右键节点的公司档案（仅 company 节点可能命中；label = canonical name，resolve 统一语义）。 */
  const menuCompany = menu ? resolveCompanyReference(companies, menu.node.label) : undefined

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

      {/* 节点类型过滤在侧栏（InfoPoolSidebar）——此处只消费过滤结果 */}

      {tab === 0 ? (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          typeFilter={infopoolFilter}
          search={search}
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
            border: `1px solid ${alpha(COLORS.border, 0.8)}`,
            boxShadow: COLORS.cardShadow,
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
