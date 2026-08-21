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
import { watchClaimProposals } from './storage/claim-proposal-registry.ts'
import { watchOpportunityProposals } from './storage/opportunity-proposal-registry.ts'
import { watchWorkingCopies } from './storage/working-copy-registry.ts'
import { watchKnowledge } from './storage/knowledge-watcher.ts'
import { watchPersons } from './storage/person-watcher.ts'
import { watchTargets } from './storage/target-watcher.ts'
import { watchCandidatePool } from './storage/candidate-pool.ts'
import { watchJobLeads } from './storage/job-leads.ts'
import { watchSalaryBenchmarks } from './storage/salary-benchmarks.ts'
import { migrateSnapshotLayout } from './storage/snapshot-archive.ts'
import { ensureCompanyPlaceholder, scanJobs, watchJobs } from './storage/job-watcher.ts'
import { createProjection } from './storage/projection.ts'
import { DecisionRuntime } from './runtime/decision-runtime.ts'
import { generateHealthReport } from './health/checker.ts'
import { ServerError, startServer, computeResumeRewriteContext } from './transport/websocket.ts'
import { EVENTS, ProtocolVersion } from './transport/protocol.ts'
import { buildBridgeContext, submitOpportunityProposal, buildClaimBridgeContext, submitClaimBridge, type OpportunityProposalInput } from './storage/opportunity-proposal-registry.ts'
import { buildStrengthProposalContext, submitStrengthProposals, watchStrengthProposals, type StrengthProposalInput } from './storage/strength-proposal-registry.ts'
import { buildDeriveContext, submitDerivationProposal, watchDerivationProposals, type DerivationProposalInput } from './storage/derivation-proposal-registry.ts'
import { registerPendingRoleProposals, submitRoleProposal, watchRoleProposals, type RoleProposalInput } from './storage/role-proposal-registry.ts'
import { scanWorkflows, type WorkflowState } from './storage/workflow-registry.ts'
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
    // ─── Role 补登（roles-contract v0.2）：引擎离线期间 Agent 手工写入的 registered 提案 → 投影 roles.md（幂等）
    const roleRegistered = registerPendingRoleProposals(ws)
    if (roleRegistered > 0) logger.info(`Role 提案投影：${roleRegistered} 个 registered 提案并入 knowledge/roles.md`)

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

    // ─── Strength Bridge（--strength-context {personId} / --strength-submit {file}）：
    //      优势亮点提案 Agent 消费通道（与 claim Bridge 同模式——Agent 总结候选，Engine 校验登记；
    //      accept 裁决必须用户经 RPC 触发，Agent 不能自批）
    if (args.includes('--strength-context')) {
      const idx = args.indexOf('--strength-context')
      const personId = args[idx + 1]
      if (!personId) throw new Error('--strength-context 需要 {personId}')
      console.log(JSON.stringify(buildStrengthProposalContext(ws, personId), null, 2))
      return
    }
    if (args.includes('--strength-submit')) {
      const idx = args.indexOf('--strength-submit')
      const file = args[idx + 1]
      if (!file) throw new Error('--strength-submit 需要 {json文件}')
      const input = JSON.parse(readFileSync(file, 'utf8')) as StrengthProposalInput
      console.log(JSON.stringify(submitStrengthProposals(ws, input), null, 2))
      return
    }

    // ─── Derivation Bridge（--derive-context {wcId} {jobId} / --derive-submit {file}）：
    //      简历派生提案 Agent 消费通道（与 strength Bridge 同模式——Agent 生成整份派生候选，
    //      Engine 校验登记；accept 建副本必须用户经 RPC 触发，Agent 不能自建副本）
    if (args.includes('--derive-context')) {
      const idx = args.indexOf('--derive-context')
      const wcId = args[idx + 1]
      const jobId = args[idx + 2]
      if (!wcId || !jobId) throw new Error('--derive-context 需要 {wcId} {jobId}')
      console.log(JSON.stringify(buildDeriveContext(ws, wcId, jobId), null, 2))
      return
    }
    if (args.includes('--derive-submit')) {
      const idx = args.indexOf('--derive-submit')
      const file = args[idx + 1]
      if (!file) throw new Error('--derive-submit 需要 {json文件}')
      const input = JSON.parse(readFileSync(file, 'utf8')) as DerivationProposalInput
      console.log(JSON.stringify(submitDerivationProposal(ws, input), null, 2))
      return
    }

    // ─── Role Bridge（--role-submit {file}）：岗位提案 Agent 消费通道（roles-contract.md v0.2——
    //      Agent 从 JD/尽调提取岗位技能需求提交，Engine 校验登记投影 knowledge/roles.md；
    //      校验失败 throw（错误给 Agent 看拦截原因））
    if (args.includes('--role-submit')) {
      const idx = args.indexOf('--role-submit')
      const file = args[idx + 1]
      if (!file) throw new Error('--role-submit 需要 {json文件}')
      const input = JSON.parse(readFileSync(file, 'utf8')) as RoleProposalInput
      console.log(JSON.stringify(submitRoleProposal(ws, input), null, 2))
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
    // 管线守护：watcher 回调异常不再击穿进程（chokidar 事件处理器抛出 = 未捕获崩溃）；
    // 失败记日志 + 广播 error.engine（UI 全局错误卡消费——管线错误对用户可见）
    const guarded = <A extends unknown[]>(name: string, fn: (...args: A) => void): ((...args: A) => void) =>
      (...args: A): void => {
        try {
          fn(...args)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`${name} 变更处理失败：${message}`)
          broadcast({ event: EVENTS.engineError, data: { message: `${name}：${message}` } })
        }
      }
    if (config.watcher.enabled) {
      watchDecisions(ws, guarded('decisions', (parsed) => {
        // 身份校验 + 投影；校验后数据驱动 INDEX 决策段落（ADR-014：INDEX 是投影，Agent 不得手写）
        const checked = projection.syncFromDecisions(parsed)
        writeIndexDecisionSections(ws, checked)
        broadcast({ event: EVENTS.decisionsChanged })
        broadcast({ event: EVENTS.poolChanged })
        logger.info(`decisions/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // contexts/list 按需组装（context 文件 + 决策投影），变更只发信号；UI 收到 decisionsChanged 会重拉 contexts/list
      watchContexts(ws, guarded('contexts', () => {
        broadcast({ event: EVENTS.decisionsChanged })
        logger.info('decision-contexts/ 变更：已广播（contexts/list 按需重扫组装）')
      }))
      // jobs/ 变更只发信号；UI 收到 jobsChanged 重拉 jobs/list（jobs 是独立实体，不参与决策投影）
      watchJobs(ws, guarded('jobs', (parsed) => {
        broadcast({ event: EVENTS.jobsChanged })
        logger.info(`jobs/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // companies/ 变更只发信号（skill 尽调直写档案；UI 收到 companiesChanged 重拉 companies/list + 图谱）
      watchCompanies(ws, guarded('companies', () => {
        broadcast({ event: EVENTS.companiesChanged })
        logger.info('companies/ 变更：已广播（companies/list 按需重扫）')
      }))
      // persons/ 变更只发信号（P1 Person Aggregate：identity/career_profile/skill_inventory 等
      // 变化 → personsChanged → UI 重拉 persons/list——对齐其他业务目录，补 944b147 刷新页面临时覆盖）
      watchPersons(ws, guarded('persons', () => {
        broadcast({ event: EVENTS.personsChanged })
        logger.info('persons/ 变更：已广播（persons/list 按需重扫）')
      }))
      // targets/ 变更只发信号（M6：目标机会资产——UI 收到 targetsChanged 重拉 targets/list）
      watchTargets(ws, guarded('targets', () => {
        broadcast({ event: EVENTS.targetsChanged })
        logger.info('targets/ 变更：已广播（targets/list 按需重扫）')
      }))
      // company-pool/ 变更只发信号（公司适配榜候选层——UI 收到 candidatesChanged 重拉 candidates/list）
      watchCandidatePool(ws, guarded('company-pool', () => {
        broadcast({ event: EVENTS.candidatesChanged })
        logger.info('company-pool/ 变更：已广播（candidates/list 按需重扫）')
      }))
      // job-leads/ 变更只发信号（公司适配榜投递层——UI 收到 jobLeadsChanged 重拉 job-leads/list）
      watchJobLeads(ws, guarded('job-leads', () => {
        broadcast({ event: EVENTS.jobLeadsChanged })
        logger.info('job-leads/ 变更：已广播（job-leads/list 按需重扫）')
      }))
      // knowledge/薪资基准-* 变更只发信号（二期 §7.7——UI 收到 salaryBenchmarksChanged 重拉 salary-benchmarks/list）
      watchSalaryBenchmarks(ws, guarded('salary-benchmarks', () => {
        broadcast({ event: EVENTS.salaryBenchmarksChanged })
        logger.info('salary-benchmarks 变更：已广播（salary-benchmarks/list 按需重扫）')
      }))
      // evidence/ 变更只发信号（M2：证据是独立资产，UI 收到 evidenceChanged 重拉 evidence/list）
      watchEvidence(ws, guarded('evidence', (parsed) => {
        broadcast({ event: EVENTS.evidenceChanged })
        logger.info(`evidence/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // claims/ 变更只发信号（M3-0：表达 IR 是独立资产，UI 收到 claimsChanged 重拉 claims/list）
      watchClaims(ws, guarded('claims', (parsed) => {
        broadcast({ event: EVENTS.claimsChanged })
        logger.info(`claims/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // claim-proposals/ 变更只发信号（CLI 桥 --claim-bridge-submit 外部写盘 → UI 提案卡刷新）
      watchClaimProposals(ws, guarded('claim-proposals', () => {
        broadcast({ event: EVENTS.claimProposalsChanged })
        logger.info('claim-proposals/ 变更：已广播（claim-proposals/list 按需重扫）')
      }))
      // opportunity-proposals/ 变更只发信号（CLI 桥 --opportunity-submit 外部写盘 → UI 提案卡刷新）
      watchOpportunityProposals(ws, guarded('opportunity-proposals', () => {
        broadcast({ event: EVENTS.opportunityProposalsChanged })
        logger.info('opportunity-proposals/ 变更：已广播（opportunity-proposals/list 按需重扫）')
      }))
      // working-copies/ 变更只发信号（外部写盘 → UI 简历工作区刷新；RPC upsert 亦触发）
      watchWorkingCopies(ws, guarded('working-copies', () => {
        broadcast({ event: EVENTS.workingCopiesChanged })
        logger.info('working-copies/ 变更：已广播（working-copies/list 按需重扫）')
      }))
      // knowledge/ 词表变更 → poolChanged（图谱 role/skill 节点派生自 knowledge；UI 重拉图谱）
      watchKnowledge(ws, guarded('knowledge', () => {
        broadcast({ event: EVENTS.poolChanged })
        logger.info('knowledge/ 变更：已广播 poolChanged（图谱按需重扫）')
      }))
      // role-proposals/ 变更 → 补登投影 + poolChanged（岗位提案登记后 roles.md 变化；UI 差距分析/图谱重拉）
      watchRoleProposals(ws, guarded('role-proposals', (parsed) => {
        broadcast({ event: EVENTS.poolChanged })
        logger.info(`role-proposals/ 变更：投影 ${parsed.length} 个提案并广播 poolChanged`)
      }))
      // workflows/ 变更 → 广播 workflowChanged（Career Workflow Contract v0.1：UI 拉状态投影）
      watchWorkflows(ws, guarded('workflows', (parsed) => {
        broadcast({ event: EVENTS.workflowChanged })
        logger.info(`workflows/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // resumes/ 变更只发信号（M3.5：版本系统——drafts/ 组装登记 + documents/ 变更都触发）
      watchResumes(ws, guarded('resumes', (parsed) => {
        broadcast({ event: EVENTS.resumesChanged })
        logger.info(`resumes/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // proposals/ 变更只发信号（M3.5.6：AI 建议层——AI 写文件登记 + RPC 状态流转都触发）
      watchProposals(ws, guarded('proposals', (parsed) => {
        broadcast({ event: EVENTS.proposalsChanged })
        logger.info(`proposals/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // portfolio/ 变更只发信号（M4-1：项目事实 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchPortfolio(ws, guarded('portfolio', () => {
        broadcast({ event: EVENTS.portfolioChanged })
        logger.info('portfolio/ 变更：已广播（portfolio/projects|proposals/list 按需重扫）')
      }))
      // strength-proposals/ 变更只发信号（优势亮点提案——Agent CLI 桥提交 + RPC 裁决都触发）
      watchStrengthProposals(ws, guarded('strength-proposals', (parsed) => {
        broadcast({ event: EVENTS.strengthProposalsChanged })
        logger.info(`strength-proposals/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // derivation-proposals/ 变更只发信号（简历派生提案——Agent CLI 桥提交 + RPC 裁决都触发）
      watchDerivationProposals(ws, guarded('derivation-proposals', (parsed) => {
        broadcast({ event: EVENTS.derivationProposalsChanged })
        logger.info(`derivation-proposals/ 变更：重扫 ${parsed.length} 条并广播`)
      }))
      // interviews/ 变更只发信号（M4-2：问答资产 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchInterviews(ws, guarded('interviews', () => {
        broadcast({ event: EVENTS.interviewChanged })
        logger.info('interviews/ 变更：已广播（interviews/list 按需重扫）')
      }))
      // cover-letters/ 变更只发信号（M4-3：求职信 + 提案——文件登记 + RPC 状态流转/transition 都触发）
      watchCoverLetters(ws, guarded('cover-letters', () => {
        broadcast({ event: EVENTS.coverLetterChanged })
        logger.info('cover-letters/ 变更：已广播（cover-letters/list 按需重扫）')
      }))
      logger.info('decisions/ 监听已启用（watcher.enabled=true）')
      logger.info('decision-contexts/ 监听已启用（watcher.enabled=true）')
      logger.info('jobs/ 监听已启用（watcher.enabled=true）')
      logger.info('companies/ 监听已启用（watcher.enabled=true）')
      logger.info('persons/ 监听已启用（watcher.enabled=true）')
      logger.info('targets/ 监听已启用（watcher.enabled=true）')
      logger.info('evidence/ 监听已启用（watcher.enabled=true）')
      logger.info('claims/ 监听已启用（watcher.enabled=true）')
      logger.info('claim-proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('opportunity-proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('working-copies/ 监听已启用（watcher.enabled=true）')
      logger.info('knowledge/ 监听已启用（watcher.enabled=true）')
      logger.info('resumes/ 监听已启用（watcher.enabled=true）')
      logger.info('proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('strength-proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('derivation-proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('role-proposals/ 监听已启用（watcher.enabled=true）')
      logger.info('workflows/ 监听已启用（watcher.enabled=true）')
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
