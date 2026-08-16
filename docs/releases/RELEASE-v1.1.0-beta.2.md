# Career OS v1.1.0-beta.2 发布说明

- **发布日期**：2026-08-16
- **Tag**：`v1.1.0-beta.2`
- **范围**：自 `v1.1.0-beta.1` 起 35 个提交

## 本版要点

### 1. 投决闭环（M7）
- JD 差距投影 → **决策记录一键存档**：单按钮，引擎按当前岗位匹配、公司风险与技能缺口自动组装摘要表（零输入）
- 决策 → **简历改写上下文**：存档后一键预填 AI 面板，驱动 JD 定制简历
- **表达候选面板**：简历页按岗位职责分组呈现证据素材，候选复用闭环

### 2. 断链审计 18 项修复
- 身份硬编码清理（person_XXX 占位化）、targets 引擎进链（M6 Target Intelligence）
- 信号面补齐：4 目录 watcher 接线 + error.engine 管线守护（watcher 异常不再击穿进程）
- 协议收敛 2.9（person_id 为系统身份字段，缺失即 invalid）+ INDEX 权威边界 + 孤儿数据清理
- sanitize 中文路径盲区修复（`core.quotepath=false`）

### 3. 数据与架构隔离
- 真实职业数据移出仓库资产，仅存 workspace/（gitignored）
- 测试 fixture 全量合成化（与真实实体零语义关联）、模板虚构化
- sanitize 清单补强（真实公司/学校/技能画像/偏好短语类目）

### 4. 职业画像治理
- 画像治理闭环：偏好/城市/经历事实登记（Candidate → 用户确认 → 登记）
- JD-投递-匹配治理链：身份直连 + 匹配度引擎化
- 城市意向冲突 FLAG（提示不否决——偏好是软事实）
- 规则表 v2（must×2 加权）+ 判定档位

### 5. 简历资产治理链
- 身份/条目/表达三层契约：owner 登记、Entry 契约、事实通道
- 简历派生提案通道（P2-2）：拆分视图 + 整份派生用户裁决
- 优势亮点引用型资产全链：多锚支撑 + 总结提案桥

### 6. 体验与工程
- 关系图谱体验对齐 Obsidian（布局/性能/交互/缩放四维）
- 便携 Node 改为必需运行依赖（缺失 fail fast）
- 配置相对路径按 REPO_ROOT 解析（项目整体迁移不失效）

## 变更提交（35，自 v1.1.0-beta.1）

### 数据边界与隔离
- 3c1fb8f feat: 配置相对路径按 REPO_ROOT 解析——项目整体迁移不失效
- d25bcdf fix: 数据与架构隔离（Data Source Boundary）——真实职业数据移出仓库资产
- 5cc8872 fix: 自查补齐隔离盲区——e2e 测试文档真实职业背景合成化 + person id 移除
- f4918d0 fix: 模板真实公司虚构化 + 测试薪资合成化 + sanitize 清单补强（边界补盲补提）
- 6d16af9 fix: 数据边界补盲——e2e 真实筛选快照移出跟踪 + 模板公司虚构化 + sanitize 清单补强
- ae26ed5 fix: 技能画像合成化——sanitize 盲区补齐（真实技能名嵌入测试 fixture）

### 工程与修复
- dc48120 fix: bat 回退逻辑修复——括号块内 ) 提前闭合导致回退分支解析错乱
- 44c0c72 refactor: 便携 node 改为必需运行依赖——缺失 fail fast 报错，不静默回退
- 4f54c2c docs: config example 对齐真实结构——providers 唯一事实源 + model 字段
- 7be2446 fix: pullPersons 幽灵 Person 复活——localPending 收窄为仅未落盘引擎（无 personId）的进行中 Person
- 18a4fc8 fix: 方向证据聚合判定——方向已探索不被后续空 direction 决策覆盖

### 职业画像与匹配
- b303989 feat: 职业画像治理闭环——偏好/城市断层修复 + 经历事实登记 + 经验门槛年限判定
- b97b649 feat: 规则表 v2（must×2 加权）+ 判定档位 + 旧 AI 分数标注
- c7b5f09 feat: 城市意向冲突 FLAG——提示不否决（偏好是软事实，行为可推翻声明）
- d39a80d feat: JD-投递-匹配治理链闭环——身份直连 + 匹配度引擎化 + 提取标准 v0.2

### 简历资产治理链（P2）
- 188eefb feat: 简历身份字段治理闭环——owner 登记 + identity 通道 + 档案投影 seed
- 23f0c84 feat: 简历条目化与表达资产治理闭环——Entry 契约 + 单侧使用 + 技能资产通道
- bc17329 feat: 简历条目 v0.2 与表达标准 v1.3 治理闭环——description 事实通道 + workRowRef 公司锚点 + 量化可得性规则
- 03f6fb1 feat: 证据生产端 type 判定标准——上游分类规则补位（ST 错标根因修复）
- 74988ef fix: 摘要区块数据链治理——个人优势命名统一 + promote 补 canUseClaim 消费策略校验
- 60ad3c3 feat: 优势亮点引用型资产全链——多锚支撑 + AI 总结提案桥 + 毛玻璃运行卡片
- 5f65844 feat: 简历派生提案通道（P2-2）——优化空间拆分视图 + 整份派生用户裁决
- d59c343 feat: 优化空间模式条显眼化 + 接受后去编辑正向桥
- b00dbde feat: 派生副本「已优化」角标——侧栏卡片 + Dashboard 当前对象卡
- f7a5fb0 feat: 创建版本入口移至版本空间——虚线卡与新增JD/新建会话同构

### 体验
- c91261e feat: 关系图谱体验对齐 Obsidian——布局/性能/交互/缩放四维优化
- 7b3ea9d docs: 界面截图刷新——编号名改中文名（对齐页面命名）
- bd7dd71 docs: README 界面截图对齐当前截图集——新增 JD/简历/方向 4 张 + 旧编号引用移除

### 断链审计修复批次（2026-08-14 ~ 08-16）
- 9e51de2 fix+feat: 断链审计修复——身份硬编码清理 + targets 引擎进链（M6 A1）+ sanitize 中文路径盲区修复
- fcbec7e fix: INDEX 权威边界 + 孤儿数据清理（F13/F17）
- 598ca10 fix: 信号面补齐——4 目录 watcher 接线 + error.engine 管线守护（F9/F10）
- 7fd4fb1 fix+docs: 契约面校准——版本收敛 2.9 + epistemic 声明撤销 + ARCHITECTURE 全面校准（F14/F15/F18）

### 投决闭环（M7）
- 8c24996 fix+feat: 投决闭环基础——decision-writer 补写 person_id + engine-client M7 四 RPC 包装
- 1d1138d feat: M7 决策投决闭环 + 表达候选面板（UI 消费 + 引擎契约修复）
- 5035159 refactor: 决策记录改一键存档（用户评审简化——表单砍成单按钮，引擎自动组装摘要）
- e2f3738 docs: 版本徽章 v1.1.0-beta.2（Beta 2 发布）
