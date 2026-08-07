/**
 * company-watcher：companies/{公司名}.md 目录监听（skill 尽调/档案直写文件 → 引擎感知）。
 * - watchCompanies：add/change/unlink 任一触发 → onChanged()（companies/list 按需重扫，
 *   变更信号由调用方广播）；返回 { close } 供测试/退出。
 *
 * 解析协议在 storage/projection.ts（parseCompanyMarkdown + COMPANY_FIELD_MAP），watcher 只发信号。
 * 注：建档占位公司（createJobFile）与 deleteCompany RPC 原本是仅有的显式广播路径，
 * skill 直写文件不在链路上——本 watcher 补全该缺口（与 decisions/jobs/evidence 等目录对齐）。
 */
import { watch } from 'chokidar'
import type { Workspace } from './workspace.ts'

export function watchCompanies(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.companies, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('change', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
