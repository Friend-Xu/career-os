/**
 * Execution 事件日志持久化适配器（Phase 3——Registry 的 Persistence Adapter）。
 *
 * - 形态：append-only JSONL（runtime/state/executions.jsonl，引擎实例级，不随 workspace 切换）。
 * - 语义：Execution Runtime 历史是**不可重建的 SoT**（区别于 Domain Projection 的 SQLite——
 *   后者是 MD 真相源的派生、可 drop 重建；前者只能由本日志重建）。
 * - 硬要求（用户裁定，Phase 3 Contract）：
 *   ① 事件自洽：status_changed 携带该刻快照（resultRefs）——replay 不需要其他文件补状态；
 *   ② replay 幂等容错：非末行 malformed → corruption warning（不静默吞历史）；末行 truncated → 丢弃（崩溃容忍）；
 *   ③ 事件唯一 ID（eventId——审计/去重/诊断）。
 * - 分层：ExecutionRegistry 是 abstraction，本类是 Persistence Adapter——
 *   未来需要（百万级历史/时间范围查询/多进程 writer/远程 service）时换 SQLite/DuckDB/Postgres，
 *   不污染 ADR-034 的 Runtime API。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../logger.ts'
import type { ExecutionEvent } from '../ir/execution.ts'

export class ExecutionEventLog {
  private entries: ExecutionEvent[] = []
  private filePath: string
  private logger: Logger

  /** 构造即加载（启动 replay 输入；文件不存在 = 全新日志） */
  constructor(opts: { filePath: string; logger: Logger }) {
    this.filePath = opts.filePath
    this.logger = opts.logger
    this.load()
  }

  /** 追加（同步写一行 JSON；append-only journal——崩溃时末行截断可容忍） */
  append(event: ExecutionEvent): void {
    this.entries.push(event)
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8')
  }

  /** 全部事件（启动 replay 输入；内存镜像 = 与文件一致的 image） */
  all(): ExecutionEvent[] {
    return [...this.entries]
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    const text = readFileSync(this.filePath, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') continue
      try {
        this.entries.push(JSON.parse(line) as ExecutionEvent)
      } catch {
        if (i === lines.length - 1) {
          // 末行截断 = 崩溃中断的常态（append 原子性边界）——丢弃并显式记录
          this.logger.warn(`executions.jsonl 末行不完整（可能为崩溃截断）——已忽略（${this.filePath}）`)
        } else {
          // 非末行损坏 = 真实数据损坏——不静默（丢历史不可接受）
          this.logger.warn(`executions.jsonl 第 ${i + 1} 行损坏（非法 JSON）——已跳过，请检查 ${this.filePath}`)
        }
      }
    }
    if (this.entries.length > 0) {
      this.logger.info(`executions.jsonl replay：已加载 ${this.entries.length} 条事件（${this.filePath}）`)
    }
  }
}
