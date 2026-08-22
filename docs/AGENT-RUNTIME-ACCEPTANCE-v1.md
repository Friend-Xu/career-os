# Agent Runtime Decoupling 验收手册（ADR-030 真机验收 A→H）

> 2026-08-22 | 目的：把「新 Agent 框架能不能稳定跑」升级为「是否具备替代 Claude CLI 成为
> CareerOS 默认运行时的工程资格」。**通过标准以本手册为准，不靠感觉。**
>
> 命名澄清：这不是 "New Agent Framework"——完成的是 **Agent Runtime Decoupling / LLM Provider
> Migration**（从「Claude 驱动的 CareerOS」升级为「CareerOS 驱动的 Agent Runtime」）。
>
> 进度标记：**D/E 开发区进程内真机版 ✅（2026-08-22，tests/agent-real-flow.mjs，真实 DeepSeek x
> 真实引擎 x 临时 workspace）**——D 单阶段 3 登记 0 拒绝 / E 评估 3 登记 0 拒绝 / 推荐关联决策 1 条；
> 全功能从零链（A.5+B+Path A+D/E）由 `tests/accept-full-chain.mjs` 在 scratch workspace 上覆盖
> （**日常实例不参与验收**——测试区即日常使用区，隔离策略见下节）。
>
> 本轮裁定（收尾基线 §收尾）：**技术风险从「未知」降为「收尾验证」**——最难一关已过：
> 证明 CareerOS 的智能来自自己的 Runtime + Artifact 协议，而非 Claude Code 黑盒。
>
> ⚠️ 2026-08-22 第二轮裁定（用户旅程阻断测试）：**Frontend Golden Path FAIL @ Onboarding
> Completion（P0）**——新用户无法完成初始化，因而无法进入核心价值流程。本轮发现与 Agent Runtime
> 迁移无关（ADR-030 已证明"引擎能跑"），是**独立于 A-H 的 Phase 0 Onboarding 缺陷**；
> 最高优先级已从 Agent Runtime 转移至 Onboarding Flow。详见「前端用户视角验收（二）」与
> 「I. User Journey Acceptance」。

## 全功能从零探针（accept-full-chain.mjs，2026-08-22 新增）

**解决「测试区 = 日常使用区」矛盾**：验收不触碰日常实例——引擎 workspace 是配置项，探针在
`mkdtemp` 全新 scratch workspace 上跑**真实 RPC 处理器 + 真实 DeepSeek**（与 UI 完全同路径），跑完即弃。

```
node tests/accept-full-chain.mjs   # 开发区进程内（真实引擎 startServer + 真实 DeepSeek + scratch ws）
```

覆盖（顺序执行，全绿 = 从零全功能链成立）：
1. **A.5 Provider Isolation**：进程内注入毒 env（`ANTHROPIC_BASE_URL=127.0.0.1:9` / `ANTHROPIC_API_KEY=dead`）
   → health 仍 `ready` → 直连路径不读 CLI/代理时代环境变量（运行时确认，非静态审计）
2. **B JD 提取**：`jobs/extract` RPC × 合成 jd-001 → 5 字段断言 + 耗时 < 30s
3. **从零工作流（Path A）**：空 workspace → `person/session/create`（无候选）→ `workflow/start`
   （path=A）→ fact_collection Agent **真实提问卡片**（`agent/answer` 脚本应答连答）→ 候选确认 →
   **引擎 Registration 投影 facts/ + snapshot/ 五件** → advance
4. **D/E 全链**：方向探索 → 评估 → 推荐（无会话续接）→ 三阶段 artifacts 列 + 跨阶段方向一致性

**隔离保障**：① workspace = mkdtemp（日常 workspace 零接触）；② 引擎实例进程内启动于 5298，
不与日常实例（5288/5289）共享任何状态；③ 结束打印 scratch 路径供人工复核。**日常实例不重启、
不 sync、不换代码**——它只在最后「发布切换」动作时动。

## 验收前状态基线

| 维度 | 状态 |
|---|---|
| 代码稳定性 | ✅ 单测全绿 + golden-flow smoke 26 项（开发区） |
| 架构合理性 | ✅ ADR-030 三层分离（Runtime / 能力面 / Provider 层）+ Stage Policy（输出预算按阶段声明） |
| 可替换性 | ✅ AgentEvent 契约稳定（未来 Qwen/Claude API/本地模型只换 Adapter） |
| 真实模型运行稳定性 | ✅ D/E 真机（开发区进程内）已证；逐阶段档位如下 |
| 生产替代资格 | ⏳ 待本手册 A→H 验收（F/G 待测试区） |

**前提操作**：~~sync 到运行实例 + 重启~~（2026-08-22 修订——日常实例不参与验收）。
验收在开发区进程内 scratch workspace 完成（探针自建引擎实例，5298 端口，与日常实例零共享）；
日常实例仅保留最终「发布切换」动作（sync + 重启 + A/D 抽检作为切换后回归）。

---

## A. Provider Smoke Test（5 分钟）

**做什么**：验证 DeepSeek API 可调用 + 模型名合法。
```
cd D:\Github\CarrerOS\engine
node tests\health-check.mjs
```
**PASS 条件**：`状态 = ready`。
**⚠️ 已知坑（2026-08-22 实测）**：`career-os.config.json` 里现有的 DeepSeek apiKey 被端点
拒收（`Authentication Fails ... invalid`）——代理时代该 key 从未被用过（CLI 走 `PROXY_MANAGED`
由代理管授权）。**A 步必须先换有效 key**（设置页或 `COS_LLM_API_KEY=xxx node tests/health-check.mjs`）。
**失败处置**：① 401 → 换 key；② 模型名不合法 → 改 providers.models（如 `deepseek-chat`），
只改配置不改代码。**这一步过了，后面 B-H 才有意义。**

> **可选前置（质量门禁）**：`node tests/quality-check.mjs`——走生产代码路径（StructuredExtractor +
> AgentRunner 真实工具循环）跑真机质量探针：JD 字段准确率 ≥ 80%、方向探索「文件 ≥ 2 +
> 引用 100% 有效 + 幻觉 0」。报告落 `.local/quality-report.md`。key 用
> `COS_LLM_API_KEY=xxx` 传环境变量即可（不用改文件）。

## B. JD Extract Golden Case（5 分钟）

**做什么**：UI 新建 JD → AI 提取，粘贴 `engine/tests/agent/fixtures/synthetic/jd/jd-001.json`
里 `jdText`（合成数据，Company-A）→ 检查日志：
```
jd-extract(direct) 解析：company=Company-A title=机械结构工程师 req=4 loc=City-X salary=12-20K·14薪
```
**PASS 条件**：5 个字段全部解析正确；UI 弹窗回填正常；耗时 < 30s。
**记录**：日志行（作为 B 的验收证据）。

## C. Resume Extract Golden Case（5 分钟）

**做什么**：用一份文本型 PDF 简历建档（person/session/resume 流程），确认简历段落 →
画像候选（教育/经历/技能）链路正常。此链路走 document runtime（zhipu 视觉/文本提取）+ Agent，
与 JD 提取不共用代码，但共用 agents 直连。
**PASS 条件**：建档成功、提取候选出现在采集确认列表；对话助手正常响应（agent/start 直连验证）。

## D. 单阶段方向探索（15 分钟）

**做什么**：跑真实方向探索工作流（workflows start → direction_exploration agent 任务）。
对比基准 = **存量产物**（`decisions/` 下 2026-08-21 的 `20260821-方向A/B/C.md` 系列——
CLI+代理时代真实产物）。
**PASS 条件**（至少 3 项过，1、2 必须过）：
1. 产物文件完整（person_id/stage_id/方向主张/分析摘要表齐）
2. 产物经登记进方向池（directions/list 可见 registered）
3. 事实引用存在（主张引用的 evidence 在 persons/{id}/facts 或 evidence/ 可找到）
4. 无关键幻觉断言（方向轮廓、技能、薪资等判断在输入素材中有依据；无素材凭空断言 = 拒）
5. **Uncertainty Calibration**：素材不足时模型必须正确表达
   `unknown / low confidence / needs evidence`（如"信息不足，需补充 XX 素材"），不得硬给结论
**对比方式**：新产物 vs 存量产物，同 person 素材下方向建议是否收敛（允许表述差异，不允许指向不同赛道）。

> 对抗侧证据（2026-08-22 quality gate v3 真机）：信息稀疏 case（person-002）模型自动按
> "信息不足+需补充"表达；诱导幻觉 case（person-003）模型拒绝编造并明示依据不足；
> 冲突 case（person-004）模型主动标注"素材冲突提示（需用户确认）"——引擎侧 Registration
> 的 EVIDENCE 拒绝是第二道防线，第一道（模型本体）已实测有效。

## E. 多阶段方向探索（15 分钟）

**做什么**：完整链路 方向探索 → 评估 → 推荐（阶段间**无会话续接**，只有 Artifact + Context Assembler
重放）。验证「Artifact = Memory」成立、Claude session 是冗余。
**PASS 条件**：三阶段连续跑通（无 stage 卡死/无 OWNERSHIP_MISMATCH 类拒绝）；推荐阶段给出的
建议方向与探索/评估阶段结论一致（不一致 → 记差异并人工判定，判定结果留档）。
**Context Independence Test（新增核心项）**：同一输入跑两遍——
第一遍：探索阶段（带会话）→ 产物 1；第二遍：删除会话历史，仅给 产物1 + context assembler
→ 评估阶段，产物 2。**产物 2 与第一遍的评估结果一致** → 证明 Artifact 是认知状态、不是聊天记录，
Claude session 是冗余（= CareerOS "Artifact = Externalized Cognition" 架构设计被验证）。

## F. Claude vs Vercel A/B Benchmark（30 分钟）

**做什么**：`cd D:\Github\CarrerOS\engine && node tests\bench-extract.mjs`
（合成 JD fixtures × 双适配器：direct=generateObject vs cli=CLI API 模式）。

**评分标尺（2026-08-22 修正：迁移目标是 `direct ≈ claude`，不是超越）**——
正确目标不是「direct > claude」，而是**质量持平 + 稳定性更高 + 可控性更强**：

| 指标 | 目标 |
|---|---|
| Artifact 完整性 | 不下降 |
| Evidence 有效率 | 100%（引用全部可解析） |
| 幻觉率 | 0 |
| Decision Trace | 100% |
| 耗时 | 下降（直连免 CLI 拉起/代理） |
| 失败可解释性 | 提升（结构化 AgentError；CLI 是黑盒） |

**PASS 条件**：direct 质量持平（四维 artifact 级比较）且稳定性/可控性占优 → 迁移成功。
**不过**：回查 diff——优先调 prompt（EXTRACT_SYSTEM）而不是改代码；仍不过 → 暂停切换，本手册
G/H 不执行，报告呈交评审。

### F 附加评估：Provider Independence Score（迁移本旨——解除基础设施耦合，非换模型）

| 项目 | CLI | Direct |
|---|---|---|
| 依赖外部状态 | ❌（登录态/settings env/代理） | ✅（仅 env/config 凭据） |
| 是否可复现 | △（环境相关） | ✅（同配置同结果） |
| 错误是否可解释 | △（CLI 黑盒） | ✅（结构化 AgentError） |
| 模型切换成本 | 高（换 CLI/代理链） | 低（providers[] 加一行） |
| 环境要求 | Claude CLI | Node runtime |

**此项是迁移的独立判据**：即使 direct 与 cli 质量打平，独立度全面占优也构成切换依据——因为这
正是本迁移的目的（F 表只回答「模型行为是否等价」，本表回答「基础设施是否解耦」）。

> 工作流级 A/B（风险 1：Claude Code 隐性 System Prompt 消失）的最终裁定 = D/E 的产物质量对比。
> D/E 过 + F 过 = 原智能来自模型本体，Claude Code runtime 是容器不是智能源。

## G. 默认切换（15 分钟）

**做什么**：确认运行实例跑在新代码上（sync + 重启已做），UI 设置页 → 模型列表语义收口
（显示 provider 真实模型；遗留 `claude-sonnet-4-6` 显示问题随 Step 4 UI 尾巴一并修）。
**PASS 条件**：A-E 复跑不回归（抽 B + D 各一次即可）。

## H. Runtime Dependency Audit（收尾）

**做什么**：静态审计引擎生产运行时的 CLI 痕迹（不用真跑）：
```
cd D:\Github\CarrerOS\engine && node tests\runtime-dependency-audit.mjs
```
**审计目标**（保留位除外：`agent/adapter/claude.ts` benchmark 基准 + `tests/bench-extract.mjs`）：

| 信号 | 生产运行时计数 |
|---|---|
| claude-agent-sdk import | **0** |
| claude CLI spawn | **0** |
| ANTHROPIC_* env 读取 | **0** |
| ~/.claude settings 读取 | **0** |

**PASS 条件**：审计脚本输出 ✅ 且 A-F 全部通过。
**注意**：`.claude-plugin`（人工交互入口）与本项无关——那是 Claude Code 用法，退役时点另定。

### H 执行流程（2026-08-22 修订：保守，不「F PASS → 马上 rm」）

Claude adapter 的历史价值已从运行组件变为 **benchmark reference / migration evidence /
regression oracle**——它不再需要运行，但历史必须留。顺序：

```
1. git tag pre-provider-decoupling ✅（已打：cd617b8，迁移完成但 CLI 依赖仍在的锚点）
2. commit 1 "refactor(agent): disable claude runtime path"（删 import/spawn/生产 wiring；
   保留 adapter/claude.ts + bench-extract + fixtures）
3. commit 2 "chore: remove claude-agent-sdk dependency"（package.json/lock；npm 变化可独立 revert）
   ——运行路径变化与依赖删除拆两个不可逆点
4. runtime-dependency-audit.mjs 复跑（生产运行时 CLI 痕迹 = 0）
5. 全量测试 + tsc
6. sync 到日常实例 + 重启（此为「发布切换」——唯一动日常实例的动作；回归抽 B/D）
```

### 剩余收尾（2026-08-22 修订：日常实例不参与验收）

1. **全功能从零验收（开发区进程内，scratch workspace）**：
   `node tests/accept-full-chain.mjs` → A.5 隔离 + B JD 提取 + Path A 交互式建档 + D/E 全链
   ——全绿即「从零初始化」链成立；**日常实例不重启、不 sync、不换代码**
2. **F**：`node tests\bench-extract.mjs`（需 CLI 侧可用；标尺见上——≈ 即 PASS）
3. **H**：F 通过后按上节双提交流程（锚点 tag 已就位）

### 后续方向（不阻塞收尾，记档）

- Stage Policy 数值以 F/复跑测量为准调档（当前为安全首档）
- 半结构化协议结构化：`claims[].{statement,evidence,confidence}` + `uncertainties[].{topic,reason}`
  （Career Reasoning ADR 方向；替代「信息不足：xxx」自由文本）
- resume/session 语义：直连模式不消费 resumeSessionId，上下文按 Artifact 全量重建——待全功能从零链复跑再次确认
- **C（简历/文档链路）**：需真实文本 PDF + zhipu 视觉，未纳入自动化探针——保留为 UI 手动步骤
  （scratch workspace 同样隔离，必要时再补）

---

## 收尾基线（2026-08-22 D/E 真机裁定）

### 迁移暴露的四问题（直连前从未见过——CLI 时代被隐藏，迁移把它们暴露并收回控制面）

| # | 问题 | 性质 | 修复 |
|---|---|---|---|
| 1 | `maxOutputTokens` 4096 兼容上限截断工具调用 JSON → 任务 done 实未写产物 | transport contract 不完整（非模型/工具问题） | runner 显式 8K + **Stage Policy**（`StageSpec.task.outputBudget`：探索/评估 8192、采集/推荐 4096、JD 提取 2048）——输出上限是 Control Plane 旋钮，不再散落硬编码 |
| 2 | 技能文件在工作区外，直连工具越界拒绝；`buildSkillIdentity` 却让模型「先读它」 | 架构边界错误（模型知道 ≠ 引擎保证；OWNERSHIP_MISMATCH 实为此类） | 引擎注入 `【ARTIFACT_CONTRACT】` 进 Stage Envelope（产出格式由引擎声明，不依赖模型读文件） |
| 3 | 带前缀引用（`persons/x/facts/f.md`）被域模式当成域外证据 | 同一证据域的不同地址表示 | 域模式宽容（关注「是否属于允许证据域」，不要求字符串精确匹配） |
| 4 | 「信息不足」标注被解析器当证据引用 → 误拒 | 半结构化协议解析不区分 Evidence Claim / Uncertainty Statement | 只校验含 `.md` 的引用行；结构化 claims/uncertainties 记入后续方向（见下） |

### 评级（2026-08-22 修订）

```
Agent Runtime              ★★★★★
Provider Decoupling        ★★★★★
真实模型行为               ★★★★★（含信息稀疏/诱导幻觉/冲突三对抗 case 全过）
Artifact Memory 架构        ★★★★★（E 评估/推荐 = 无会话续接，Artifact Graph + Evidence Graph 承担状态）
Production Readiness        ★★☆☆☆（P0 阻塞：Phase 0 Onboarding 未通过——新用户首闭环断裂，
                            见 P0-1/P0-2/P1 与 I. User Journey Acceptance；A-H 跑通不豁免此判定）
```

### Stage Policy（本轮落地，ADR-030 收尾项）

- 载体：`StageSpec.task.outputBudget`（workflow-registry 声明，transport 按 `getStageSpec` 注入，客户端不可设）
- 语义：单步（单次 assistant 回合）输出预算；档位以真机测量为准可调，调档须连带真机复测
- 防截断防线：预算 ≥ 阶段真实产出需要（4096 档是兼容模式截断事故后的显式余量）
- 测试锚点：`workflow-registry.test.ts` Stage Policy 完整性 + `agent-runner.test.ts` 请求体 `max_tokens` 断言

### 下一阶段：Agent Runtime Hardening v2（非迁移阻塞项，正式立项）

- 长跑稳定性：100 次工作流连续跑
- 并发任务（多 Agent 任务并行 + 权限往返互不干扰）
- Provider 稳定性：timeout / rate limit / 重试退避 / 断点续跑
- `checkAgentHealth` 常态化（设置页健康投影已有，扩展为可观测性基线）

## 前端用户视角验收（2026-08-22，可复现实验）

**环境**：dev 引擎 5299（`COS_WORKSPACE=accept-ws` 全新 scratch）+ UI dev server 5288
（`VITE_COS_WS=ws://127.0.0.1:5299`，从 D:\Github\CarrerOS\UI 源码目录运行）+ Playwright 真实浏览器。
**日常实例（引擎/workspace/UI 原端口）全程未动**。

| # | 结果 | 发现 |
|---|---|---|
| 1 | ✅ | 设置页正确读取后端：DeepSeek 兼容 · 已连接 · deepseek-v4-flash / deepseek-v4-pro；Anthropic 官方=未配置；**无 claude-sonnet-4-6 残留** |
| 2 | ✅ | **隔离缺陷修复**：`COS_WORKSPACE` 覆盖后 db 未跟随 → 隔离实例读写真实 DB（前端显示真实画像）——已修 + 测试 + 提交（03c29af） |
| 3 | ⚠️ | **UI mock 数据**：后端 `persons/list=[]` 时仍显示「我 · 初始化完成 · 5 项技能声明 · 自报意向新能源/机器人」「家人 A 匹配 74%」——demo 数据与真实数据无可视区分，空白态不真实 |
| 4 | ⚠️ | **localStorage 持久化**：app 状态（currentPersonId/会话/画像）缓存于 localStorage——切引擎/新工作区后仍渲染旧数据（数据读取一致性风险） |
| 5 | 🐛 | **React 无限重渲染**：流式事件期间 `patchStreamingMessage`（app-store:1519）setState 死循环，「Maximum update depth exceeded」×7——前端 bug，需修 |
| 6 | 🐛 | **初始化访谈闭环缺口（已升级为 P0-1）**：教育结构化记录 ✅ / 目标卡片 ✅ / 价值卡片 ✅ / 开放问题 ✅；但 Agent 全程不输出 `候选标记：` 协议行（flash/pro 共 6 次尝试），候选清单永远 0 条 → candidates→用户确认 从未发生，UI 文案承诺「确认后才会写入档案」未兑现 |
| 7 | ✅ | 引擎契约校验兜底：初始化决策缺 `## 分析摘要` 表 → 决策时间线「待人工处理」（不信任 Agent 自报，机制生效） |
| 9 | ✅ | **真·零启动（first-run）**：无 config.json 冷启动 → 引擎生成配置 + 字段说明打印；前端正确呈现全「未配置」（Anthropic/DeepSeek/视觉/高德）；UI「验证并获取模型」走**真实 /models** → 已连接 3 模型（含端点实际返回的 vision-exp）→ 启用 → 内存态正确 |
| 10 | 🐛 | **settings/update 落盘硬编码 DEFAULT_CONFIG_PATH**（websocket 1738）：`--config` 自定义实例把设置写进默认配置文件——已修（configPath 传入 startServer + 写回），RPC 验证写回 accept-config、默认配置文件零写入 |
| 11 | ⚠️ | first-run 生成配置的字段说明仍是 CLI 时代话术（`apiKey=（空）复用本机 claude CLI 登录态`）——新链路已禁 CLI，建议修正说明文本（config.ts describeConfig） |
| 12 | ℹ️ | first-run 配置路径目录不存在时 ENOENT 崩溃（生产默认路径=仓库根不会踩；minor，可加 mkdir 宽容） |
| 8 | ❌ | 方向工作流（发起 → 方向确认 → 评估 → 推荐）**未达**：被 Stage 1（事实收集）阻断——见 P0-1；同环境已确认工作流注册/阶段卡片/失败态/重新探索 UI 均可用 |

---

## 前端用户视角验收（二）：用户旅程阻断测试（2026-08-22 第二轮）

**测试目标修正**：按「从用户角度测试，尤其关注前端对后端的数据读取与人机交互逻辑」，正确顺序应为：

```
新用户 → 创建 Person → 上传简历 → 初始化对话 → 产生候选事实 → 用户确认事实
→ 生成 Profile Snapshot → 初始化完成 → 方向探索 → 评估 → 推荐 → 决策
```

本轮**未走完全程**——卡在「初始化完成」之前，因此这是一次 **User Journey Blocking Test**，不是完整功能测试。

**环境（按用户指示修订）**：开发区新建 workspace `D:\Workspace\公司分析\workspace`（全新，
person/resume/决策均为测试数据；简历用「某某的简历.pdf」2 页视觉识别成功）；引擎 5299 + UI dev
5288（`VITE_COS_WS=ws://127.0.0.1:5299`）+ Playwright 真实浏览器；日常实例（`D:\Github\CarrerOS`）
全程未触碰。

### 覆盖矩阵（用户视角）

| 步骤 | 结果 | 说明 |
|---|---|---|
| 创建 Person 对话框（名字/图标/主题色/下一步） | ✅ | 完整走通 |
| 我有简历 → 上传 PDF → 视觉识别（2 页）→ 文本回填 | ✅ | OCR 文本完整；`resume-001` + 源 PDF 落库 |
| 关注方向 → 创建并开始采集 | ✅ | `person_001 某某` 创建，顶栏切换 |
| 初始化对话（简历通道）互动：问答 + 选项按钮 ×2 轮 | ✅ | 对话交互可用 |
| Agent 问答 → 候选确认清单 | ❌ | 见 P0-1（清单永远 0 条） |
| 初始化完成（快照三件齐备） | ❌ | `manifest init_state=in_progress`；intake 对话记录为空 |
| 工作流：注册 / 阶段卡片 / 失败态 / 重新探索 | ✅（UI） | 但 Stage 1 无法通过（P0-1） |
| 方向探索 → 评估 → 推荐 | ❌ 未达 | 被 Stage 1 阻断 |

### 缺陷裁决（本轮核心产出）

#### P0-1 初始化闭环不存在（控制面依赖生成模型行为）

**现象**：真实用户路径 `上传简历 → Agent 提问 → 用户回答 → 等待候选确认` 卡在 `待确认候选=0`。

**机制**：候选进入清单唯一通道 =
`Agent 输出特殊协议文本（候选标记：…）→ 前端 parser → appendCandidates RPC → Candidate Inbox →
用户确认`。同时：Agent 不是可靠协议执行器；用户没有备用入口；UI 没有手动补录入口；
Engine 不接受 Agent 自报（`onFactCollectionReady` guard → failed）——四重叠加 → **Inbox 永远为空**。

**证据**：
1. `deepseek-v4-flash` ×5 次 + `deepseek-v4-pro` ×1 次（A/B）全部不输出 `候选标记：` 行——
   只给「分类标题摘要 + 提问」；其中 flash 第 1 次自写 `candidates.md` 并冒充用户在 frontmatter 署名
   `status: confirmed_by_user`（登记权威越权）。
2. `candidates.md` 从未以引擎行格式（`| c-xxx | pending | … |`）出现过；`listCandidates` 全程 0；
   UI「待确认 0 条 · 已确认 0 条 · 还没有候选信息」全程如此（含初始化对话 + 5 次 restage）。
3. 后端探针（`accept-full-chain.mjs` RPC 直驱动）全绿 ≠ 前端闭环通——该探针由测试脚本代替前端
   完成协议登记，恰好掩盖了这条断裂。
4. 生产链路遵循的已是确定性通道（JD 提取 `generateObject` 直驱动），唯独候选登记仍押注
   "模型打印协议行"——**生产方式不一致**。

**性质**：架构错误——违反 ADR-030 自身原则「Engine 负责事实、Agent 负责判断」；当前实际变成
「Agent 负责产生事实、Engine 等待 Agent 格式正确」，方向反了。

**修复方向（已裁定，暂不实施）**：分层——`Resume Artifact → Structured Resume Extraction →
Resume Facts Artifact → Candidate Generator（确定性）→ Candidate Inbox → 用户确认 → Profile Snapshot`；
Agent 只负责发现缺口（提问/答疑），用户回答经 Candidate Generator 入 Inbox，不打印协议。

#### P0-2 初始化状态与 UI 状态不一致（UI 展示非 Engine state）

**现象**：对话显示「已记录你的确认：事实候选全部接受，候选文件状态更新为 confirmed_by_user」，
实际 `manifest init_state=in_progress`、候选登记 0。用户认知「我完成了」vs 系统状态「没完成」，
且 Agent 自报与系统状态矛盾 → 信任破坏。

**裁定**：UI 只能展示 Engine state；禁止 Agent 自报状态直接以完成态展示。Agent 只能说
「我已整理你的信息，等待系统确认」；状态由 Engine 投影（`candidate_count` / `init_state`）驱动 UI。

#### P1 工作流发起门禁缺失（顺序违反产品设计前提）

**现象**：`init_state=in_progress` 时「发起『职业方向』工作流」仍可点击并真实注册工作流
（`workflow_20260822_00001` Stage 1 running）——绕过了"先完成职业档案初始化"的设计前提。

**裁定**：`if init_state !== completed → disable + 提示「请先完成职业档案初始化」`。
（本轮测试者顺势点击了该按钮——按正确顺序应先闭环初始化，此发现同样成立：门禁缺失本身是缺陷。）

#### 附加发现（第二轮新增）

| # | 级别 | 发现 |
|---|---|---|
| 13 | ⚠️ | 初始化进行中，「会话」空间只有 3 个演示卡（均"完成初始化后开放"），**无当前初始化会话选项卡**——无法识别/回跳 |
| 14 | 🐛 | 顶栏「探索记录」显示 `null×3`（演示会话标题为空无兜底） |
| 15 | ⚠️ | **初始化期间无法更换模型**：新会话全部"锁定" + 模型切换器在 `initMode` 下隐藏——想换模型救场没有入口 |
| 16 | 🐛 | React 无限重渲染复现（第二轮真实初始化上，`app-store.ts:1519 patchStreamingMessage ← :1700 handleAgentEvent`，`Maximum update depth exceeded` ×12）——#5 升级为真实数据稳定复现 |
| 17 | ℹ️ | 引擎侧行为符合验收：fail fast（候选不足→failed，不信任自报）、决策校验（缺 `## 分析摘要` → 待人工处理）、状态机/注册/广播正常 |

**测试范围裁定**：本轮 = User Journey Blocking Test。覆盖 ✅创建 / ✅上传简历 / ✅OCR 提取 /
✅初始化会话 / ✅Agent 交互 / ❌初始化完成 / ❌Profile 生成 / ❌后续工作流。
**结论**：`Frontend Golden Path: FAIL @ Onboarding Completion`；Severity: P0；Impact: 新用户无法
进入核心价值流程。此结论与模型选择、A/B 无关——修复前继续测 D/E/F 均为无效投入。

---

## I. User Journey Acceptance（新增：新用户 0 → 第一次职业建议）

> 2026-08-22 新增。ADR-030 验收（A→H）偏 Runtime；本维度回答更上层的问题：
> **一个第一次打开 CareerOS 的普通用户，能不能从 0 走到第一次职业建议。**
> 独立于 A-H：**首闭环不通，A-H 全过也不具备生产资格**。

### I-1 新用户初始化（核心路径）

```
创建 Person → 上传简历 → Candidate Inbox > 0 → 用户确认 → Snapshot 生成 → init_state = completed
```

**PASS 条件**：
- 创建 Person、上传 Resume 走 UI 完成（有简历 / 无简历两路线均可用）
- `Candidate Inbox > 0`（候选清单出现且有内容；来源=简历/用户描述，带结构化载荷）
- 用户逐条确认（或全部接受）→ 引擎登记事实 + 投影快照（identity / skill_inventory /
  preference_constraints）→ `manifest init_state=completed`
- UI 状态与 Engine state 一致（不展示 Agent 自报状态——P0-2 回归点）
- **当前状态：PASS**（2026-08-22 真机全链路 person_001：确定性生成 21 候选 → 确认 → 快照 → 工作流 4 阶段含推荐采纳 complete；
  2026-08-23 补 UI 自动触发生成接线——真实用户创建无需探针）

### I-2 空数据（无简历）

**PASS 条件**：无简历 → UI 明确提示补充（对话引导 / 粘贴文本）；不允许进入 workflow；
用户确认后仍可完成初始化。**当前状态：PASS**（2026-08-23 真机：person_002「测试乙」粘贴文本创建
→ 无探针自动生成 5 候选（教育/经历/技能×2/约束，全带载荷）→ 面板逐条确认 → facts + 快照四件
→ 进入职业档案（completePersonInit 门禁）→ initStatus=active；P1 门禁在 initStatus≠active 时按钮禁用）。

### I-3 Agent 异常

**PASS 条件**：Agent 不输出协议行 / 输出畸形协议 / 自报成功态——**用户仍可完成流程**
（候选有确定性来源，Agent 行为异常不阻断；Agent 的自报状态不被 UI 采信）。
**当前状态：PASS**（证据：① 候选唯一来源 = 确定性通道（person/candidates/generate），
独立于 Agent 任务——2026-08-22 推荐阶段 Agent 连续 2 次 45-57s 空输出（ok:true 无产物），
用户 restage 后仍完成全流程；② Interview Agent 提示词已降级（2026-08-23）不再输出候选标记行，
即使输出畸形行，登记路径也不消费；③ 面板/初始化状态全部来自引擎 RPC，Agent 文本仅作对话转录）。

### I-4 前后端一致性

**PASS 条件**：UI 所有状态（初始化/候选/决策/工作流阶段）来自 Engine 投影（RPC/广播），
不展示 Agent 自报完成态；任何 Agent 声明与 Engine 状态冲突时以 Engine 为准。
**当前状态：PASS**（2026-08-22：候选面板/初始化状态由 listCandidates/initStatus 驱动；
2026-08-23 复验：待确认计数、initStatus=active 均由引擎投影，UI 无本地完成态——initSessionState
仅 welcome/discovering 两值，无 Agent 驱动的 summary/compiled 渲染；Agent 提示词明确
「不要自行声称完成——由系统门禁裁决」）。

### 验收执行计划

1. 修复 P0-1（分层确定性候选生成，见 P0-1 修复方向）→ 重走 I-1 全路径（真实浏览器）
2. 补测 I-2（无简历路线）；I-3 以"畸形协议输出"用例覆盖
3. I-4 作为 I-1/I-2 的持续断言（UI 状态断言 = Engine state）
4. **I 全绿后才回到 A-H 收尾（F/H）**——Onboarding Flow 优先级高于 Runtime 收尾

### I 修复记录（2026-08-22/23）

| 日期 | 修复 | 验证 |
|---|---|---|
| 08-22 | PR-1 确定性通道（resume-facts.ts + person/candidates/generate）+ PR-2 状态机 + P1 双门禁 + 输出预算真机校准（探索/评估/推荐 16K）+ recommendation Artifact 契约精确化（摘要表两列 12 行 + 明细列协议） | person_001 真机全链路：创建→简历→21 候选→确认→快照→工作流 4 阶段→推荐采纳→completed；测试 867/867 |
| 08-23 | P0-1 UI 接线：finish() 后自动生成候选（简历/粘贴文本通道）+ 访谈通道（source=interview：intake User 轮次 → Facts → Inbox 内容去重）+ PR-3 Agent 降级（StageSpec + 初始化提示词：Interview/Clarify 角色，禁候选标记协议行，完成态由引擎门禁裁决） | person_002 真机：粘贴文本创建→自动生成 5 候选→逐条确认→进入职业档案→initStatus=active；测试 870/870 + 双端 tsc 0 |

> 提交：`1c41cc1`（PR-1）· `b6a8f3b`（currentPersonId 对账）· `de40ebf`（PR-2/P1 后端）· `40fc08b`（P1 前端）
> · `292d9c8`（16K 预算 + 推荐契约）· `394e326`（阶段任务不续接会话）· `0ccf6bf`（访谈通道 + PR-3 引擎）· `c1031f9`（UI 接线 + PR-3 提示词）

## 附：Provider Credential Contract（Step 0.6）

凭据来源优先级 **env（COS_LLM_API_KEY / COS_LLM_BASE_URL / COS_LLM_MODEL）> config.json
providers**；`credentialSource: 'env' | 'config'` 随 `agent/health` 上报（设置页可见凭据来自哪层）。
**禁止**：本机 Claude CLI 运行时参与（settings.json env / ANTHROPIC_BASE_URL / CLI 登录态）——
引擎拥有凭据控制权，CLI 时代隐藏授权（PROXY_MANAGED）不得进入新链路。
