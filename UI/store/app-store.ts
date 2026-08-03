import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Application,
  ChatMessage,
  Company,
  DecisionRecord,
  DecisionStage,
  HealthReport,
  MainWidthMode,
  NavPageId,
  PendingPermission,
  Person,
  RewriteFeedbackReason,
  RewriteState,
  Session,
  StageStatus,
} from '../types'
import {
  APPLICATIONS,
  COMPANIES,
  DECISIONS,
  PERSONS,
  SESSIONS,
  STAGES,
} from '../data/mock-data'
import type { AgentRuntimeEvent, DecisionAggregate, DecisionChain, Role, Skill, Validation } from '../../engine/ir/schema.ts'
import {
  EVENTS,
  createEngineClient,
  type DecisionView,
  type EngineClient,
  type EngineStatus,
  type GraphResult,
} from './engine-client'

/** 引擎公司档案（带 validation 降级标记）；mock COMPANIES 无 validation，结构兼容 */
type CompanyView = Company & { validation?: Validation }

/** 按人构造决策链进度：人 1 走完三步（演示主线），其余人差异化。 */
function makePersonStages(statusMap: Record<string, StageStatus>): DecisionStage[] {
  return STAGES.map((s) => ({
    ...s,
    status: statusMap[s.id] ?? 'pending',
    completedAt: s.status === 'completed' && statusMap[s.id] === 'completed' ? s.completedAt : undefined,
  }))
}

function buildInitialPersonStages(): Record<number, DecisionStage[]> {
  return {
    1: makePersonStages({
      direction: 'completed',
      transfer: 'completed',
      city: 'completed',
      company: 'current',
    }),
    2: makePersonStages({ direction: 'completed', transfer: 'current' }),
  }
}

function freshPersonStages(): DecisionStage[] {
  return makePersonStages({ direction: 'current' })
}

// ─── 会话消息写入（权限/提问反馈进对话流；sessions 不持久化，不入 partialize）──

/** 权限决策挂起：requestPermission 返回的 promise 由审批动作 resolve（真实流接入后 await 此值） */
let resolvePending: ((ok: boolean) => void) | null = null

function appendToSession(sessionId: string, message: ChatMessage): void {
  useAppStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, updatedAt: message.timestamp, messages: [...sess.messages, message] }
        : sess,
    ),
  }))
}

/** 审批结果以 system 消息反馈进对话流（角色 system 渲染为居中浅注，非气泡） */
function appendSystemMessage(sessionId: string, text: string): void {
  appendToSession(sessionId, {
    id: `msg-${Date.now()}`,
    role: 'system',
    content: text,
    timestamp: new Date().toISOString(),
  })
}

/** 权限请求消息的工具 chip 状态流转：waiting_approval → done（放行）/ denied（拒绝） */
function patchToolCallStatus(
  sessions: Session[],
  pending: PendingPermission,
  status: 'done' | 'denied',
): Session[] {
  return sessions.map((s) =>
    s.id === pending.sessionId
      ? {
        ...s,
        messages: s.messages.map((m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((t) =>
            t.name === pending.toolName && t.status === 'waiting_approval'
              ? { ...t, status }
              : t,
          ),
        })),
      }
      : s,
  )
}

interface AppState {
  currentPersonId: number;
  currentPage: NavPageId;
  agentPanelOpen: boolean;
  mainWidthMode: MainWidthMode;
  commandPaletteOpen: boolean;
  engineStatus: EngineStatus;
  poolGraph: GraphResult | null;
  sessions: Session[];
  currentSessionId: string;
  applications: Application[];
  decisions: DecisionView[];
  /** 决策聚合视图（V1.5）：引擎实时派生，不持久化——offline/未建 context 时为空数组 */
  contexts: DecisionAggregate[];
  /** 知识层（V2）：技能词表 + 岗位清单（引擎实时派生，不持久化；status 标注 RPC 成败——视图按诚实空态消费） */
  knowledge: { skills: Skill[]; roles: Role[]; status: 'idle' | 'ready' | 'error' };
  /** 健康投影（契约 v1，引擎实时计算；offline 时页面用 mock 兜底） */
  health: HealthReport | null;
  companies: CompanyView[];
  persons: Person[];
  personStages: Record<number, DecisionStage[]>;
  agentDraft: string;
  agentContextFiles: string[];
  pendingPrompt: string | null;
  personSwitchDialogOpen: boolean;
  pendingPersonId: number | null;
  personCreateDialogOpen: boolean;
  activeResumeId: string;
  infopoolFilter: string;
  companiesFilter: string;
  applicationsFilter: string;
  locateTarget: string | null;
  /** 挂起的权限请求（授权弹窗数据源）；null = 无待决授权 */
  pendingPermission: PendingPermission | null;
  /** 批量放行：sessionId → 本会话内已自动放行的工具名（sessions 不持久化，随会话消亡） */
  approvedTools: Record<string, string[]>;
  /** 简历 AI 改写任务（浮层状态机，不持久化；在线走真实 agent，离线由页面降级规则候选） */
  rewrite: RewriteState;

  currentPerson: () => Person;
  setPage: (page: NavPageId) => void;
  setPerson: (personId: number) => void;
  confirmPersonSwitch: (keepSession: boolean) => void;
  cancelPersonSwitch: () => void;
  setPersonCreateDialogOpen: (open: boolean) => void;
  setActiveResumeId: (id: string) => void;
  addPerson: (person: Omit<Person, 'id'>) => number;
  archivePerson: (personId: number) => void;
  toggleAgentPanel: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  setMainWidthMode: (mode: MainWidthMode) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAgentDraft: (draft: string) => void;
  setPendingPrompt: (prompt: string | null) => void;
  startAnalysis: (prompt: string) => void;
  expandToFullAgent: () => void;
  sendAgentMessage: (content: string) => void;
  setCurrentSession: (id: string) => void;
  createSession: (title?: string) => void;
  /** 权限消费入口（真实 Agent 流 + 演示共用）：会话内已批量放行 → 立即放行；否则挂起弹窗等待决策 */
  requestPermission: (toolName: string, description: string) => Promise<boolean>;
  approvePermission: () => void;
  denyPermission: () => void;
  approveAllPermissions: () => void;
  simulatePermissionRequest: (toolName: string, description: string) => void;
  simulateQuestionRequest: (question: string, options: string[]) => void;
  answerQuestion: (messageId: string, answer: string) => void;
  /** 简历 AI 改写：指令 + 目标岗位上下文 → 真实 agent 任务（事件经 rewriteTaskId 路由到 rewrite 状态） */
  startRewrite: (text: string, instruction: string, jdContext: string) => Promise<void>;
  cancelRewrite: () => void;
  resetRewrite: () => void;
  /** 2B：rewrite 用户决策事件上报（只记录不学习，契约 Resume-Feedback-Contract-v1） */
  reportRewriteFeedback: (fb: { action: 'apply' | 'reject'; reason?: RewriteFeedbackReason }) => void;
  /** 简历导出 PDF：引擎 Edge headless 渲染；未连接 → 抛错（页面降级 window.print） */
  exportResume: (html: string) => Promise<{ pdf: string; fileName: string }>;
  updateApplicationStatus: (id: number, status: Application['status']) => void;
  addDecision: (record: DecisionRecord) => void;
  markCompanyContacted: (id: string) => void;
  setInfopoolFilter: (filter: string) => void;
  setCompaniesFilter: (filter: string) => void;
  setApplicationsFilter: (filter: string) => void;
  setLocateTarget: (target: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentPersonId: 1,
      currentPage: 'workbench',
      agentPanelOpen: true,
      mainWidthMode: 'narrow',
      commandPaletteOpen: false,
      engineStatus: 'offline',
      poolGraph: null,
      sessions: SESSIONS,
      currentSessionId: 's-current',
      applications: APPLICATIONS,
      decisions: DECISIONS,
      contexts: [],
      knowledge: { skills: [], roles: [], status: 'idle' },
      health: null,
      companies: COMPANIES,
      persons: PERSONS,
      personStages: buildInitialPersonStages(),
      agentDraft: '',
      agentContextFiles: ['profile.md', 'decision.md', 'company DB'],
      pendingPrompt: null,
      personSwitchDialogOpen: false,
      pendingPersonId: null,
      personCreateDialogOpen: false,
      activeResumeId: 'r-dji',
      infopoolFilter: 'all',
      companiesFilter: 'all',
      applicationsFilter: '全部',
      locateTarget: null,
      pendingPermission: null,
      approvedTools: {},
      rewrite: { status: 'idle', text: '' },

  currentPerson: () => {
    const { currentPersonId, persons } = get()
    return persons.find((p) => p.id === currentPersonId) ?? persons[0]
  },

  setPage: (page) => {
    const state = get()
    // 决策 Agent / 简历中心：收起 AI 面板
    if (page === 'agent' || page === 'resumes') {
      set({
        currentPage: page,
        agentPanelOpen: false,
        mainWidthMode: page === 'resumes' ? 'fullscreen' : 'fullscreen',
      })
      return
    }
    // 信息池默认全屏
    if (page === 'infopool') {
      set({
        currentPage: page,
        agentPanelOpen: false,
        mainWidthMode: 'fullscreen',
      })
      return
    }
    // 投递管理默认宽档
    if (page === 'applications') {
      set({
        currentPage: page,
        agentPanelOpen: true,
        mainWidthMode: 'wide',
      })
      return
    }
    // 设置：面板收窄
    if (page === 'settings') {
      set({
        currentPage: page,
        agentPanelOpen: false,
        mainWidthMode: 'wide',
      })
      return
    }
    // 工作台默认窄档 + 面板展开
    set({
      currentPage: page,
      agentPanelOpen: state.agentPanelOpen || page === 'workbench',
      mainWidthMode: page === 'workbench' ? 'narrow' : state.mainWidthMode,
    })
    if (page === 'workbench') {
      set({ agentPanelOpen: true, mainWidthMode: 'narrow' })
    }
  },

  setPerson: (personId) => {
    const { currentPersonId, sessions, currentSessionId } = get()
    if (personId === currentPersonId) return
    const session = sessions.find((s) => s.id === currentSessionId)
    if (session && session.messages.length > 0) {
      set({ personSwitchDialogOpen: true, pendingPersonId: personId })
      return
    }
    set({ currentPersonId: personId })
  },

  confirmPersonSwitch: (keepSession) => {
    const { pendingPersonId, currentSessionId, sessions } = get()
    if (pendingPersonId == null) return
    if (!keepSession) {
      set({
        currentPersonId: pendingPersonId,
        pendingPersonId: null,
        personSwitchDialogOpen: false,
        sessions: sessions.map((s) =>
          s.id === currentSessionId ? { ...s, messages: [] } : s,
        ),
      })
    } else {
      set({
        currentPersonId: pendingPersonId,
        pendingPersonId: null,
        personSwitchDialogOpen: false,
      })
    }
  },

  cancelPersonSwitch: () => {
    set({ personSwitchDialogOpen: false, pendingPersonId: null })
  },

  setPersonCreateDialogOpen: (open) => set({ personCreateDialogOpen: open }),

  setActiveResumeId: (id) => set({ activeResumeId: id }),

  addPerson: (person) => {
    const nextId = get().persons.reduce((m, p) => Math.max(m, p.id), 0) + 1
    const full: Person = { ...person, id: nextId }
    set((state) => ({
      persons: [...state.persons, full],
      personStages: { ...state.personStages, [nextId]: freshPersonStages() },
      currentPersonId: nextId,
    }))
    return nextId
  },

  archivePerson: (personId) => {
    if (personId === get().currentPersonId) return
    set((state) => ({
      persons: state.persons.map((p) =>
        p.id === personId ? { ...p, archived: true } : p,
      ),
    }))
  },

  toggleAgentPanel: () => {
    const { agentPanelOpen, mainWidthMode, currentPage } = get()
    if (currentPage === 'agent' || currentPage === 'resumes') return
    const nextOpen = !agentPanelOpen
    let nextMode = mainWidthMode
    if (!nextOpen && mainWidthMode === 'narrow') nextMode = 'wide'
    if (nextOpen && mainWidthMode === 'wide') nextMode = 'narrow'
    set({ agentPanelOpen: nextOpen, mainWidthMode: nextMode })
  },

  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),

  setMainWidthMode: (mode) => {
    if (mode === 'fullscreen') {
      set({ mainWidthMode: mode, agentPanelOpen: false })
    } else if (mode === 'wide') {
      set({ mainWidthMode: mode, agentPanelOpen: false })
    } else {
      set({ mainWidthMode: mode, agentPanelOpen: true })
    }
  },

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  setAgentDraft: (draft) => set({ agentDraft: draft }),

  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),

  startAnalysis: (prompt) => {
    set({
      agentPanelOpen: true,
      agentDraft: prompt,
      pendingPrompt: prompt,
      mainWidthMode: 'narrow',
    })
  },

  expandToFullAgent: () => {
    set({
      currentPage: 'agent',
      agentPanelOpen: false,
      mainWidthMode: 'fullscreen',
    })
  },

  sendAgentMessage: (content) => {
    const { sessions, currentSessionId, engineStatus } = get()
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: now,
    }
    set({
      agentDraft: '',
      pendingPrompt: null,
      sessions: sessions.map((s) =>
        s.id === currentSessionId
          ? { ...s, updatedAt: now, messages: [...s.messages, userMsg] }
          : s,
      ),
    })

    // 真实 Agent 流（引擎在线）：task 直接发 prompt，Agent 在 workspace 根自读信息池；
    // 有 SDK 会话凭据则 resume 续接（会话连续性）
    if (engineStatus === 'connected') {
      const session = sessions.find((s) => s.id === currentSessionId)
      void runAgentTask(currentSessionId, content, session?.sdkSessionId)
      return
    }

    // 离线降级：保留演示 mock 回复（不假死）
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content:
        '已接收你的请求。正在结合 profile、决策链与公司库进行分析…\n\n（引擎离线，演示模式：此处为模拟回复。确认后可写入决策记录。）',
      timestamp: now,
      toolCalls: [
        { name: 'read_profile', status: 'done' },
        { name: 'read_decisions', status: 'done' },
      ],
    }
    useAppStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === currentSessionId
          ? { ...sess, updatedAt: now, messages: [...sess.messages, assistantMsg] }
          : sess,
      ),
    }))
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  createSession: (title = '新会话') => {
    const id = `s-${Date.now()}`
    const now = new Date().toISOString()
    const session: Session = {
      id,
      title,
      personId: get().currentPersonId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      messages: [],
    }
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }))
  },

  updateApplicationStatus: (id, status) => {
    set((state) => ({
      applications: state.applications.map((a) =>
        a.id === id ? { ...a, status } : a,
      ),
    }))
  },

  addDecision: (record) => {
    // 引擎 connected：决策真相在引擎（写 md → data.decisions.changed 事件 → pullChains 重拉），
    // 本地只保留内存写入（演示模式不写引擎），不本地推进阶段——避免与引擎派生打架。
    // 引擎 offline：演示模式本地推进（当前 stage 完成 → 下一 pending 置 current）。
    const { currentPersonId, personStages, engineStatus } = get()
    const stages = personStages[currentPersonId]
    let nextStages = stages
    if (engineStatus !== 'connected' && stages) {
      const idx = stages.findIndex((s) => s.status === 'current')
      nextStages = stages.map((s, i) => {
        if (idx >= 0 && i === idx) {
          return {
            ...s,
            status: 'completed' as const,
            completedAt: new Date().toISOString().slice(0, 10),
          }
        }
        if (idx >= 0 && i === idx + 1 && s.status === 'pending') {
          return { ...s, status: 'current' as const }
        }
        return s
      })
    }
    set((state) => ({
      decisions: [record, ...state.decisions],
      personStages: { ...personStages, [currentPersonId]: nextStages },
    }))
  },

  markCompanyContacted: (id) => {
    set((state) => ({
      companies: state.companies.map((c) =>
        c.id === id ? { ...c, contacted: true } : c,
      ),
    }))
  },

  setInfopoolFilter: (filter) => set({ infopoolFilter: filter }),

  setCompaniesFilter: (filter) => set({ companiesFilter: filter }),

  setApplicationsFilter: (filter) => set({ applicationsFilter: filter }),

  setLocateTarget: (target) => set({ locateTarget: target }),

  requestPermission: (toolName, description) => {
    const sessionId = get().currentSessionId
    // 会话内已批量放行 → 不弹窗，直接放行并反馈
    if (get().approvedTools[sessionId]?.includes(toolName)) {
      appendSystemMessage(sessionId, `已自动放行工具「${toolName}」（会话内已授权）`)
      return Promise.resolve(true)
    }
    set({ pendingPermission: { toolName, description, sessionId } })
    return new Promise<boolean>((resolve) => {
      resolvePending = resolve
    })
  },

  approvePermission: () => {
    const pending = get().pendingPermission
    if (!pending) return
    resolvePending?.(true)
    resolvePending = null
    set({
      pendingPermission: null,
      sessions: patchToolCallStatus(get().sessions, pending, 'done'),
    })
    appendSystemMessage(pending.sessionId, `已放行工具「${pending.toolName}」`)
  },

  denyPermission: () => {
    const pending = get().pendingPermission
    if (!pending) return
    resolvePending?.(false)
    resolvePending = null
    set({
      pendingPermission: null,
      sessions: patchToolCallStatus(get().sessions, pending, 'denied'),
    })
    // permission_denied 不是错误：提示换一种问法，不渲染红色错误
    appendSystemMessage(pending.sessionId, `已拒绝工具「${pending.toolName}」，可换一种问法`)
  },

  approveAllPermissions: () => {
    const pending = get().pendingPermission
    if (!pending) return
    const { approvedTools } = get()
    set({
      approvedTools: {
        ...approvedTools,
        [pending.sessionId]: [...(approvedTools[pending.sessionId] ?? []), pending.toolName],
      },
    })
    get().approvePermission()
  },

  /** 演示入口：模拟一次权限请求（真实 LLM 流接入后由 permission_request 事件自动触发） */
  simulatePermissionRequest: (toolName, description) => {
    const sessionId = get().currentSessionId
    // 会话内已批量放行：不再弹窗，直接自动放行反馈
    if (get().approvedTools[sessionId]?.includes(toolName)) {
      void get().requestPermission(toolName, description)
      return
    }
    appendToSession(sessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: `Agent 请求调用工具「${toolName}」`,
      timestamp: new Date().toISOString(),
      toolCalls: [{ name: toolName, status: 'waiting_approval' }],
    })
    void get().requestPermission(toolName, description)
  },

  /** 演示入口：模拟一次 AskUserQuestion 提问卡片（真实 LLM 流接入后由 Agent 提问触发） */
  simulateQuestionRequest: (question, options) => {
    const now = new Date().toISOString()
    appendToSession(get().currentSessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: question,
      timestamp: now,
      question: { id: `q-${Date.now()}`, question, options, answered: false },
    })
  },

  answerQuestion: (messageId, answer) => {
    const { sessions, currentSessionId } = get()
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: answer,
      timestamp: now,
    }
    set({
      sessions: sessions.map((s) =>
        s.id === currentSessionId
          ? {
            ...s,
            updatedAt: now,
            messages: [
              ...s.messages.map((m) =>
                m.id !== messageId || !m.question
                  ? m
                  : { ...m, question: { ...m.question, answered: true, answer } },
              ),
              userMsg,
            ],
          }
          : s,
      ),
    })
    // 真实 Agent 流：回答送达 Agent。
    // 任务还活着 → answerAgent 即时通道；任务已结束（CLI 提问后立即放弃，实测常态）
    // → resume 原会话续接发送回答（模型在恢复的上下文中看到回答）。
    const active = [...agentTasks.entries()].find(([, t]) => t.sessionId === currentSessionId)
    if (active) {
      void engine?.answerAgent(active[0], answer)
      return
    }
    const session = useAppStore.getState().sessions.find((s) => s.id === currentSessionId)
    const question = sessions
      .find((s) => s.id === currentSessionId)
      ?.messages.find((m) => m.id === messageId)?.question?.question
    if (session?.sdkSessionId !== undefined && question !== undefined) {
      void runAgentTask(currentSessionId, `用户回答了你的问题「${question}」：${answer}。请确认收到并继续。`, session.sdkSessionId)
    }
  },

  startRewrite: async (text, instruction, jdContext) => {
    if (!engine || get().engineStatus !== 'connected') return
    try {
      const { taskId } = await engine.startAgent({ task: buildRewritePrompt(text, instruction, jdContext) })
      rewriteTaskId = taskId
      const selectedTextHash = await sha256Hex(text)
      set({ rewrite: { status: 'thinking', text: '', requestId: taskId, selectedTextHash } })
    } catch (err) {
      set({
        rewrite: {
          status: 'error',
          text: '',
          error: { code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true },
        },
      })
    }
  },

  cancelRewrite: () => {
    if (rewriteTaskId !== null) void engine?.cancelAgent(rewriteTaskId)
    rewriteTaskId = null
    set({ rewrite: { status: 'idle', text: '' } })
  },

  resetRewrite: () => {
    rewriteTaskId = null
    set({ rewrite: { status: 'idle', text: '' } })
  },

  /** 2B：rewrite 用户决策事件上报（只记录不学习——契约 Resume-Feedback-Contract-v1） */
  reportRewriteFeedback: (fb: { action: 'apply' | 'reject'; reason?: RewriteFeedbackReason }) => {
    const r = get().rewrite
    if (!engine || get().engineStatus !== 'connected') return
    if (!r.requestId || !r.selectedTextHash) return // 规则候选/非 AI 改写不上报
    void engine.reportRewriteFeedback({
      requestId: r.requestId,
      action: fb.action,
      reason: fb.reason,
      selectedTextHash: r.selectedTextHash,
    })
  },

  exportResume: async (html) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.exportResume(html)
  },
    }),
    {
      name: 'career-os',
      version: 2,
      // 模型 B（角色 = 人）：旧 schema 是岗位角色，不兼容，直接重置
      migrate: () => undefined,
      partialize: (s) => ({
        currentPersonId: s.currentPersonId,
        currentPage: s.currentPage,
        agentPanelOpen: s.agentPanelOpen,
        mainWidthMode: s.mainWidthMode,
        applications: s.applications,
        decisions: s.decisions,
        companies: s.companies,
        persons: s.persons,
        personStages: s.personStages,
        activeResumeId: s.activeResumeId,
        infopoolFilter: s.infopoolFilter,
        companiesFilter: s.companiesFilter,
        applicationsFilter: s.applicationsFilter,
      }),
    },
  ),
)

// ─── 引擎接线（桥接联调）：连接 → 拉取真实数据 → 订阅变更信号 ─────────────
// 事件是通知，状态是可拉的资源：data.decisions.changed 只作信号，数据经 RPC 拉取。
// 离线降级：连接失败/断开 → engineStatus offline，UI 保持 mock/现有数据不假死。

let engine: EngineClient | null = null

export function getEngine(): EngineClient | null {
  return engine
}

// ─── 真实 Agent 流（engine agent.event 消费；sessions 不持久化，任务映射随会话消亡）──

/** 活跃任务：taskId → 所属会话 + 流式占位消息（一次一任务；done/error 清理） */
const agentTasks = new Map<string, { sessionId: string; messageId: string }>()

/** 简历 AI 改写任务 id（非会话任务：事件路由到 rewrite 状态而非会话消息） */
let rewriteTaskId: string | null = null

/** 2B：选中原文 SHA-256 截断 16 位（隐私：只存 hash 不存原文，契约 Resume-Feedback-Contract-v1 §4） */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** 改写 prompt：只输出改写文本，避免污染浮层结果 */
function buildRewritePrompt(text: string, instruction: string, jdContext: string): string {
  return [
    '改写下面的简历文本片段，使其更符合目标岗位的招聘标准。',
    jdContext.length > 0 ? `目标岗位上下文：${jdContext}` : '',
    `要求：${instruction}`,
    '只输出改写后的文本本身，不要任何解释、前缀或引用标记。',
    '原文：',
    text,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 流式消息 patch（text_delta 累积 / toolChips 流转，基于现值回调） */
function patchStreamingMessage(
  sessionId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage,
): void {
  useAppStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, messages: sess.messages.map((m) => (m.id === messageId ? fn(m) : m)) }
        : sess,
    ),
  }))
}

/** 发起真实 Agent 任务：startAgent → 占位消息 → 事件流按 taskId 路由到占位消息 */
async function runAgentTask(sessionId: string, content: string, resumeSessionId?: string): Promise<void> {
  if (!engine) return
  try {
    const { taskId } = await engine.startAgent({
      task: content,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    })
    const messageId = `msg-${Date.now()}`
    appendToSession(sessionId, {
      id: messageId,
      role: 'assistant',
      content: '',
      isThinking: true, // 占位即亮指示器；thinking_stop / 首个 text_delta / tool_start 熄灭
      timestamp: new Date().toISOString(),
    })
    agentTasks.set(taskId, { sessionId, messageId })
  } catch (err) {
    appendToSession(sessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
      error: { code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true },
    })
  }
}

/** 事件处理器（connectEngine 注册一次）：引擎 Agent 事件 → 会话消息流 / 改写浮层 */
function handleAgentEvent(taskId: string, ev: AgentRuntimeEvent): void {
  // 改写任务分叉：事件路由到浮层状态（text_delta 累积改写结果；thinking 仅作状态提示不显示内容）
  if (rewriteTaskId === taskId) {
    switch (ev.type) {
      case 'text_delta':
        useAppStore.setState((s) => ({
          rewrite: { ...s.rewrite, status: 'streaming', text: s.rewrite.text + ev.text },
        }))
        break
      case 'done':
        rewriteTaskId = null
        useAppStore.setState((s) => {
          // R004：Agent 空输出 → empty_output（retryable），不做静默成功
          if (s.rewrite.text.trim().length === 0) {
            return {
              rewrite: {
                ...s.rewrite,
                status: 'error',
                error: { code: 'empty_output', message: '未生成改写内容，请重试', retryable: true },
              },
            }
          }
          return { rewrite: { ...s.rewrite, status: 'done' } }
        })
        break
      case 'error':
        rewriteTaskId = null
        useAppStore.setState((s) => ({ rewrite: { ...s.rewrite, status: 'error', error: ev.error } }))
        break
    }
    return
  }

  const task = agentTasks.get(taskId)
  if (!task) return
  const { sessionId, messageId } = task
  switch (ev.type) {
    case 'text_delta':
      // 无思考直达的轮次：首个文本即熄灭指示器
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        isThinking: false,
        content: m.content + ev.text,
      }))
      break
    case 'thinking_start':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: true }))
      break
    case 'thinking_delta':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, thinking: (m.thinking ?? '') + ev.text }))
      break
    case 'thinking_stop':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      break
    case 'tool_start':
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        isThinking: false,
        toolCalls: m.toolCalls?.some((t) => t.name === ev.name)
          ? m.toolCalls
          : [...(m.toolCalls ?? []), { name: ev.name, status: 'running' as const }],
      }))
      break
    case 'tool_done':
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((t) => (t.name === ev.name ? { ...t, status: 'done' as const } : t)),
      }))
      break
    case 'permission_request': {
      // chip 置等待授权 + 弹窗决策（requestPermission 复用批量放行）→ 决策回传引擎
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((t) =>
          t.name === ev.tool && t.status === 'running'
            ? { ...t, status: 'waiting_approval' as const }
            : t,
        ),
      }))
      void (async () => {
        const allow = await useAppStore.getState().requestPermission(ev.tool, `工具「${ev.tool}」请求执行`)
        void engine?.permissionAgent(taskId, ev.requestId, allow)
      })()
      break
    }
    case 'question_request':
      appendToSession(sessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: ev.question.question,
        timestamp: new Date().toISOString(),
        question: {
          id: `q-${Date.now()}`,
          question: ev.question.question,
          options: ev.question.options.map((o) => o.label),
          answered: false,
        },
      })
      break
    case 'session_id':
      useAppStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, sdkSessionId: ev.sessionId } : sess,
        ),
      }))
      break
    case 'done':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      agentTasks.delete(taskId)
      break
    case 'error':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      appendToSession(sessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: ev.error.message,
        timestamp: new Date().toISOString(),
        error: ev.error,
      })
      agentTasks.delete(taskId)
      break
  }
}

async function pullDecisions(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listDecisions()
    useAppStore.setState({ decisions: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 决策聚合视图（V1.5）：引擎实时派生（contexts/list），offline/未建 context 时保持空数组 */
async function pullContexts(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listContexts()
    useAppStore.setState({ contexts: list })
  } catch {
    // offline：保持空数组（聚合视图显示空态，不假死）
  }
}

/** 知识层（V2）：skill 词表 + 岗位档案（knowledge/graph）；RPC 失败 → status error，视图显示"知识层未就绪"空态 */
async function pullKnowledge(): Promise<void> {
  if (!engine) return
  try {
    const graph = await engine.knowledgeGraph()
    useAppStore.setState({ knowledge: { ...graph, status: 'ready' } })
  } catch {
    // 引擎旧代码无 knowledge/graph RPC：置 error，不拿空数据冒充"无档案"
    useAppStore.setState((s) => ({ knowledge: { ...s.knowledge, status: 'error' } }))
  }
}

/** 健康投影（契约 v1）：system/health RPC；失败保持 null（页面 mock 兜底，不假死） */
async function pullHealth(): Promise<void> {
  if (!engine) return
  try {
    const report = await engine.health()
    useAppStore.setState({ health: report })
  } catch {
    // offline/旧引擎：保持 null
  }
}

/** 引擎决策链 6 阶段中文名 → UI DecisionStage.id */
const STAGE_ID_BY_NAME: Record<DecisionChain['stages'][number]['stage'], string> = {
  方向探索: 'direction',
  转行评估: 'transfer',
  城市评估: 'city',
  公司筛选: 'company',
  JD分析: 'jd',
  简历定制: 'resume',
}

/** 引擎链投影 → UI 阶段（label 直接用引擎中文名；direction/city 挂在当前阶段） */
function chainToPersonStages(chain: DecisionChain): DecisionStage[] {
  return chain.stages.map((s) => ({
    id: STAGE_ID_BY_NAME[s.stage],
    label: s.stage,
    status: s.status,
    ...(s.direction !== undefined ? { direction: s.direction } : {}),
    ...(s.city !== undefined ? { city: s.city } : {}),
  }))
}

async function pullChains(): Promise<void> {
  if (!engine) return
  try {
    const chains = await engine.listChains()
    const persons = useAppStore.getState().persons
    const next: Record<number, DecisionStage[]> = {}
    for (const chain of chains) {
      const person = persons.find((p) => p.name === chain.person)
      if (person) next[person.id] = chainToPersonStages(chain)
    }
    // 引擎是真相源：整体替换（引擎未建档的人无链 → 消费方按空链处理）
    useAppStore.setState({ personStages: next })
  } catch {
    // offline：保持现有数据
  }
}

async function pullCompanies(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listCompanies()
    useAppStore.setState({ companies: list })
  } catch {
    // offline：保持现有数据
  }
}

async function pullGraph(): Promise<void> {
  if (!engine) return
  try {
    const g = await engine.poolGraph()
    useAppStore.setState({ poolGraph: g })
  } catch {
    // offline：保持 mock
  }
}

export function connectEngine(): void {
  if (engine) return
  engine = createEngineClient()
  engine.on('status', (s) => {
    useAppStore.setState({ engineStatus: s as EngineStatus })
    // R002：断线时进行中的改写任务 → transport_error（事件流不会再送达）
    if (s !== 'connected' && rewriteTaskId !== null) {
      rewriteTaskId = null
      useAppStore.setState((st) => ({
        rewrite: {
          ...st.rewrite,
          status: 'error',
          error: { code: 'transport_error', message: '连接中断，未完成改写', retryable: true },
        },
      }))
    }
    if (s === 'connected') {
      void pullDecisions()
      void pullChains()
      void pullCompanies()
      void pullGraph()
      void pullContexts()
      void pullKnowledge()
      void pullHealth()
    }
  })
  engine.on(EVENTS.decisionsChanged, () => {
    void pullDecisions()
    void pullChains()
    void pullCompanies()
    void pullGraph()
    void pullContexts()
  })
  engine.on(EVENTS.poolChanged, () => void pullGraph())
  engine.onAgentEvent(handleAgentEvent)
  engine.connect()
}
