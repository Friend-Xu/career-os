/**
 * Tool Assembly Layer（Tool Runtime 第二阶段 P0）：工具来源分层 + Stage 装配 + 治理元数据。
 *
 * 设计（用户裁决：MCP 是治理体系的外部扩展槽，不是 Agent 认知层；Agent 永远只看到 Tool）：
 * - ToolSource = 运行时概念——只用于 trace/permission/budget/audit，不进 prompt、不进工具描述。
 * - 装配 = 三级交集：StageSpec.task.tools（声明收窄；缺省 = 不收窄）∩ allowedTools（全局白名单）
 *   ∩ 已注册工具。交集语义只收窄不扩大；ask_user_question 恒可用（对齐旧 CLI 特殊放行），
 *   不进任何白名单、不在 Stage 声明。
 * - 注册不变量：同名工具只允许一个 source 注册（重复注册 = 系统错误，fail fast）；
 *   Stage 声明引擎未知工具名 = 契约错误，fail fast（装配层是注册表事实的唯一入口）；
 *   声明引擎已知但当前未注册（如外部工具未配 key）→ 交集自然排除（fail-safe，
 *   与「无 provider 不注册 WebSearch」同一语义）。
 */
import type { Tool } from 'ai'
import type { ToolSource } from '../../ir/schema.ts'

/** 治理元数据（挂 source 层，不进入 AI SDK tool schema） */
export interface ToolRuntimeMeta {
  source: ToolSource
  /** 数据出境方向（工具固有事实）：external = 执行前必过隐私红线过滤 + 必记审计 trace */
  egress: 'local' | 'external'
  /** 任务级外部调用预算（正整数；会话执行层消费——Engine 决定，Agent 只消费） */
  budget?: number
  /** trace 命名空间（logger.trace 前缀） */
  traceScope: string
  /** 供应商标识（仅审计面：trace 事件携带；如 exa/nbs） */
  provider?: string
}

/** 一个工具来源：一组工具 + 各自的治理元数据（builtin/hosted/mcp/data 各是一个 source） */
export interface ToolSourceDef {
  tools: Record<string, Tool<any, any>>
  meta: Record<string, ToolRuntimeMeta>
}

export interface AssembledTools {
  tools: Record<string, Tool<any, any>>
  meta: Record<string, ToolRuntimeMeta>
}

export interface AssembleOptions {
  sources: ToolSourceDef[]
  /** 全局工具白名单（config.agent.allowedTools） */
  allowedTools: string[]
  /** Stage 级工具声明（StageSpec.task.tools；缺省 = 不收窄，继承全局白名单） */
  stageTools?: string[]
}

/** 引擎已知工具名全集（注册表事实源——Stage 声明校验与未来新增工具都改这里）。
 *  Phase 1 = 文件工具 5 + WebSearch；Phase 2 = Exa MCP（WebResearch/WebFetch）；
 *  Phase 3 = NBS 数据能力（QueryMacroStats）。 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob',
  'WebSearch',
  'WebResearch', 'WebFetch',
  'QueryMacroStats',
]

/** 三级交集装配：Stage 声明 ∩ 全局白名单 ∩ 已注册；同名重复注册 fail fast */
export function assembleTools(opts: AssembleOptions): AssembledTools {
  for (const name of opts.stageTools ?? []) {
    if (!KNOWN_TOOL_NAMES.includes(name)) {
      throw new Error(
        `Stage 声明了引擎未知的工具：${name}（已知：${KNOWN_TOOL_NAMES.join('/')}）——StageSpec 契约错误`,
      )
    }
  }
  const byName = new Map<string, { tool: Tool<any, any>; meta: ToolRuntimeMeta }>()
  for (const src of opts.sources) {
    for (const [name, t] of Object.entries(src.tools)) {
      if (byName.has(name)) {
        throw new Error(`工具注册冲突：${name} 被多个 source 注册（注册不变量被破坏）`)
      }
      const meta = src.meta[name]
      if (meta === undefined) {
        throw new Error(`工具 ${name} 缺少治理元数据（ToolRuntimeMeta 注册不变量被破坏）`)
      }
      byName.set(name, { tool: t, meta })
    }
  }
  const tools: Record<string, Tool<any, any>> = {}
  const meta: Record<string, ToolRuntimeMeta> = {}
  for (const name of opts.allowedTools) {
    if (opts.stageTools !== undefined && !opts.stageTools.includes(name)) continue
    const hit = byName.get(name)
    if (hit === undefined) continue // 已知但未注册（外部工具未启用）→ 交集自然排除，不假装可用
    tools[name] = hit.tool
    meta[name] = hit.meta
  }
  return { tools, meta }
}
