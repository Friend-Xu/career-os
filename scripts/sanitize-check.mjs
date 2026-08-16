// Data Source Boundary 最后防线：扫描 git 跟踪文件，真实实体名 / PII 命中即失败（退出码 1）。
// 架构层（engine/ skills/ docs/）不得承载真实职业数据——真实数据只存在于 workspace/ 与本地
// career-os.config.json（均 gitignored）。测试/契约/示例必须使用 Synthetic Fixture（与 workspace
// 实体零语义关联的独立构造数据）。
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// 真实实体禁止清单（用户真实背调公司 / 学校 / 项目代号 / 技能画像 / 偏好短语；新增真实数据时同步补充）
// 注意：本扫描只覆盖文本文件——PNG 等二进制（截图）无法命中；截图策略见 AGENTS.md 数据边界
const REAL_ENTITIES = ['心玮', '博流', '澜山', '新拓', '嘉树', '特尔玛', '东华大学', 'C2900', '沪苏通勤圈', '南京工业大学', '南工大', '转动惯量及电机扭矩校核', '装配干涉处理与故障诊断', '方案设计与样机调试', '敏捷医疗', '科塞尔医疗', '同心医疗', '康多机器人', '华森医疗', '心擎医疗', '铸正机器人', '景昱医疗', '无双医疗']

const PHONE_RE = /\b1[3-9]\d{9}\b/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const ID_RE = /\b\d{17}[\dXx]\b/
// mock 占位邮箱白名单（显式占位格式，非真实联系信息）
const EMAIL_ALLOW = /me@email\.com|family@email\.com|@example\.(com|org)/

// core.quotepath=false：git 默认对非 ASCII 文件名做八进制转义，readFileSync 将 ENOENT 并被下方
// catch 静默跳过——中文文件名（方向画像卡/案例/截图）永不入扫。禁用转义拿到真实路径。
const files = execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' }).split('\n').map((f) => f.trim()).filter(Boolean)
const hits = []
for (const f of files) {
  // 脚本自身包含禁止清单定义（有意为之的防御代码），跳过自扫描
  if (f === 'scripts/sanitize-check.mjs') continue
  if (f.startsWith('workspace/')) continue
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const e of REAL_ENTITIES) {
    if (text.includes(e)) hits.push(`${f}: 真实实体「${e}」`)
  }
  for (const m of text.match(PHONE_RE) ?? []) hits.push(`${f}: 疑似手机号「${m}」`)
  for (const m of text.match(ID_RE) ?? []) hits.push(`${f}: 疑似身份证「${m}」`)
  for (const m of text.match(EMAIL_RE) ?? []) {
    if (!EMAIL_ALLOW.test(m)) hits.push(`${f}: 疑似邮箱「${m}」`)
  }
}

if (hits.length > 0) {
  console.error('❌ sanitize 失败：架构文件含真实数据（Data Source Boundary 被突破）：')
  for (const h of hits) console.error('  ' + h)
  console.error('修复：真实数据只写 workspace/ 或本地 career-os.config.json（gitignored）；架构文件用 Synthetic Fixture（与真实实体零语义关联）。')
  process.exit(1)
}
console.log('✓ sanitize：无真实实体 / PII（Data Source Boundary 干净）')
