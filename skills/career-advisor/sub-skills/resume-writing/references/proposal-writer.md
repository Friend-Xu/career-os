# Proposal Writer 契约（M3.5.6）

> resume-writing 子模块（AI 建议层消费端）。对应 PROPOSAL-LAYER-M3-v0.1.md §8。
> 输入 = CareerContext（引擎 `ai/context`）+ 源简历版本（`resumes/get`）+ 目标 JD expectations（`jobs/get`）；输出 = `proposals/*.md`（AI 只写 Proposal，不写 ResumeDocument）。

**职责边界**：本契约管"建议改什么"（对已有版本的修改提案）。Proposal 是 AI 与 Artifact System 的唯一修改入口——AI 永不直接修改 `resumes/documents/`，状态（accept/reject）由用户经 UI 决定，引擎执行。

---

## 1. 输入（必须来自引擎，禁止自行组装）

```
CareerContext（ai/context）
  ├─ currentJob（目标岗位 responsibilities / evidenceExpectations）
  ├─ claims（usable / usedByResume / provenance）
  └─ resumes（现有版本 + validation）

+ 源版本全文（resumes/get { id }）——oldSentence 的唯一来源
+ 语言族标准：standards/mechanical/{design|automation|simulation|manufacturing}.md
```

## 2. 提案类型（summary 表 proposal_type）

| 类型 | 语义 | 必填 |
|------|------|------|
| `improve` | 改进表达质量（同岗位语境，无 JD 切换） | target_job_id 可省 |
| `adapt_jd` | 针对新 JD 调整（换岗位目标） | **target_job_id 必填** |
| `replace_sentence` | 单点替换（局部措辞/量化调整） | 可省 |

## 3. 输出格式（AI 写字段；引擎登记后追加 id/status/checksum/validation）

```markdown
# {主题}

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_proposal |
| source_resume_id | resume_20260805_00001 |
| proposal_type | adapt_jd |
| target_job_id | job_20260805_00002（可选；adapt_jd 必填）|

## 变更建议

- claim_20260804_00001（section: experience；old: "通过装配检查和现场调试解决安装干涉问题"；new: "主导气密性工装设计，使装配泄漏率从 3% 降至 0.5%"；reason: "新岗位强调密封工艺量化，期望 engineering_validation 有可度量输出"；expectation: engineering_validation）
```

变更行规则：

- **old 必须从源版本逐字复制**（禁止改写/摘要/重排——引擎按精确匹配校验，防幻觉）
- **new 不得添加源版本与 Claim 中不存在的事实**（数字/结果/责任升级；同一纪律：Claim Strength ≤ Evidence Strength）
- **reason 必须可解释**：引用岗位期望（expectation）或证据维度，说明"为什么这个改动对目标岗位有效"
- expectation 只填源版本 bullet 已有的锚点，或目标岗位真实的 evidenceExpectations patternId；不确定就不填
- 句子含 `；`/`：`/`（）`时照写（引擎按引号保护解析）；句子内不得出现双引号

## 4. 质量检查（写完后逐条自查）

1. 每条 change 的 old 与源版本逐字一致（复制粘贴，不手打）
2. 无编造：new 没有 Claim/源版本不存在的事实
3. 可解释：reason 引用 expectation/证据维度
4. 动词合规：new 的动词层级 ≤ 证据层级（v1.2 §5）
5. 语言族对齐：new 的量化/关键词符合 standards/mechanical/{族}.md

## 5. 禁止（越界即破坏治理边界）

- ❌ 写/改/删 `resumes/documents/` 任何文件
- ❌ 改 Proposal 的 status/created_at/source_checksum/result_resume_id（引擎管理字段）
- ❌ 引用不存在的 Claim / Expectation（登记校验会拒绝）
- ❌ 对同一版本重复提案（先等用户 accept/reject 再提新提案；rejected 提案 = 写新文件，不 reopen）

## 5.5 进化证据读取（M3.5.7：生成前必读）

生成 Proposal **之前**必须读取 CareerContext 的决策反馈投影：

```
CareerContext
├── claims / resumes            （事实层）
├── proposalHistory             （过去发生什么：每次 accept/reject + 理由原样）
└── proposalInsights            （统计趋势：acceptRate / byType / byExpectation / reasons 列表）
```

用途：

- `proposalHistory`：了解过去决策——哪些建议被接受、哪些被拒绝、理由是什么
- `proposalInsights`：识别趋势——哪种提案类型/期望锚点常被拒，避免重复失败
- **AI 自行归纳模式**（"避免无 evidence 的量化收益"这类语义归纳发生在你的推理中）——引擎只给事实与统计，永不生成规则

边界：

- reason 是 **Human Preference Signal**（"被接受"不是正确答案，"被拒绝"可能是噪音）——参考它但不要当作硬规则套用
- 决策反馈不进事实层：禁止把 rejectReason 内容写进 Claim / Evidence

## 6. 生命周期（AI 视角）

```
AI 写 proposals/{主题}.md（pending 由引擎锁定）
   ↓ 引擎 watcher 登记 + 校验（invalid 不登记，文件保留可修正）
   ↓ UI「AI 建议」面板展示
用户 Accept → 引擎确定性应用 → 新版本（v4，lineage parent=源，ai_revision）
用户 Reject → 保留审计（可选原因）
```
