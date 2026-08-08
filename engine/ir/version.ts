import { ProtocolVersion } from './schema.ts'

/** 引擎支持的协议版本（已发布全集：2.0 旧记录无 profile；2.1 profile 必填；2.2 Job Intelligence；2.3 Evidence Inventory；2.8 Decision Payload 结构化；2.9 Application Domain） */
export const SUPPORTED_VERSIONS = ['2.0', '2.1', '2.2', '2.3', '2.8', ProtocolVersion] as const

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED_VERSIONS.includes(version as (typeof SUPPORTED_VERSIONS)[number])
}

/** 版本分派：协议升级时在此注册各版本差异（validator 按版本选解析规则） */
export function protocolVersionOf(record: { protocolVersion?: unknown }): string {
  const v = record.protocolVersion
  return typeof v === 'string' && v.length > 0 ? v : ProtocolVersion
}
