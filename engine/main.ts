/**
 * 引擎启动编排（第 3 步）：config → workspace → logger → projection → WS 桥 → decisions/ 监听。
 * 错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。
 * `--scan-decisions`：一次性扫描 decisions/ → 控制台输出 IR + Validation（第 2 步验收入口）。
 */
import { ConfigError, describeConfig, loadConfig } from './config.ts'
import { initWorkspace, WorkspaceError } from './storage/workspace.ts'
import { createLogger } from './logger.ts'
import { scanDecisions, watchDecisions } from './storage/report-watcher.ts'
import { watchContexts } from './storage/context-watcher.ts'
import { watchJobs } from './storage/job-watcher.ts'
import { createProjection } from './storage/projection.ts'
import { DecisionRuntime } from './runtime/decision-runtime.ts'
import { generateHealthReport } from './health/checker.ts'
import { ServerError, startServer } from './transport/websocket.ts'
import { EVENTS, ProtocolVersion } from './transport/protocol.ts'

async function main(args: string[]): Promise<void> {
  try {
    const { config, firstRun, configPath } = loadConfig(args)
    const logger = createLogger({ logsDir: config.paths.logs, level: 'info' })

    if (firstRun) {
      logger.info(`已生成配置文件 ${configPath}（内置默认值，可直接编辑），字段说明：`)
      for (const line of describeConfig(config)) logger.info(`  ${line}`)
    } else {
      logger.info(`已加载配置 ${configPath}`)
    }

    const ws = initWorkspace(config.paths.workspace)
    logger.info(`信息池工作区就绪：${ws.paths.root}`)
    logger.info(`协议版本：career-os v${ProtocolVersion}（metadata/protocol.json，引擎单方维护）`)

    if (args.includes('--scan-decisions')) {
      const parsed = scanDecisions(ws)
      if (parsed.length === 0) {
        logger.info('decisions/ 无决策记录')
      } else {
        for (const p of parsed) {
          const status = p.validation?.status ?? 'ok'
          logger.info(`[${status}] ${p.sourceFile}`)
          logger.info(`  direction=${p.record.direction ?? '-'} match=${p.record.directionMatch ?? '-'} city=${p.record.city ?? '-'} risk=${p.record.riskLevel ?? '-'}`)
          if (p.validation) {
            for (const issue of p.validation.issues) logger.warn(`  ${issue.severity}: ${issue.path} — ${issue.reason}`)
          }
        }
        logger.info(`共 ${parsed.length} 条，invalid ${parsed.filter((p) => p.validation?.status === 'invalid').length} 条`)
      }
      return
    }

    // ─── 投影层（SQLite，markdown 真相源的查询投影）──────────────────────
    const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger })
    const initial = scanDecisions(ws)
    projection.syncFromDecisions(initial)
    logger.info(`投影就绪：decisions ${initial.length} 条（db ${config.paths.db}）`)

    // ─── 健康检查（--doctor）：契约 v1 四维度投影，CLI 一次性输出（与 system/health RPC 同一计算源）
    if (args.includes('--doctor')) {
      const report = generateHealthReport(ws, projection)
      const rule = (s: number): string => (s >= 90 ? '✓' : s >= 70 ? '⚠' : '✗')
      console.log('Career Doctor')
      console.log('━━━━━━━━━━━━━━━━')
      for (const d of report.dimensions) {
        console.log(`${rule(d.score)} ${d.name}: ${d.score}%`)
        for (const issue of d.issues) {
          console.log(`   ${issue.severity === 'error' ? '✗' : '⚠'} ${issue.message}${issue.count > 1 ? `（${issue.count}）` : ''}`)
        }
      }
      console.log(`总体健康度：${report.overallScore}%（version ${report.version}）`)
      return
    }

    // ─── WebSocket 桥（RPC + 事件广播；决策链状态机 + Agent 运行时注入，derived 视图按需计算）──
    const runtime = new DecisionRuntime()
    const handle = await startServer({
      config,
      workspace: ws,
      logger,
      store: projection,
      runtime,
    })
    const { port, broadcast } = handle

    // ─── decisions/ 文件监听（全量重扫 → 重新投影 → 广播变更信号）──────────
    // 先于就绪日志接线：ready = 桥 + 监听全部可用（避免就绪后首个事件窗口丢失）
    if (config.watcher.enabled) {
      watchDecisions(ws, (parsed) => {
        projection.syncFromDecisions(parsed)
        broadcast({ event: EVENTS.decisionsChanged })
        broadcast({ event: EVENTS.poolChanged })
        logger.info(`decisions/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      // contexts/list 按需组装（context 文件 + 决策投影），变更只发信号；UI 收到 decisionsChanged 会重拉 contexts/list
      watchContexts(ws, () => {
        broadcast({ event: EVENTS.decisionsChanged })
        logger.info('decision-contexts/ 变更：已广播（contexts/list 按需重扫组装）')
      })
      // jobs/ 变更只发信号；UI 收到 jobsChanged 重拉 jobs/list（jobs 是独立实体，不参与决策投影）
      watchJobs(ws, (parsed) => {
        broadcast({ event: EVENTS.jobsChanged })
        logger.info(`jobs/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      logger.info('decisions/ 监听已启用（watcher.enabled=true）')
      logger.info('decision-contexts/ 监听已启用（watcher.enabled=true）')
      logger.info('jobs/ 监听已启用（watcher.enabled=true）')
    } else {
      logger.info('decisions/ 监听已禁用（watcher.enabled=false）')
    }

    logger.info(`桥接服务就绪 ws://${config.server.host}:${port}`)

    // 优雅关闭：Ctrl+C / kill → 中止活跃 Agent 任务（SDK close 终止 CLI 子进程），
    // 短暂等待清理后退出（强杀场景由一键启动 taskkill /T 树杀兜底）
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('收到关闭信号，清理 Agent 任务…')
      handle.shutdown()
      setTimeout(() => process.exit(0), 800)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    if (err instanceof ConfigError || err instanceof WorkspaceError || err instanceof ServerError) {
      console.error(err.message)
    } else {
      console.error(`❌ 未知错误：${err instanceof Error ? err.message : String(err)}`)
    }
    process.exitCode = 1
  }
}

void main(process.argv.slice(2))
