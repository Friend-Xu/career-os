/**
 * 引擎启动编排（第 3 步）：config → workspace → logger → projection → WS 桥 → decisions/ 监听。
 * 错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。
 * `--scan-decisions`：一次性扫描 decisions/ → 控制台输出 IR + Validation（第 2 步验收入口）。
 */
import { ConfigError, describeConfig, loadConfig } from './config.ts'
import { initWorkspace, WorkspaceError } from './storage/workspace.ts'
import { createLogger } from './logger.ts'
import { scanDecisions, watchDecisions } from './storage/report-watcher.ts'
import { registerDecisionIdentity } from './storage/decision-registry.ts'
import { writeIndexDecisionSections } from './storage/index-writer.ts'
import { registerArtifacts } from './storage/artifact-registry.ts'
import { EVIDENCE_SPEC, watchEvidence } from './storage/evidence-watcher.ts'
import { CLAIM_SPEC, watchClaims } from './storage/claim-watcher.ts'
import { RESUME_SPEC, watchResumes } from './storage/resume-watcher.ts'
import { registerPendingProposals, watchProposals } from './storage/proposal-watcher.ts'
import { registerPendingPortfolioProjects, registerPendingPortfolioProposals, watchPortfolio } from './storage/portfolio-watcher.ts'
import { registerPendingInterviewQas, registerPendingInterviewProposals, watchInterviews } from './storage/interview-watcher.ts'
import { registerPendingCoverLetters, registerPendingCoverLetterProposals, watchCoverLetters } from './storage/cover-letter-watcher.ts'
import { watchContexts } from './storage/context-watcher.ts'
import { watchCompanies } from './storage/company-watcher.ts'
import { watchPersons } from './storage/person-watcher.ts'
import { migrateSnapshotLayout } from './storage/snapshot-archive.ts'
import { ensureCompanyPlaceholder, scanJobs, watchJobs } from './storage/job-watcher.ts'
import { createProjection } from './storage/projection.ts'
import { DecisionRuntime } from './runtime/decision-runtime.ts'
import { generateHealthReport } from './health/checker.ts'
import { ServerError, startServer, computeResumeRewriteContext } from './transport/websocket.ts'
import { EVENTS, ProtocolVersion } from './transport/protocol.ts'
import { buildBridgeContext, submitOpportunityProposal, buildClaimBridgeContext, submitClaimBridge, type OpportunityProposalInput } from './storage/opportunity-proposal-registry.ts'
import { computeObservationStats } from './runtime/observation.ts'
import { readFileSync } from 'node:fs'

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

    // ─── Snapshot 版本存档迁移（M7.1）：旧平铺 snapshot/*.md → current/ + bootstrap 版本（幂等）───
    const bootstrapped = migrateSnapshotLayout(ws)
    if (bootstrapped) {
      logger.info(`快照存档迁移：${bootstrapped}（layout → snapshot/current/ + versions/ append-only）`)
    }

    // ─── 决策身份登记（M1.6）：引擎离线期间写入的决策文件 → 补登记系统 ID（幂等；监听期 add 事件即时登记）───
    const registered = registerDecisionIdentity(ws).registered
    if (registered > 0) logger.info(`决策登记：${registered} 个决策文件分配系统 ID（decision_YYYYMMDD_NNNNN）`)
    // ─── 证据资产登记（M2）：同上，evidence/ 独立前缀与计数
    const evidenceRegistered = registerArtifacts(ws, EVIDENCE_SPEC).registered
    if (evidenceRegistered > 0) logger.info(`证据登记：${evidenceRegistered} 个证据文件分配系统 ID（evidence_YYYYMMDD_NNNNN）`)
    // ─── Claim 登记（M3-0）：同上，claims/ 独立前缀与计数（表达 IR 层）
    const claimsRegistered = registerArtifacts(ws, CLAIM_SPEC).registered
    if (claimsRegistered > 0) logger.info(`Claim 登记：${claimsRegistered} 个声明文件分配系统 ID（claim_YYYYMMDD_NNNNN）`)
    // ─── 简历版本登记（M3.5）：同上，resumes/documents/ 独立前缀与计数（版本系统 IR）
    const resumesRegistered = registerArtifacts(ws, RESUME_SPEC).registered
    if (resumesRegistered > 0) logger.info(`简历登记：${resumesRegistered} 个版本文件分配系统 ID（resume_YYYYMMDD_NNNNN）`)
    // ─── 提案补登（M3.5.6）：引擎离线期间 AI 写入的提案（invalid 不登记，AI 修正后 watcher 重试）
    const proposalsRegistered = registerPendingProposals(ws)
    if (proposalsRegistered > 0) logger.info(`提案登记：${proposalsRegistered} 个提案文件分配系统 ID（proposal_YYYYMMDD_NNNNN）`)
    // ─── Portfolio 补登（M4-1）：用户写入的项目事实 + AI 提案（幂等；无事实项目/非法提案不登记）
    const projectsRegistered = registerPendingPortfolioProjects(ws)
    if (projectsRegistered > 0) logger.info(`Portfolio 项目登记：${projectsRegistered} 个项目文件分配系统 ID（project_YYYYMMDD_NNNNN）`)
    const ppRegistered = registerPendingPortfolioProposals(ws)
    if (ppRegistered > 0) logger.info(`Portfolio 提案登记：${ppRegistered} 个提案文件分配系统 ID（pp_YYYYMMDD_NNNNN）`)
    // ─── Interview 补登（M4-2）：用户写入的 QA + AI 提案（幂等；无问题 QA/非法提案不登记）
    const qasRegistered = registerPendingInterviewQas(ws)
    if (qasRegistered > 0) logger.info(`Interview QA 登记：${qasRegistered} 个问答文件分配系统 ID（qa_YYYYMMDD_NNNNN）`)
    const ipRegistered = registerPendingInterviewProposals(ws)
    if (ipRegistered > 0) logger.info(`Interview 提案登记：${ipRegistered} 个提案文件分配系统 ID（ip_YYYYMMDD_NNNNN）`)
    // ─── Cover Letter 补登（M4-3）：用户写入的求职信 + AI 提案（幂等；无叙述单元/非法提案不登记）
    const clRegistered = registerPendingCoverLetters(ws)
    if (clRegistered > 0) logger.info(`Cover Letter 登记：${clRegistered} 个求职信文件分配系统 ID（cl_YYYYMMDD_NNNNN）`)
    const clpRegistered = registerPendingCoverLetterProposals(ws)
    if (clpRegistered > 0) logger.info(`Cover Letter 提案登记：${clpRegistered} 个提案文件分配系统 ID（clp_YYYYMMDD_NNNNN）`)

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

    // ─── Resume Context（--resume-context {decisionId} {personId}）：决策记录 → 结构化简历改写上下文
    //      （resume-writing skill 消费通道；与 decision/resume-context RPC 同一计算源）
    if (args.includes('--resume-context')) {
      const idx = args.indexOf('--resume-context')
      const decisionId = args[idx + 1]
      const personId = args[idx + 2]
      if (!decisionId || !personId) throw new Error('--resume-context 需要 {decisionId} {personId}')
      console.log(JSON.stringify(computeResumeRewriteContext(ws, decisionId, personId), null, 2))
      return
    }

    // ─── Opportunity Bridge（--opportunity-context {opportunityId} {wcId} / --opportunity-submit {file}）：
    //      P3.3 Agent 消费通道（与 --resume-context 同模式——Agent 用 Bash 调 CLI，Engine 组装/校验；
    //      WS RPC 同一计算源；invalid 提交 throw → 错误信息给 Agent 看拦截原因）
    if (args.includes('--opportunity-context')) {
      const idx = args.indexOf('--opportunity-context')
      const opportunityId = args[idx + 1]
      const wcId = args[idx + 2]
      if (!opportunityId || !wcId) throw new Error('--opportunity-context 需要 {opportunityId} {wcId}')
      console.log(JSON.stringify(buildBridgeContext(ws, wcId, opportunityId), null, 2))
      return
    }
    if (args.includes('--opportunity-submit')) {
      const idx = args.indexOf('--opportunity-submit')
      const file = args[idx + 1]
      if (!file) throw new Error('--opportunity-submit 需要 {json文件}')
      const input = JSON.parse(readFileSync(file, 'utf8')) as OpportunityProposalInput
      console.log(JSON.stringify(submitOpportunityProposal(ws, input), null, 2))
      return
    }

    // ─── Claim Bridge（--claim-bridge-context {opportunityId} {wcId} {evidenceIds} / --claim-bridge-submit {file}）：
    //      P5.3 Agent 消费通道（与 opportunity Bridge 同模式——Agent 构造 statement，Engine 装配校验 + P1.1 登记）
    if (args.includes('--claim-bridge-context')) {
      const idx = args.indexOf('--claim-bridge-context')
      const opportunityId = args[idx + 1]
      const wcId = args[idx + 2]
      const evidenceIds = (args[idx + 3] ?? '').split(',').filter(Boolean)
      if (!opportunityId || !wcId) throw new Error('--claim-bridge-context 需要 {opportunityId} {wcId} {evidenceIds(逗号分隔)}')
      console.log(JSON.stringify(buildClaimBridgeContext(ws, wcId, opportunityId, evidenceIds), null, 2))
      return
    }
    if (args.includes('--claim-bridge-submit')) {
      const idx = args.indexOf('--claim-bridge-submit')
      const file = args[idx + 1]
      if (!file) throw new Error('--claim-bridge-submit 需要 {json文件}')
      const input = JSON.parse(readFileSync(file, 'utf8')) as Parameters<typeof submitClaimBridge>[1]
      console.log(JSON.stringify(submitClaimBridge(ws, input), null, 2))
      return
    }

    // ─── 投影层（SQLite，markdown 真相源的查询投影）──────────────────────
    const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger })
    const initial = scanDecisions(ws)
    const checkedInitial = projection.syncFromDecisions(initial)
    // INDEX 决策段落对齐（引擎接管投影；存量 Agent 手写段落被规范重写）
    writeIndexDecisionSections(ws, checkedInitial)
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

    // ─── 观察统计（--observation-stats）：P6 观察阶段只读投影——决策事件/迁移路径/资产化闭环分布 + 阈值达成
    if (args.includes('--observation-stats')) {
      const stats = computeObservationStats(ws)
      console.log('Observation Stats')
      console.log('━━━━━━━━━━━━━━━━')
      console.log(`决策事件：${stats.historyCount} 条（阈值 30）`)
      console.log(`机会分布：${Object.entries(stats.opportunityDistribution.state).map(([k, v]) => `${k}×${v}`).join('、') || '无'}`)
      console.log(`意图分布：${Object.entries(stats.opportunityDistribution.intent).map(([k, v]) => `${k}×${v}`).join('、') || '无'}`)
      console.log(`提案行为：采纳 ${stats.proposalBehavior.approved}（${stats.proposalBehavior.acceptRate}%）· 拒绝 ${stats.proposalBehavior.rejected}（${stats.proposalBehavior.rejectRate}%）· 冲突 ${stats.proposalBehavior.conflict}（${stats.proposalBehavior.conflictRate}%）`)
      const cats = Object.entries(stats.resolutionPaths.category).map(([k, v]) => `${k}×${v}`).join('、') || '无'
      console.log(`结果分布：${cats}`)
      const trans = Object.entries(stats.resolutionPaths.transitions).map(([k, v]) => `${k}×${v}`).join('、') || '无'
      console.log(`迁移路径：${trans}`)
      console.log(`资产化：提案 ${stats.assetLoop.proposals} · 采用 ${stats.assetLoop.accepted}（阈值 10）`)
      for (const m of stats.thresholds.met) console.log(`✓ ${m}`)
      for (const u of stats.thresholds.unmet) console.log(`○ ${u}`)
      console.log(stats.thresholds.met.length === 4 ? '模型升级评审准入——可启动 P7 契约冻结' : '样本不足——继续观察（闭环运行产生数据）')
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

    // ─── 三模块联动补账：存量 JD 缺公司占位 → 启动补一次（新建档由 createJobFile 联带）──
    let placeholders = 0
    for (const j of scanJobs(ws)) {
      if (ensureCompanyPlaceholder(ws, j.record.company, j.record.location)) placeholders++
    }
    if (placeholders > 0) {
      logger.info(`占位公司补账：为 ${placeholders} 个存量 JD 创建待尽调占位档案`)
      broadcast({ event: EVENTS.companiesChanged })
    }

    // ─── decisions/ 文件监听（全量重扫 → 重新投影 → 广播变更信号）──────────
    // 先于就绪日志接线：ready = 桥 + 监听全部可用（避免就绪后首个事件窗口丢失）
    if (config.watcher.enabled) {
      watchDecisions(ws, (parsed) => {
        // 身份校验 + 投影；校验后数据驱动 INDEX 决策段落（ADR-014：INDEX 是投影，Agent 不得手写）
        const checked = projection.syncFromDecisions(parsed)
        writeIndexDecisionSections(ws, checked)
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
      // companies/ 变更只发信号（skill 尽调直写档案；UI 收到 companiesChanged 重拉 companies/list + 图谱）
      watchCompanies(ws, () => {
        broadcast({ event: EVENTS.companiesChanged })
        logger.info('companies/ 变更：已广播（companies/list 按需重扫）')
      })
      // persons/ 变更只发信号（P1 Person Aggregate：identity/career_profile/skill_inventory 等
      // 变化 → personsChanged → UI 重拉 persons/list——对齐其他业务目录，补 944b147 刷新页面临时覆盖）
      watchPersons(ws, () => {
        broadcast({ event: EVENTS.personsChanged })
        logger.info('persons/ 变更：已广播（persons/list 按需重扫）')
      })
      // evidence/ 变更只发信号（M2：证据是独立资产，UI 收到 evidenceChanged 重拉 evidence/list）
      watchEvidence(ws, (parsed) => {
        broadcast({ event: EVENTS.evidenceChanged })
        logger.info(`evidence/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      // claims/ 变更只发信号（M3-0：表达 IR 是独立资产，UI 收到 claimsChanged 重拉 claims/list）
      watchClaims(ws, (parsed) => {
        broadcast({ event: EVENTS.claimsChanged })
        logger.info(`claims/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      // resumes/ 变更只发信号（M3.5：版本系统——drafts/ 组装登记 + documents/ 变更都触发）
      watchResumes(ws, (parsed) => {
        broadcast({ event: EVENTS.resumesChanged })
        logger.info(`resumes/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      // proposals/ 变更只发信号（M3.5.6：AI 建议层——AI 写文件登记 + RPC 状态流转都触发）
      watchProposals(ws, (parsed) => {
        broadcast({ event: EVENTS.proposalsChanged })
        logger.info(`proposals/ 变更：重扫 ${parsed.length} 条并广播`)
      })
      // portfolio/ 变更只发信号（M4-1：项目事实 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchPortfolio(ws, () => {
        broadcast({ event: EVENTS.portfolioChanged })
        logger.info('portfolio/ 变更：已广播（portfolio/projects|proposals/list 按需重扫）')
      })
      // interviews/ 变更只发信号（M4-2：问答资产 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchInterviews(ws, () => {
        broadcast({ event: EVENTS.interviewChanged })
        logger.info('interviews/ 变更：已广播（interviews/list 按需重扫）')
      })
      // cover-letters/ 变更只发信号（M4-3：求职信 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchCoverLetters(ws, () => {
        broadcast({ event: EVENTS.coverLetterChanged })
        logger.info('cover-letters/ 变更：已广播（cover-letters/list 按需重扫）')
      })
      logger.info('decisions/ 监听已启用（watcher.enabled=true）')
      logger.info('decision-contexts/ 监听已启用（watcher.enabled=true）')
      logger.info('jobs/ 监听已启用（watcher.enabled=true）')
      logger.info('companies/ 监听已启用（watcher.enabled=true）')
      logger.info('persons/ 监听已启用（watcher.enabled=true）')
      logger.info('evidence/ 监听已启用（watcher.enabled=true）')
      logger.info('claims/ 监听已启用（watcher.enabled=true）')
      logger.info('resumes/ 监听已启用（watcher.enabled=true）')
      logger.info('proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('portfolio/ 监听已启用（watcher.enabled=true）')
      logger.info('interviews/ 监听已启用（watcher.enabled=true）')
      logger.info('cover-letters/ 监听已启用（watcher.enabled=true）')
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
