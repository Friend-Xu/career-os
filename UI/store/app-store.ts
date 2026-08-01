import { create } from 'zustand'
import type {
  Application,
  ChatMessage,
  MainWidthMode,
  NavPageId,
  Role,
  Session,
} from '../types'
import {
  APPLICATIONS,
  ROLES,
  SESSIONS,
} from '../data/mock-data'

interface AppState {
  currentRoleId: number;
  currentPage: NavPageId;
  agentPanelOpen: boolean;
  mainWidthMode: MainWidthMode;
  commandPaletteOpen: boolean;
  sessions: Session[];
  currentSessionId: string;
  applications: Application[];
  agentDraft: string;
  agentContextFiles: string[];
  pendingPrompt: string | null;
  roleSwitchDialogOpen: boolean;
  pendingRoleId: number | null;
  infopoolFilter: string;
  companiesFilter: string;
  applicationsFilter: string;
  locateTarget: string | null;

  currentRole: () => Role;
  setPage: (page: NavPageId) => void;
  setRole: (roleId: number) => void;
  confirmRoleSwitch: (keepSession: boolean) => void;
  cancelRoleSwitch: () => void;
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
  setInfopoolFilter: (filter: string) => void;
  setCompaniesFilter: (filter: string) => void;
  setApplicationsFilter: (filter: string) => void;
  setLocateTarget: (target: string | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  currentRoleId: 1,
  currentPage: 'workbench',
  agentPanelOpen: true,
  mainWidthMode: 'narrow',
  commandPaletteOpen: false,
  sessions: SESSIONS,
  currentSessionId: 's-current',
  applications: APPLICATIONS,
  agentDraft: '',
  agentContextFiles: ['profile.md', 'decision.md', 'company DB'],
  pendingPrompt: null,
  roleSwitchDialogOpen: false,
  pendingRoleId: null,
  infopoolFilter: 'all',
  companiesFilter: 'all',
  applicationsFilter: '全部',
  locateTarget: null,

  currentRole: () => {
    const { currentRoleId } = get()
    return ROLES.find((r) => r.id === currentRoleId) ?? ROLES[0]
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

  setInfopoolFilter: (filter) => set({ infopoolFilter: filter }),

  setCompaniesFilter: (filter) => set({ companiesFilter: filter }),

  setApplicationsFilter: (filter) => set({ applicationsFilter: filter }),

  setLocateTarget: (target) => set({ locateTarget: target }),
}))
