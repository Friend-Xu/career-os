# JD 缺口发现（入口 B：JD 驱动的证据沉淀）

> career-advisor 子模块（evidence）。由主 SKILL.md / AI 面板路由加载，不作为独立 skill 运行。
> 对应 M2 文档 `EVIDENCE-MODEL-M2-v0.1.md` §5 入口 B。输出契约：`evidence-output-schema.md`。
> **这是 Career OS 与普通 JD Matcher 的分水岭**：岗位的"证明需求"反向驱动用户证据沉淀。

---

## 触发

分析 JD 后，岗位智能表（`responsibilities[].evidenceExpectations`）与 `evidence/` 库存对比：
某 responsibility 的证明维度在库存中无关联条目 → 缺口出现。

```
岗位要求证明：scope / validation / impact
你的证据库存：无相关条目
→ 缺口
```

---

## 工作流

```
1. 展示缺口（不空转）
   "这个岗位要求证明「自动化设备结构设计」的：
     验证方式（validation）
     结果指标（impact）
   你的证据库存里没有相关经历。"

2. 问一个问题（复用岗位的 questions 作为提问模板）
   "你是否做过类似的项目/事情？"（用 evidenceExpectations[].questions 展开：
   "比如——你负责过哪些模块的设计？怎么验证设计有效的？"）

3. 分支：
   有类似经历 → 转入 create-evidence 引导流程（按类型分轨：持续职责四问 / 项目六问）→ candidate 落盘
   没有 → 诚实标注缺口（不编造、不生成"声称可学"）

4. 沉淀后闭环
   新条目可关联该岗位（用户在岗位覆盖视图看到它补上了哪些维度）
```

---

## 规则

1. **没有就是没有**：用户说没做过 → 缺口保留，禁止用"我可以学"填充（质量规则：无证据不计入覆盖）
2. **提问模板复用岗位 questions**：不发明新问题，用岗位智能表的追问展开
3. **条目来源仍是 user_input**：内容来自用户口述，JD 只是触发通道（不是来源类型）
4. **一条经历一个条目**：不要为补齐岗位维度把多条经历合并进一条
5. **Anti-Hallucination**：禁止从岗位名推断用户经历——"负责自动化设备结构设计"不等于用户做过自动化设备项目
6. 沉淀完成后再评估：该 responsibility 的覆盖是否改善（交给 UI 覆盖视图，本模块只负责创建候选）
7. **type 按经历性质判定**（v1.3）：岗位期望是持续职责性质（日常维护/例行支持）→ professional_experience；是一次性专项性质 → independent_project。判定标准与 workRowRef 规则见 evidence-output-schema.md
