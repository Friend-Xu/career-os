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
  Role,
  Session,
  StageStatus,
} from '../types'
import {
  APPLICATIONS,
  COMPANIES,
  DECISIONS,
  ROLES,
  SESSIONS,
  STAGES,
} from '../data/mock-data'

/** 按角色构造决策链进度：角色 1 走完三步（演示主线），其余角色差异化。 */
function makeRoleStages(statusMap: Record<string, StageStatus>): DecisionStage[] {
  return STAGES.map((s) => ({
    ...s,
    status: statusMap[s.id] ?? 'pending',
    completedAt: s.status === 'completed' && statusMap[s.id] === 'completed' ? s.completedAt : undefined,
  }))
}

function buildInitialRoleStages(): Record<number, DecisionStage[]> {
  return {
    1: makeRoleStages({
      direction: 'completed',
      transfer: 'completed',
      city: 'completed',
      company: 'current',
    }),
    2: makeRoleStages({ direction: 'completed', transfer: 'current' }),
    3: makeRoleStages({ direction: 'current' }),
  }
}

function freshRoleStages(): DecisionStage[] {
  return makeRoleStages({ direction: 'current' })
}

interface AppState {
  currentRoleId: number;
  currentPage: NavPageId;
  agentPanelOpen: boolean;
  mainWidthMode: MainWidthMode;
  commandPaletteOpen: boolean;
  sessions: Session[];
  currentSessionId: string;
  applications: Application[];
  decisions: DecisionRecord[];
  companies: Company[];
  roles: Role[];
  roleStages: Record<number, DecisionStage[]>;
  agentDraft: string;
  agentContextFiles: string[];
  pendingPrompt: string | null;
  roleSwitchDialogOpen: boolean;
  pendingRoleId: number | null;
  roleCreateDialogOpen: boolean;
  infopoolFilter: string;
  companiesFilter: string;
  applicationsFilter: string;
  locateTarget: string | null;

  currentRole: () => Role;
  setPage: (page: NavPageId) => void;
  setRole: (roleId: number) => void;
  confirmRoleSwitch: (keepSession: boolean) => void;
  cancelRoleSwitch: () => void;
  setRoleCreateDialogOpen: (open: boolean) => void;
  addRole: (role: Omit<Role, 'id'>) => number;
  archiveRole: (roleId: number) => void;
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
      currentRoleId: 1,
      currentPage: 'workbench',
      agentPanelOpen: true,
      mainWidthMode: 'narrow',
      commandPaletteOpen: false,
      sessions: SESSIONS,
      currentSessionId: 's-current',
      applications: APPLICATIONS,
      decisions: DECISIONS,
      companies: COMPANIES,
      roles: ROLES,
      roleStages: buildInitialRoleStages(),
      agentDraft: '',
      agentContextFiles: ['profile.md', 'decision.md', 'company DB'],
      pendingPrompt: null,
      roleSwitchDialogOpen: false,
      pendingRoleId: null,
      roleCreateDialogOpen: false,
      infopoolFilter: 'all',
      companiesFilter: 'all',
      applicationsFilter: '全部',
      locateTarget: null,

  currentRole: () => {
    const { currentRoleId, roles } = get()
    return roles.find((r) => r.id === currentRoleId) ?? roles[0]
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

  setRole: (roleId) => {
    const { currentRoleId, sessions, currentSessionId } = get()
    if (roleId === currentRoleId) return
    const session = sessions.find((s) => s.id === currentSessionId)
    if (session && session.messages.length > 0) {
      set({ roleSwitchDialogOpen: true, pendingRoleId: roleId })
      return
    }
    set({ currentRoleId: roleId })
  },

  confirmRoleSwitch: (keepSession) => {
    const { pendingRoleId, currentSessionId, sessions } = get()
    if (pendingRoleId == null) return
    if (!keepSession) {
      set({
        currentRoleId: pendingRoleId,
        pendingRoleId: null,
        roleSwitchDialogOpen: false,
        sessions: sessions.map((s) =>
          s.id === currentSessionId ? { ...s, messages: [] } : s,
        ),
      })
    } else {
      set({
        currentRoleId: pendingRoleId,
        pendingRoleId: null,
        roleSwitchDialogOpen: false,
      })
    }
  },

  cancelRoleSwitch: () => {
    set({ roleSwitchDialogOpen: false, pendingRoleId: null })
  },

  setRoleCreateDialogOpen: (open) => set({ roleCreateDialogOpen: open }),

  addRole: (role) => {
    const nextId = get().roles.reduce((m, r) => Math.max(m, r.id), 0) + 1
    const full: Role = { ...role, id: nextId }
    set((state) => ({
      roles: [...state.roles, full],
      roleStages: { ...state.roleStages, [nextId]: freshRoleStages() },
      currentRoleId: nextId,
    }))
    return nextId
  },

  archiveRole: (roleId) => {
    if (roleId === get().currentRoleId) return
    set((state) => ({
      roles: state.roles.map((r) =>
        r.id === roleId ? { ...r, archived: true } : r,
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
      roleId: get().currentRoleId,
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
    // 写入决策 → 推进当前角色的决策链阶段（完成 → 下一阶段 current）
    const { currentRoleId, roleStages } = get()
    const stages = roleStages[currentRoleId]
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
      roleStages: { ...roleStages, [currentRoleId]: nextStages },
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
      partialize: (s) => ({
        currentRoleId: s.currentRoleId,
        currentPage: s.currentPage,
        agentPanelOpen: s.agentPanelOpen,
        mainWidthMode: s.mainWidthMode,
        applications: s.applications,
        decisions: s.decisions,
        companies: s.companies,
        roles: s.roles,
        roleStages: s.roleStages,
        infopoolFilter: s.infopoolFilter,
        companiesFilter: s.companiesFilter,
        applicationsFilter: s.applicationsFilter,
      }),
    },
  ),
)
