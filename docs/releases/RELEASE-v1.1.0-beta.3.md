# Career OS v1.1.0-beta.3 发布说明

- **发布日期**：2026-08-28（2026-08-31 重新发布：Tag 重打至最新提交，追加 5 个提交）
- **Tag**：`v1.1.0-beta.3`
- **范围**：自 `v1.1.0-beta.2` 起 130 个提交

## 本版要点

### 1. 二期：公司适配榜 + 薪资基准
- 公司页投递榜单模式：分城市段 / 三层结构 / 动作集 / 诚实标注（契约 v0.1 §3/§4）
- 薪资基准引擎层：SalaryBenchmarkEntry + 分位聚合 / 档位映射 / 三态估价 + storage/RPC/watcher + AgentTaskType 12 型
- 画像页个人估价卡：四态显式 + 三态徽标 + 榜行市场对照 + 事件刷新
- salary-benchmark skill：双通道检索纪律 + 样本点模式登记契约 + 路由 9 步
- 岗位入库登记闭环：role-proposals 提案通道 + Engine 校验投影 roles.md（roles-contract v0.2）

### 2. 工作流控制平面 v0.1 → v0.3 + Person Health
- 工作流 registry + 双路径 start + advance 四步校验 + Stage Artifact Lifecycle（方向池闭环）
- 方向探索 Gate 终判 / 重新探索出口（UI-1~4）/ Stage 3-4 评估闭环 + 推荐落盘 + decision 联动
- 六轮测试区验证：死锁根治（对账循环 + Path B guard）、完成信号断链修复、候选同步竞态修复
- Person Health Runtime（ADR-031）事实-投影链路健康检查 + 健康告警全局呈现
- City Promotion MVP（ADR-032）：Decision → User Choice → Domain Fact 链路
- 画像断层修复：目标岗位投影接通（career_profile 写端）

### 3. 初始化与简历渠道（P0-1）+ 会话修复
- 简历/访谈通道候选生成确定性通道——Agent 退出候选生产
- 初始化状态机 + 工作流发起门禁 + completePersonInit 完整性门禁（防空壳完成）
- 输出预算真机校准（探索/评估/推荐 16K）+ recommendation Artifact 契约精确化
- 会话归属漂移修复（Session.personId 改存引擎稳定标识 + persist v3 存量迁移）
- 流式消息 rAF 批处理（消除 Maximum update depth exceeded）
- Agent Runtime Decoupling + LLM Provider Migration（ADR-030，移除 claude-agent-sdk 依赖）

### 4. 搜索与工具基础设施（Phase 4A-C）
- Search Capability Layer：任务级预算 + 引擎级缓存 + 官方 responses 适配器主路径与守卫降级
- Provider Capability Registry：webSearch 能力注册表（responses/google/off 判定矩阵）
- WebSearch 工具接入（DeepSeek Responses 托管搜索薄封装）
- NBS 权威统计数据源 + Indicator Resolver + 区域经济画像矩阵
- Tool Source 分层 + Stage 装配 + 工具级审计 trace + Exa MCP 工具源
- Tool Evidence Contract：tool_done.evidence[]（生产方写、Agent 只读）
- 统一外部调用封装（timeout/重试/错误归一/耗时 trace）+ ToolStats 统一指标投影 + 工具指标弹层
- 治理旋钮配置化：budget/cache/超时/重试进 config.json（Phase 4C）

### 5. Execution 体系 + 会话上下文 + Agent 证据契约（ADR-034/035/036）
- Execution registry/RPC v1 + JSONL event-log 持久化（跨进程生命周期 + 启动调和）
- Interactive Execution Recovery：question/permission 统一 waiting 交互模型 + executionId 恢复通道（刷新后提问/回答恢复）
- resultRefs 确定性 StageArtifact 身份引用 + UI Contract（interaction boundary 切分消息段）
- Session Context Frame：会话上下文存储 → Context Compiler 编译注入 → 会话焦点投影（僵尸 resume 语义清理）
- Evidence Sufficiency Validator v0.1：契约 §I 11 项机械校验 + 完成语义接入 + limitation 语义收紧
- JD 分析闭环：submit_jd_analysis 提案通道 + system 协议通道 + 结构化提取器 v2
- 公司尽调落盘 Proposal 通道 + 投递资格判定修正（能力段为尊）

### 6. 推理等级与 Agent 体验
- **推理等级选项**（关闭/低/高·标准/最大）：对齐 DeepSeek 原生 reasoning_effort 四档，缺省「高·标准」（原 Anthropic 网关 thinking budget 不实现语义——仅接受参数，实测证明）
- 自由对话输出预算提档 16K + 空输出显式 empty_output 错误（长任务不再静默空白）
- PDF 视觉提取支持 DeepSeek 多模态 Exp（deepseek-v4-flash-vision-exp）+ 视觉模型默认切换联动
- 岗位入库自动链：JD 分析落盘自动派生角色提案投影 roles.md + 启动对账补登
- Session Frame 截断提档 2000（长会话上下文保留）
- 模型/推理等级选择器美化（去下拉小三角、弹出样式对齐、Tooltip 移除——说明内嵌菜单选项）
- 输入框微信式展开角标（右上角展开/收起大编辑区）+ 右侧操作区垂直居中

### 7. 发布后修整（8/28-8/31，重新发布追加）：插件形态退役 + 公司评分修复 + Skill Registry v0.3（ADR-031）
- **公司职业价值评分链路修复**：事实段枚举值域协议自包含注入（Agent 不可读契约文件 → 全量 narrative 事实 → 全部 INSUFFICIENT_DATA）；ASSESSMENT_RULES 补 GROWTH 行 + 枚举单一事实源（COMPANY_FACT_VALUES 派生）
- **Claude Code 插件形态退役（ADR-030 H）**：删除 `.claude-plugin`（已非插件体系）；运行时直连 LLM 服务商；AGENTS/README/ARCHITECTURE/CLI-COMPAT 全仓宣称校准 + CLI 时代话术残留清理
- **Skill Registry v0.3（ADR-031 域身份治理）**——索引数据生产权收归 Registration：
  - 事故定性：Skill Matching Failure = Identity Ownership Violation（「画像声明 4 项技能却报未声明」的根因是 JD 长句直接成为身份键）
  - Identity/Reference/Content 三层分离；四态判定（EXISTING / NEW_PROPOSAL / REGISTERED / REJECTED）+ 形态规则闸门（≤12 字/无工具词括号/无句标点）+ soft 域分类（Capability Matching Boundary 执行）
  - `--skill-search`（match 分级：exact 才自动绑定，substring 仅候选展示）/ `--skill-submit`（Proposal ≠ Registration）提案通道；skills.md/roles.md 投影 v2（skill_id｜canonical（来源；原文））
  - 差距分析修复：personSkillCount 分流「未声明」vs「已声明未命中」+「已声明 4 项」不再误报
  - 存量迁移（复制区）：画像 4 技能绑定 registry_skill_id + 9 岗位 200+ 技能需求解析到 skill_id 引用（soft/长句确定性剔除并审计）——端到端验证：机械结构设计（同 id skill_00001）真实命中

## 变更提交（130，自 v1.1.0-beta.2）

### 二期：公司适配榜 + 薪资基准
- 29209ca feat: 公司适配榜数据层——rating 回链 + 候选池/岗位线索登记（契约 v0.1 §2）
- ed0ebc4 feat: 公司页投递榜单模式——分城市段/三层/动作集/诚实标注（契约 v0.1 §3/§4）
- c59eab0 feat+docs: 公司适配榜契约 v0.1 + company-jobs 检索 skill + 资质名单沉淀格式
- ad6fdd4 docs: 适配榜契约升 v0.2 —— §7 展开为二期启动方案（薪资基准+个人估价卡施工图）
- 651455f feat: 二期薪资基准引擎层——SalaryBenchmarkEntry + salary.ts 规则（分位聚合/档位映射/三态估价）+ storage/RPC/watcher + AgentTaskType 12 型
- 0872221 feat: 二期 UI——画像页个人估价卡（四态显式+三态徽标）+ 榜行市场对照 + 事件刷新；引擎岗位解析兼容 Person/PersonSnapshot 两形
- 54a0399 feat: 二期实测修正——薪资解析兼容「·NN薪」后缀与「K/月」单位；估价卡加样本少标注（契约 §7.3.1）
- 0c6510b fix: 画像地图 7 维等分布局——偏好节点与技能节点同点叠字（pos 硬编码 60°×6 位）
- a77f9b7 feat: salary-benchmark skill（二期 §7.6）——双通道检索纪律 + 样本点模式登记契约 + 路由 9 步 + TaskType 表同步
- 3dc40da fix(engine): roles.md 来源引用解析兼容英文冒号（契约 roles-contract 规定的格式）
- df60dd2 feat(engine): roles.md 登记闭环（B1）——role-proposals 提案通道 + Engine 校验投影
- 7531c2f docs(skill): roles-contract v0.2 + 岗位入库改提案通道
- 966e28b fix(UI): 简历 mock 双轨切断 + 差距分析空态文案 + 引擎连接端口可配置
- 1c54568 fix(engine): completePersonInit 完整性门禁（防空壳完成）

### 工作流控制平面 v0.1→v0.3 + Person Health
- e37c87a docs(contract): Career-Workflow-Contract-v0.1——Workflow Control Plane 冻结
- 82e9ad5 feat(engine): Workflow Control Plane v0.1——workflow registry + 双路径 start + advance 四步校验
- 146f5cd feat(UI): Workflow Control Plane 投影——workflow 卡片（进度 + Gate 确认，不 orchestrate）
- 55d124a fix: Workflow 实测修正——watchWorkflows import + pending 用户可发起工作流
- f8a1fdf fix: Workflow 死锁根治——对账循环 + Path B guard + totalStages 单一投影源
- 1aff8fa docs(bug-report): 测试区第 1 轮验证台账（TC-01~08 + BUG-001~005 修复记录）
- 1b3a959 feat: Agent Execution Boundary Repair——实时归位投影 + Stage Envelope 引擎注入
- 7a6cafd docs(bug-report): 第三轮 Agent Execution Boundary Repair 记录 + 测试区回归验证项
- 9d848b1 fix(engine): BUG-006 Path A 完成信号断链——Stage Task done 钩子闭环
- af7718d docs(bug-report): 第二轮验证结果 + BUG-006
- e7d4fcf fix: BUG-007 advance 过 confirm_person_facts 联动 manifest init_state（测试区第三轮验证发现）
- 9c11422 fix(ui): BUG-008 failed stage 进度显示归零 + 无重试出口（测试区第四轮验证发现）
- 1796fbf fix(ui): BUG-009 workflow 卡候选文案双失真（测试区第五轮验证发现）
- ca58043 fix(ui): BUG-009b 候选同步竞态——deps 含 engineStatus（测试区第六轮验证发现）
- 9ee1337 docs(bug-report): 第六轮验证结果 + BUG-009b 竞态根因
- 07d8234 docs(bug-report): 第七轮验证 BUG-009b FIXED 确认 + v0.1 测试循环收口总结
- c312208 feat: Career Workflow Control Plane v0.2（Stage Artifact Lifecycle + 方向池闭环）——L2-1~L2-8
- 320150d test(engine): L2-8a 真实 Agent 链路 Smoke（agent/start→done→intake→Registration→Gate 全链路受控验证）
- 7ef874e fix(ui): BUG-010 Stage 任务绕过 Person Capability Gate + UI-2 方向裁决（executionContext 双平面）
- 3b3d595 feat(ui): WorkflowCard 挂载方向池投影卡（UI-1：active + direction_exploration + 非空自判）
- bbcbbce feat(ui): UI-3 Gate Projection——方向探索 waiting_gate 文案 + 引擎终判
- d910963 feat(ui): UI-4 Restage——重新探索出口（v0.2 §4.2 统一重跑语义）
- 6f28773 feat(engine): Workflow Control Plane v0.3——Stage 3/4 评估闭环 + 推荐落盘 + decision 联动（Evidence Domain 参数化）
- ae7d6b2 feat(ui): Workflow v0.3 Stage 3/4 投影——评估明细卡 + 推荐审阅卡（Human Action 联动）
- 664c2f6 docs(contract): v0.3 冻结标记（引擎 6f28773 + UI ae7d6b2；UI Golden Flow PASS ×2）
- 5f10b16 feat(engine): 画像断层修复——目标岗位投影接通（career_profile 写端）+ 约束载荷契约标准化
- 2a087d3 feat(v0.4.1): Person Health Runtime——事实-投影链路健康检查（ADR-031 落地）
- 09445a1 feat(v0.4.2): City Promotion MVP——Decision → User Choice → Domain Fact 链路（ADR-032 落地）
- 0b6d80b feat(v0.4.2.1): Person Health Attention Projection——健康告警全局呈现（ADR-031 最后一公里）

### 初始化与简历渠道（P0-1）+ 会话修复
- cd617b8 feat(agent): Agent Runtime Decoupling + LLM Provider Migration（ADR-030）
- 03c29af fix(engine): COS_WORKSPACE 隔离联动 paths.db（真机前端验收发现）
- bb76a12 fix(engine): settings/update 写回实际加载的 configPath（真机 first-run 验收发现）
- 80d2765 fix: agent-health provider 显示服务商 id + fact_collection 候选登记标准（P0-1 标准面）
- 1c41cc1 feat(runtime): 简历候选生成确定性通道（PR-1/P0-1）——Agent 退出候选生产
- b6a8f3b fix(ui): pullPersons 对账 currentPersonId——持久化残留失配时归位（初始化候选确认静默失效）
- de40ebf feat(engine): 初始化状态机 + 工作流发起门禁（PR-2 引擎侧 / P1 后端 / P0-1 收口）
- 40fc08b fix(ui): 发起工作流后按当前阶段状态启动 Agent + P1 门禁用 initStatus 禁用
- 292d9c8 fix(engine): 输出预算真机校准（探索/评估/推荐 16K）+ recommendation Artifact 契约精确化
- 394e326 fix(ui): 工作流阶段任务不续接 SDK 会话（Artifact=Memory）
- 0ccf6bf feat(engine): 访谈通道候选生成（P0-1 闭环：无简历用户回答经确定性通道入 Inbox）
- c1031f9 fix(ui): P0-1 UI 接线 + PR-3 初始化提示词降级
- 22ea85b docs: 验收手册（I. User Journey Acceptance）+ 用户旅程文档纳入 git
- 526dc68 fix(engine): Agent 任务注入决策文件输出标准——消除自创字段协议畸形
- 35cd22b fix(ui): 流式消息 rAF 批处理——消除 Maximum update depth exceeded + text_delta 复制累积
- b2a68f2 feat(agent): WebSearch 工具接入（DeepSeek Responses 托管搜索薄封装）+ 初始化 Agent 机制防线
- 5ffd4fa fix(session): 会话归属漂移修复——Session.personId 改存引擎稳定标识 + persist v3 存量迁移
- 6ee3b32 fix(company): contacted 落盘修复（用户事实走引擎登记）+ 候选面板被动刷新

### 搜索与工具基础设施（Phase 4A-C）
- 1406edc feat(search): P1 Search Capability Layer——任务级预算+引擎级缓存（P1a）+ 官方 responses 适配器主路径与守卫降级（P1b）
- 4a7749c feat(search): P2 Provider Capability Registry——webSearch 能力注册表（responses/google/off 判定矩阵）+ native sources 结构化标题
- cca569c feat(metrics): P3 指标板——system/search-stats RPC（web_search trace 聚合）+ 状态栏指标弹层
- 6b55e57 fix(agent): 移除硬编码「关联决策 3」胶囊 + 起止解析月份越界校验
- 24f6689 feat(tool-runtime): Tool Source 分层 + Stage 装配 + 工具级审计 trace
- 8c7549c feat(tool-runtime): Exa MCP 工具源（Tool Runtime P2 首个 mcp source）
- 568fcc6 feat(tool-runtime): 工具定位分工标注 + UI 来源角标（MCP 标识）
- 64b419c feat(data-capability): NBS 权威统计数据源（Evidence Layer 第一个 Data Provider）
- 8f9858c feat(nbs-resolver): NBS Indicator Resolver（语义解析 + 歧义显式化）
- 8dda156 feat(nbs-profile): 区域经济画像矩阵（CompareRegionProfiles）——urban_economy_v1
- c57cf6f feat(evidence-contract): Tool Evidence Contract — tool_done.evidence[]（生产方写、Agent 只读）
- da4f9fa refactor(agent): 生产运行时与 claude adapter 彻底解耦（ADR-030 H step 1）
- 4f4eeca chore(agent): 移除 claude-agent-sdk 依赖与 legacy 保留位（ADR-030 H step 2）
- 1e26f15 docs(adr-030): F deferred 记档 + H 收尾记录 + Production Readiness 评级更新
- c7453a8 refactor(evidence): ToolEvidence.confidence → producerConfidence（语义冻结）
- 7b985f9 feat(industry-evidence): QueryIndustryEvidence — 行业证据检索模板（Phase 3D）
- f3b46d4 feat(provider-stability): 统一外部调用封装（timeout/重试/错误归一/耗时 trace）
- 6ec9f0f feat(provider-stability): Exa MCP 超时/重试配置 + 调用耗时 trace + 记档
- 3ead917 fix(provider-stability): 接入点透传 logger——http_call trace 落盘 + 超时消息毫秒档
- 6909d3e feat(stage-tools): Stage 级渐进披露（Phase 4A）——各阶段声明工具集
- 0ccb81e feat(tool-stats): ToolStats 统一指标投影（Phase 4B）——替换 WebSearch 单一指标板
- 9a89783 feat(tool-stats-ui): 工具指标弹层 + 状态栏（Phase 4B UI）
- b45b041 docs(acceptance): Phase 4B ToolStats 记档 + Provider Stability 测试数校准
- a2d1201 feat(tool-governance): Phase 4C 治理旋钮配置化——budget/cache/超时/重试进 config.json
- e20fe87 docs(acceptance): Phase 4C Tool Governance 旋钮配置化记档
- 06486dd fix(end-to-end): 方向探索链审计修复——契约刚性化/提问归Gate/回答定位/重连观测
- e3e3d85 fix(workflow): BUG-4 方向探索市场检索强化——外部证据必须（Standard 层）
- 523fec7 feat(nbs): P4.5 指标维度语义——per_capita 强 Gate（消除 GDP/人均GDP 口径错配）
- e0af564 fix(workflow): BUG-4 升级——引擎侧市场检索强制（Standard 不生效时的防线）

### Execution 体系 + 会话上下文 + Agent 证据契约（ADR-034/035/036）
- 4d300cc feat: add execution registry v1
- 2d1b253 feat: add execution rpc v1
- 0506eaf refactor(engine): Execution 契约迁移至 ir 共享层（UI 投影消费入口）
- b3ccd62 feat(ui): Execution 投影——sessionTasks 重定义为 Registry projection（刷新/重连任务不再失联）
- a9dd1ed fix(agent): 刷新后提问/回答恢复——executionId answer 通道 + waiting→running 迁移 + 投影路由重建
- 720c51e feat(agent): Interactive Execution Recovery——question/permission 统一 waiting 交互模型 + executionId 恢复通道
- aa61080 feat(execution): resultRefs——确定性 StageArtifact 身份引用（Phase 2.2-B，非内容/路径/推断）
- d9c9784 feat(execution): Phase 3 JSONL event-log persistence——跨进程生命周期 + 启动调和
- af0086b feat(agent): UI Contract——interaction boundary 切分消息段，Execution 驱动状态条（ADR-034 UI 修订）
- a04b794 feat(agent): Evidence 投影 v1——依据来源折叠区（聚合去重/source 分组/hostname 保真，无语义解释层）
- 95d8545 docs(skills): career-advisor SKILL.md 协议漂移清理——删除 allowed-tools/候选标记协议/首次运行自检（候选生产归确定性通道）
- 183d111 fix(agent): 结构化提取器 v2——generateText+严格 JSON 解析+重试（jobs/extract schema 不匹配修复）
- fd925e6 feat(agent): JD 分析闭环——submit_jd_analysis 提案通道 + system 协议通道 + 任务模型配置
- 5f85329 feat(agent): Evidence Sufficiency v0.1——ADR-035 语义冻结 + company_research 任务协议注入（Phase 2）
- 0660eaf feat(agent): Evidence Sufficiency Validator v0.1——契约 §I 11 项机械校验 + Golden Flow 五样本单测（Phase 3）
- c8138a9 fix(agent): Evidence Sufficiency I.11 关键维度限定 + limitation 语义澄清（Golden-D 真机发现驱动）
- b9f1f46 feat(agent): 完成语义接入——company_research done 时契约 §I 校验 + 会话预算事实采集 + UI 充分性徽标（ADR-035 Phase 4）
- 6208a27 fix(agent): limitation=uncertainty 语义收紧——仅用于 UNCERTAIN 维度，限定措辞进 note（Phase 4 真机发现）
- 80a6320 feat(agent): Session Context Frame——ADR-036 Phase 2（会话上下文存储）
- 0f26c9a feat(agent): Context Compiler 编译注入——ADR-036 Phase 3（会话上下文进 system 通道）
- fbec102 feat(agent): 会话焦点投影 + 僵尸 resume 语义清理——ADR-036 Phase 4（UI 适配）
- bd4e44f fix(ui): 会话焦点胶囊增加 engineStatus 依赖——引擎重连后自动刷新（Phase 4 真机发现）
- 131d5bb fix(agent/company): 公司尽调落盘 Proposal 通道 + 投递资格判定修正（能力段为尊）

### 推理等级与 Agent 体验
- ffc3348 feat(document): PDF 视觉提取支持 DeepSeek 多模态 Exp（deepseek-v4-flash-vision-exp）
- 88a4f2d fix(engine): settings/update 视觉 provider 校验支持 deepseek——补遗漏的运行时白名单（前次提交只改了 config/UI 类型，引擎 RPC 校验仍限 zhipu，保存 deepseek 会被 400 拒绝）
- ee92ffb fix(ui): 切换视觉服务商时清除残留默认模型——防 glm↔Exp 错配（DeepSeek 服务商下模型框残留 glm 值会保存为不存在的模型名）
- 8baa074 feat(ui/document): 视觉模型默认切 DeepSeek Exp + 服务商切换模型名自动联动
- c964269 feat(engine): 岗位入库自动链——JD 分析落盘自动派生角色提案投影 roles.md + 启动对账补登
- 7506bfb fix(engine): 自由对话输出预算提档 16K + 空输出显式 empty_output 错误
- c198cef feat(engine,ui): 推理等级选项（thinking 控制）+ 模型选择器美化 + Frame 截断提档 2000
- b7db515 style(ui): 取消模型/推理等级选择器的下拉小三角 + 模型选择器弹出样式对齐推理等级
- 65a9de7 fix(engine,ui): 推理等级对齐 DeepSeek 原生 reasoning_effort 四档 + Tooltip 遮挡修复
- 835bfdf docs(config): 示例配置更新——agent.reasoning（DeepSeek 推理等级四档）+ provider baseUrl 切换原生端点
- 63de55b fix(ui): 推理等级移除 Tooltip——说明内嵌菜单选项（曾浮层遮挡后面内容）
- d30dcbd feat(ui): 输入框微信式展开角标（右上角）+ 右侧操作区垂直居中

### 重新发布追加（5 个提交，指向 2026-08-31）
- c92afec fix(engine): 公司职业价值评分链路修复——事实段枚举值域协议自包含注入（Agent 不可读契约致全量 narrative→全部 INSUFFICIENT_DATA）+ GROWTH 规则补缺（契约 §3/§4 自洽）+ 枚举单一事实源（ASSESSMENT_RULES 派生）
- 6d3a32f refactor(docs,engine,ui): Claude Code 插件形态退役——删除 .claude-plugin + 全仓宣称校准（AGENTS/README/ARCHITECTURE/CLI-COMPAT）+ CLI 时代话术残留清理（config/UI/websocket 注释与描述、providers 启动摘要）
- 68c7934 feat(engine/UI): Skill Registry v0.3——索引数据生产权收归 Registration（ADR-031）：提案通道（--skill-search/--skill-submit 四态判定）+ 形态规则 + soft 域分类 + roles.md 投影 v2 + 差距分析 personSkillCount 分流
- 5440c25 feat(engine): 画像技能 Registry 绑定列——parseSkillInventory 识别 registry_skill_id + 投影合并保留（绑定=系统事实，不因候选重建丢失）
- 7755d59 feat(engine): skill 提案支持 proposed_by 来源参数——画像资产迁移（用户确认技能）与 Agent 提案区分（Proposal ≠ Registration 语义）
