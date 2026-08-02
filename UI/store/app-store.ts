import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Application,
  ChatMessage,
  Company,
  DecisionRecord,
  DecisionStage,
  MainWidthMode,
  NavPageId,
  Person,
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
import { EVENTS, createEngineClient, type EngineClient, type EngineStatus, type GraphResult } from './engine-client'

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
  decisions: DecisionRecord[];
  companies: Company[];
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
    const { sessions, currentSessionId } = get()
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: now,
    }
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content:
        '已接收你的请求。正在结合 profile、决策链与公司库进行分析…\n\n（演示模式：此处为模拟回复。确认后可写入决策记录。）',
      timestamp: now,
      toolCalls: [
        { name: 'read_profile', status: 'done' },
        { name: 'read_decisions', status: 'done' },
      ],
    }
    set({
      agentDraft: '',
      pendingPrompt: null,
      sessions: sessions.map((s) =>
        s.id === currentSessionId
          ? {
            ...s,
            updatedAt: now,
            messages: [...s.messages, userMsg, assistantMsg],
          }
          : s,
      ),
    })
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
    // 写入决策 → 推进当前人的决策链阶段（完成 → 下一阶段 current）
    const { currentPersonId, personStages } = get()
    const stages = personStages[currentPersonId]
    let nextStages = stages
    if (stages) {
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

async function pullDecisions(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listDecisions()
    useAppStore.setState({ decisions: list })
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
    if (s === 'connected') {
      void pullDecisions()
      void pullGraph()
    }
  })
  engine.on(EVENTS.decisionsChanged, () => {
    void pullDecisions()
    void pullGraph()
  })
  engine.on(EVENTS.poolChanged, () => void pullGraph())
  engine.connect()
}
