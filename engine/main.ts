/**
 * 引擎启动编排（骨架）：config → workspace → logger 串联。
 * 错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。
 * 骨架阶段无服务器监听（服务随第 3 步桥接接入）；验收 = 初始化成功 + 摘要打印。
 */
import { ConfigError, describeConfig, loadConfig } from './config.ts'
import { initWorkspace, WorkspaceError } from './storage/workspace.ts'
import { createLogger } from './logger.ts'
import { ProtocolVersion } from './ir/schema.ts'

function main(args: string[]): void {
  try {
    const { config, firstRun, configPath } = loadConfig(args)
    const logger = createLogger({ logsDir: config.paths.logs, level: 'info' })

    if (firstRun) {
      logger.info(`已生成配置文件 ${configPath}（内置默认值，可直接编辑），字段说明：`)
      for (const line of describeConfig(config)) logger.info(`  ${line}`)
    } else {
      logger.info(`已加载配置 ${configPath}`)
    }

    const ws = initWorkspace(config.paths.workspace)
    logger.info(`信息池工作区就绪：${ws.paths.root}`)
    logger.info(`协议版本：career-os v${ProtocolVersion}（metadata/protocol.json，引擎单方维护）`)
    logger.info(`引擎骨架启动成功（端口 ${config.server.port}，服务监听随第 3 步桥接接入）`)
  } catch (err) {
    if (err instanceof ConfigError || err instanceof WorkspaceError) {
      console.error(err.message)
    } else {
      console.error(`❌ 未知错误：${err instanceof Error ? err.message : String(err)}`)
    }
    process.exitCode = 1
  }
}

main(process.argv.slice(2))
