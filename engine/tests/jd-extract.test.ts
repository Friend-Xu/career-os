import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJdJson } from '../runtime/jd-extract.ts'

test('parseJdJson：剥离 markdown 围栏', () => {
  const r = parseJdJson('```json\n{"company": "Company-C 自动化", "title": "机械工程师", "requirements": ["SolidWorks"]}\n```')
  assert.equal(r.company, 'Company-C 自动化')
  assert.equal(r.title, '机械工程师')
  assert.deepEqual(r.requirements, ['SolidWorks'])
})

test('parseJdJson：前后杂质剥离（只取首个 { 到末个 }）', () => {
  const r = parseJdJson('好的，提取结果如下：\n{"company": "天穹智航", "title": "算法工程师"}\n希望有帮助。')
  assert.equal(r.company, '天穹智航')
  assert.equal(r.title, '算法工程师')
})

test('parseJdJson：可选字段缺失降级（location/salary 省略）', () => {
  const r = parseJdJson('{"company": "弘毅机器人", "title": "感知算法工程师", "requirements": []}')
  assert.equal(r.location, undefined)
  assert.equal(r.salary, undefined)
  assert.deepEqual(r.requirements, [])
})

test('parseJdJson：requirements 过滤非字符串与空串', () => {
  const r = parseJdJson('{"company": "", "title": "结构工程师", "requirements": ["SolidWorks", "", 123, " 减速器 "]}')
  assert.equal(r.company, '')
  assert.deepEqual(r.requirements, ['SolidWorks', '减速器'])
})

test('parseJdJson：非 JSON 抛错', () => {
  assert.throws(() => parseJdJson('没有 JSON 的回复文本'), /未提取到 JSON 对象/)
  assert.throws(() => parseJdJson('{"company": 无引号}'), /JSON/)
})
