/**
 * 公司空间主区：双视图（主区顶部切换；侧栏 CompaniesSidebar 的公司卡片列表两视图联动）——
 * 「公司档案」：左侧公司卡片（460px：标签/尽调摘要/差距分析/操作/JD）+ 右侧尽调详情正文（companies/get md 原文）
 * 「地图探索」：高德真实地图（公司按真实经纬度散点，key/安全密钥来自 config.json map 段），
 * 点公司 → 高亮 + 摘要浮卡 → 「查看档案」切回；未配置 key 时显示引导空态。
 */
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { load as loadAMap } from '@amap/amap-jsapi-loader'
import '@amap/amap-jsapi-types'
import { GapAnalysisSection } from '../components/gap-analysis-section'
import { getEngine, useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import { resolveCompanyReference } from '../data/company-ref'
import type { Company } from '../types'
import type { CompanyDetail } from '../store/engine-client'
import type { Validation } from '../../engine/ir/schema.ts'

/** store companies 成员（CompanyRecord + validation 标记；占位公司 = invalid = 待尽调） */
type CompanyWithValidation = Company & { validation?: Validation }

/** 城市 → 经纬度（高德 GCJ-02 坐标系，城市中心近似）；未收录城市落中部默认点 */
const CITY_COORDS: Record<string, [number, number]> = {
  北京: [116.4, 39.9],
  上海: [121.47, 31.23],
  杭州: [120.15, 30.28],
  深圳: [114.06, 22.55],
  苏州: [120.58, 31.3],
  常州: [119.97, 31.81],
}

/** POI 搜索精确定位：会话级缓存（切视图/重建不重复搜索，刷新后重搜）+ 串行队列（高德搜索有 QPS 限制） */
const poiCache = new Map<string, [number, number]>()
let poiSearchChain: Promise<unknown> = Promise.resolve()

interface PoiHit {
  name: string
  location: { lng: number; lat: number }
}

/** 公司名 → 高德 POI 搜索取精确经纬度；无命中/搜索失败返回 null（调用方回退城市中心） */
function searchCompanyPoi(amap: typeof AMap, c: Company): Promise<[number, number] | null> {
  // types 包未收录 PlaceSearch/plugin 完整签名，结构化断言（外部 API 边界）
  const amapApi = amap as unknown as {
    plugin: (name: string, cb: () => void) => void
    PlaceSearch: new (opts: { city: string; citylimit: boolean; pageSize: number }) => {
      search: (
        keyword: string,
        cb: (status: string, result: { poiList?: { pois?: PoiHit[] } }) => void,
      ) => void
    }
  }
  const run = (): Promise<[number, number] | null> =>
    new Promise((resolve) => {
      // 官方教程标准：AMap.plugin 按需加载（幂等；loader plugins 已声明时立即回调）
      amapApi.plugin('AMap.PlaceSearch', () => {
        const placeSearch = new amapApi.PlaceSearch({ city: c.city, citylimit: true, pageSize: 5 })
        placeSearch.search(c.name, (status, result) => {
          // 2.0 插件回调结构：result.poiList.pois；location 为 AMap.LngLat 对象（.lng/.lat，JSON 显示数组是 toJSON）
          const pois = result.poiList?.pois
          if (status !== 'complete' || !pois || pois.length === 0) {
            resolve(null)
            return
          }
          // 匹配策略：名称归一化完全相等 > 名称互相包含 > 首条（citylimit 已强制同城）
          const norm = (s: string) => s.replace(/[（(].*?[）)]/g, '').replace(/(股份有限公司|有限公司|公司|集团)/g, '')
          const target = norm(c.name)
          const exact = pois.find((p) => norm(p.name) === target)
          const partial =
            exact ??
            pois.find((p) => norm(p.name).includes(target) || target.includes(norm(p.name)))
          const hit = partial ?? pois[0]
          resolve([hit.location.lng, hit.location.lat])
        })
      })
    })
  poiSearchChain = poiSearchChain.then(run).catch(() => null)
  return poiSearchChain as Promise<[number, number] | null>
}

/** 公司打点位置：城市经纬度 + 同城按索引偏移散开（确定性，不随渲染跳动） */
function companyPos(c: Company, idx: number): [number, number] {
  const base = CITY_COORDS[c.city] ?? [113.5, 33]
  return [base[0] + ((idx % 5) - 2) * 0.06, base[1] + ((idx % 3) - 1) * 0.06]
}

/** 定位图钉图标（SVG dataURL）：风险色填充 + 白描边 + 白心；针尖 anchor bottom 对准位置点 */
function pinSvg(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34">` +
    `<path d="M14 0C6.27 0 0 6.27 0 14c0 9.8 12.4 19.6 13.2 20.2.5.3 1.1.3 1.6 0C15.6 33.6 28 23.8 28 14 28 6.27 21.73 0 14 0z" fill="${color}" stroke="#ffffff" stroke-width="2"/>` +
    `<circle cx="14" cy="13.5" r="5" fill="#ffffff"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 公司 LabelMarker 构建（定位图钉图标，不显示文字——完全不遮挡底图标注；
 * 公司名/风险信息由点击后的摘要浮卡承载）。选中 = accent 色 + rank 提升（不被避让隐藏）。
 */
function labelMarkerOptions(c: Company, active: boolean, idx: number) {
  const color = active ? COLORS.accent : RISK_COLOR[c.riskLevel]
  return {
    position: poiCache.get(c.id) ?? companyPos(c, idx),
    rank: active ? 100 : 1,
    zIndex: active ? 100 : 1,
    icon: { type: 'image' as const, image: pinSvg(color), size: [28, 34] as [number, number], anchor: 'bottom' as const },
  }
}

/** 尽调详情正文 markdown 组件映射（贴合浅色瑞士风；h1 已在卡片头展示，缩为小节） */
const MD_COMPONENTS: Components = {
  h2: ({ children }) => (
    <Typography sx={{ fontSize: 15, fontWeight: 600, mb: 1.5, mt: 3, color: COLORS.text }}>{children}</Typography>
  ),
  h3: ({ children }) => (
    <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 1, mt: 2.5, color: COLORS.text }}>{children}</Typography>
  ),
  p: ({ children }) => (
    <Typography sx={{ fontSize: 13.5, lineHeight: 1.8, color: COLORS.textSecondary, mb: 1.5 }}>{children}</Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ color: COLORS.text, fontWeight: 600 }}>{children}</Box>
  ),
  ul: ({ children }) => <Box component="ul" sx={{ pl: 3, mb: 1.5 }}>{children}</Box>,
  ol: ({ children }) => <Box component="ol" sx={{ pl: 3, mb: 1.5 }}>{children}</Box>,
  li: ({ children }) => (
    <Box component="li" sx={{ fontSize: 13.5, lineHeight: 1.8, color: COLORS.textSecondary, mb: 0.5 }}>{children}</Box>
  ),
}

/** 「地图探索」视图：高德真实地图 + 公司经纬度散点；点公司 → 高亮 + 右上摘要浮卡 */
function MapView() {
  const mapSettings = useAppStore((s) => s.agentSettings.map)
  const companies = useAppStore((s) => s.companies)
  const selectedCompanyId = useAppStore((s) => s.selectedCompanyId)
  const setSelectedCompanyId = useAppStore((s) => s.setSelectedCompanyId)
  const setView = useAppStore((s) => s.setCompaniesView)
  const setPage = useAppStore((s) => s.setPage)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<AMap.Map | null>(null)
  const amapRef = useRef<typeof AMap | null>(null)
  const labelsLayerRef = useRef<AMap.LabelsLayer | null>(null)
  const markersRef = useRef<Map<string, AMap.LabelMarker>>(new Map())
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const selected = companies.find((c) => c.id === selectedCompanyId) ?? null

  // 地图初始化（key/安全密钥变化时重建；卸载时销毁）
  useEffect(() => {
    if (!mapSettings?.apiKey) return
    // 官方安全密钥机制：loader 从 window._AMapSecurityConfig 读取（JS API 加载教程），非 loader 参数
    if (mapSettings.securityJsCode) {
      ;(window as unknown as { _AMapSecurityConfig?: { securityJsCode: string } })._AMapSecurityConfig = {
        securityJsCode: mapSettings.securityJsCode,
      }
    }
    let cancelled = false
    setLoadState('loading')
    const opts = {
      key: mapSettings.apiKey,
      version: '2.0',
      plugins: ['AMap.PlaceSearch'],
    } as Parameters<typeof loadAMap>[0]
    void loadAMap(opts)
      .then((amap) => {
        if (cancelled || !containerRef.current) return
        const AMapNs = amap as typeof AMap
        amapRef.current = AMapNs
        mapRef.current = new AMapNs.Map(containerRef.current, {
          viewMode: '2D',
          zoom: 5,
          center: [113.5, 33],
        })
        // 公司标注层：collision（公司间避让）；allowCollision 必须 false——
        // true 会让底图 POI 文字避让隐藏（实测全图文字消失），false 则底图文字正常显示
        labelsLayerRef.current = new AMapNs.LabelsLayer({
          collision: true,
          allowCollision: false,
          zooms: [3, 20],
          zIndex: 1000,
        })
        mapRef.current.add(labelsLayerRef.current)
        setLoadState('ready')
      })
      .catch(() => {
        if (!cancelled) setLoadState('error')
      })
    return () => {
      cancelled = true
      amapRef.current = null
      labelsLayerRef.current = null
      mapRef.current?.destroy()
      mapRef.current = null
      markersRef.current.clear()
    }
  }, [mapSettings?.apiKey, mapSettings?.securityJsCode])

  // 公司列表变化 → 重建 LabelMarker（LabelsLayer 避让自动生效）+ fitView 全量
  useEffect(() => {
    const map = mapRef.current
    const layer = labelsLayerRef.current
    if (!map || !layer || loadState !== 'ready') return
    // types 包未收录 LabelsLayer.add/remove，结构化断言（外部 API 边界）
    const layerApi = layer as unknown as { add: (m: AMap.LabelMarker) => void; remove: (m: AMap.LabelMarker) => void }
    for (const m of markersRef.current.values()) layerApi.remove(m)
    markersRef.current.clear()
    const list: AMap.LabelMarker[] = []
    companies.forEach((c, idx) => {
      const marker = new AMap.LabelMarker(labelMarkerOptions(c, selectedCompanyId === c.id, idx))
      marker.on('click', () => setSelectedCompanyId(c.id))
      layerApi.add(marker)
      markersRef.current.set(c.id, marker)
      list.push(marker)
    })
    if (list.length > 0) map.setFitView(list as unknown as AMap.Marker[], false, [60, 60, 60, 60])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, loadState])

  // 选中变化 → 仅更新高亮样式 + rank + 地图平移定位（不重置缩放）
  useEffect(() => {
    const map = mapRef.current
    if (!map || loadState !== 'ready') return
    const sel = companies.find((c) => c.id === selectedCompanyId)
    for (const c of companies) {
      const marker = markersRef.current.get(c.id)
      if (!marker) continue
      const opts = labelMarkerOptions(c, c.id === selectedCompanyId, companies.indexOf(c))
      marker.setRank(opts.rank)
      marker.setIcon(opts.icon)
    }
    if (sel) map.setCenter(poiCache.get(sel.id) ?? companyPos(sel, companies.indexOf(sel)))
  }, [selectedCompanyId, companies, loadState])

  // POI 精确搜索：缓存缺失的公司串行搜索 → setPosition + 缓存 → 全部完成重 fitView
  useEffect(() => {
    const map = mapRef.current
    const amap = amapRef.current
    if (!map || !amap || loadState !== 'ready') return
    const pending = companies.filter((c) => !poiCache.has(c.id))
    if (pending.length === 0) return
    let settled = 0
    pending.forEach((c) => {
      void searchCompanyPoi(amap, c).then((pos) => {
        settled++
        if (pos) {
          poiCache.set(c.id, pos)
          const marker = markersRef.current.get(c.id)
          if (marker) marker.setPosition(pos)
        }
        if (settled === pending.length) {
          const list: AMap.LabelMarker[] = []
          for (const cc of companies) {
            const m = markersRef.current.get(cc.id)
            if (m) list.push(m)
          }
          if (list.length > 0) map.setFitView(list as unknown as AMap.Marker[], false, [60, 60, 60, 60])
        }
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, loadState])

  if (!mapSettings?.apiKey) {
    return (
      <Box
        sx={{
          flex: 1,
          m: 2,
          borderRadius: '10px',
          border: `1px solid ${alpha(COLORS.border, 0.8)}`,
          boxShadow: COLORS.cardShadow,
          bgcolor: COLORS.canvas,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>地图未配置</Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 }}>
            高德地图需要 Key 与安全密钥，
            <br />
            在设置页「地图服务」配置后启用
          </Typography>
          <Button
            size="small"
            variant="contained"
            onClick={() => setPage('settings')}
            sx={{ fontSize: 12, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
          >
            去配置 →
          </Button>
        </Stack>
      </Box>
    )
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, m: 2, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <Box
        ref={containerRef}
        sx={{ flex: 1, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, overflow: 'hidden' }}
      />
      {loadState === 'loading' && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            bgcolor: alpha(COLORS.canvas, 0.8),
            borderRadius: '10px',
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CircularProgress size={14} thickness={5} />
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>正在加载高德地图…</Typography>
          </Stack>
        </Box>
      )}
      {loadState === 'error' && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            bgcolor: alpha(COLORS.canvas, 0.8),
            borderRadius: '10px',
          }}
        >
          <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.high }}>
            地图加载失败（Key 无效或网络异常），请检查设置页配置
          </Typography>
        </Box>
      )}

      {/* 摘要浮卡（选中公司） */}
      {selected && (
        <Box
          sx={{
            position: 'absolute',
            right: 16,
            top: 16,
            width: 250,
            p: 2,
            borderRadius: '10px',
            bgcolor: alpha(COLORS.bgElevated, 0.96),
            border: `1px solid ${COLORS.borderStrong}`,
            zIndex: 3,
          }}
        >
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{selected.name}</Typography>
            <IconButton size="small" onClick={() => setSelectedCompanyId(null)}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
          <Stack spacing={0.5} sx={{ mb: 1.5 }}>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
              {selected.city} · {selected.industry}
            </Typography>
            <Stack direction="row" spacing={1}>
              {selected.matchScore > 0 && (
                <Typography sx={{ fontSize: 12, color: COLORS.accent }}>匹配 {selected.matchScore}%</Typography>
              )}
              {selected.riskLevel && (
                <Typography sx={{ fontSize: 12, color: RISK_COLOR[selected.riskLevel] }}>
                  风险 {RISK_LABEL[selected.riskLevel]}
                </Typography>
              )}
              {selected.validation?.status === 'invalid' && (
                <Typography sx={{ fontSize: 12, color: RISK_COLOR.medium }}>待尽调</Typography>
              )}
            </Stack>
          </Stack>
          <Button size="small" fullWidth variant="contained" onClick={() => setView('profile')} sx={{ fontSize: 12, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}>
            查看档案 →
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** 「公司档案」视图：左侧公司卡片（460px）+ 右侧尽调详情正文 */
function ProfileView({ selected }: { selected: CompanyWithValidation | null }) {
  const companies = useAppStore((s) => s.companies)
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const markCompanyContacted = useAppStore((s) => s.markCompanyContacted)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const jobs = useAppStore((s) => s.jobs)
  const push = useToastStore((s) => s.push)
  const [detail, setDetail] = useState<CompanyDetail | null>(null)
  const [detailError, setDetailError] = useState(false)

  // 选中公司 → 拉取档案全文（尽调详情正文）
  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setDetailError(false)
    if (!selected) return
    const engine = getEngine()
    if (!engine) {
      setDetailError(true)
      return
    }
    engine
      .getCompanyDetail(selected.id)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetailError(true)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.id])

  // 只渲染 `## 尽调详情` 之后的正文（摘要表已在左侧卡片展示，不重复）
  const detailMd = useMemo(() => {
    if (!detail) return ''
    const idx = detail.markdown.indexOf('## 尽调详情')
    return idx >= 0 ? detail.markdown.slice(idx) : detail.markdown
  }, [detail])

  if (!selected) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>选择一家公司查看尽调档案</Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
            左侧列表或「地图探索」视图中点击公司
          </Typography>
        </Stack>
      </Box>
    )
  }

  const companyJobs = jobs.filter((j) => resolveCompanyReference(companies, j.company)?.id === selected.id)

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      {/* 左侧公司卡片（460px，沿用原档案 Dialog 宽度与内容） */}
      <Box
        sx={{
          width: 460,
          minWidth: 460,
          overflowY: 'auto',
          borderRight: `1px solid ${COLORS.border}`,
          p: 2.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Box>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1.5 }}>
            <Typography sx={{ fontSize: 17, fontWeight: 600, flex: 1 }}>{selected.name}</Typography>
            {selected.validation?.status === 'invalid' && (
              <Chip
                size="small"
                label="待尽调"
                sx={{ height: 20, fontSize: 11, bgcolor: alpha(RISK_COLOR.medium, 0.15), color: RISK_COLOR.medium }}
              />
            )}
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
            {(selected.tags ?? []).map((t) => (
              <Chip key={t} size="small" label={t} sx={{ height: 22, fontSize: 12 }} />
            ))}
          </Stack>
          <Box
            sx={{
              p: 1.5,
              borderRadius: '8px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${alpha(COLORS.border, 0.8)}`,
              boxShadow: COLORS.cardShadow,
            }}
          >
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1 }}>尽调摘要</Typography>
            <Stack spacing={1}>
              <Row label="城市" value={selected.city || '—'} />
              <Row label="产业" value={selected.industry || '—'} />
              <Row label="匹配度" value={selected.matchScore > 0 ? `${selected.matchScore}%` : '—'} color={COLORS.accent} />
              <Row label="风险" value={selected.riskLevel ? RISK_LABEL[selected.riskLevel] : '—'} color={selected.riskLevel ? RISK_COLOR[selected.riskLevel] : undefined} />
              <Row label="规模" value={selected.headcount || '—'} />
              <Row label="来源" value={selected.source || '—'} />
            </Stack>
          </Box>
        </Box>

        <GapAnalysisSection companyName={selected.name} />

        <Stack spacing={1}>
          <Button
            variant="contained"
            fullWidth
            onClick={() => {
              startAnalysis(
                `请对「${selected.name}」（${selected.city} · ${selected.industry}）开展公司尽调：背调、风险、竞争力与入职建议`,
              )
              push('info', '已预置「公司尽调」上下文')
            }}
          >
            开始尽调
          </Button>
          <Button
            variant="outlined"
            fullWidth
            onClick={() => {
              markCompanyContacted(selected.id)
              push('success', `已标记「${selected.name}」为已联系 · 投递管理已同步`)
              setPage('applications')
            }}
          >
            标记已联系 → 投递管理
          </Button>
        </Stack>

        {/* 该公司 JD（尽调完看岗位 → JD 工作区） */}
        {companyJobs.length > 0 && (
          <Box>
            <Typography
              sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.04em', mb: 1 }}
            >
              该公司 JD · {companyJobs.length}
            </Typography>
            <Stack spacing={0.5}>
              {companyJobs.map((j) => (
                <Box
                  key={j.id}
                  onClick={() => {
                    setSelectedJobId(j.id)
                    setPage('jobs')
                  }}
                  sx={{
                    p: 1,
                    borderRadius: '8px',
                    border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                    boxShadow: COLORS.cardShadow,
                    cursor: 'pointer',
                    transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
                    '&:hover': { bgcolor: COLORS.bgHover, borderColor: COLORS.borderStrong },
                  }}
                >
                  <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>{j.title}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }}>
                    {j.location && `${j.location} · `}
                    {j.salary ?? ''}
                    {j.responsibilities.length > 0 && ` · ${j.responsibilities.map((r) => r.statement).join('/')}`}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        )}
      </Box>

      {/* 右侧尽调详情正文（档案 md 原文渲染） */}
      <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 3 }}>
        {detailError ? (
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
            尽调详情加载失败（引擎未连接或档案缺失）
          </Typography>
        ) : !detail ? (
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>加载尽调详情…</Typography>
        ) : (
          <Box sx={{ maxWidth: 720 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {detailMd}
            </ReactMarkdown>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 500, color: color ?? COLORS.text, textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  )
}

export function CompaniesPage() {
  const view = useAppStore((s) => s.companiesView)
  const setView = useAppStore((s) => s.setCompaniesView)
  const companies = useAppStore((s) => s.companies)
  const selectedCompanyId = useAppStore((s) => s.selectedCompanyId)
  const selected = companies.find((c) => c.id === selectedCompanyId) ?? null

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 视图切换放主区顶部左侧（靠右用户不易发现）；侧栏只留「公司空间」标题 + 公司列表 */}
      <Stack
        direction="row"
        sx={{ alignItems: 'center', px: 2, py: 1, borderBottom: `1px solid ${COLORS.border}` }}
        spacing={1.5}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          onChange={(_, v: 'profile' | 'map' | null) => v && setView(v)}
          sx={{
            '& .MuiToggleButton-root': {
              px: 1.5,
              py: 0.25,
              fontSize: 12,
              color: COLORS.textMuted,
              borderColor: COLORS.border,
              '&.Mui-selected': {
                color: COLORS.accent,
                bgcolor: COLORS.accentMuted,
              },
            },
          }}
        >
          <ToggleButton value="profile">公司档案</ToggleButton>
          <ToggleButton value="map">地图探索</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" label={`${companies.length} 家档案`} sx={{ height: 22, fontSize: 12 }} />
      </Stack>

      {view === 'map' ? <MapView /> : <ProfileView selected={selected} />}
    </Box>
  )
}
