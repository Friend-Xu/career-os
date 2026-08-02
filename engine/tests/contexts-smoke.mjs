/**
 * contexts-smoke：真实工作区验证 contexts/list 路径（V1.5 验收）。
 * 与 RPC 处理器同路径：scanContexts(ws) + projection.listDecisions() → buildAggregates（listContexts）。
 * 数据库用临时文件，不碰真实 .career-os.db；只读 context/decisions 真相源。
 *
 * 运行：node tests/contexts-smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { scanDecisions } from '../storage/report-watcher.ts'
import { listContexts } from '../transport/websocket.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

const ws = initWorkspace(defaultConfig().paths.workspace)
const projection = createProjection({ dbPath: join(mkdtempSync(join(tmpdir(), 'cos-ctx-smoke-')), '.db'), workspace: ws, logger: silentLogger })
projection.syncFromDecisions(scanDecisions(ws))

const aggregates = listContexts(ws, projection)
console.log(JSON.stringify(aggregates, null, 2))
console.log(`\n共 ${aggregates.length} 个 context 聚合（records 引用决策 ${aggregates.reduce((n, a) => n + a.records.length, 0)} 条）`)

projection.close()
