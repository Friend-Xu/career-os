import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { createStructuredExtractor, extractJsonObject } from '../agent/capability/structured-extractor.ts'

const schema = z.object({ company: z.string(), title: z.string(), requirements: z.array(z.string()) })

/** 按调用次序返回文本/抛错的假模型（generateText 只调 doGenerate） */
function fakeModel(responses: (string | Error)[]): { model: LanguageModel; calls: () => number } {
  let i = 0
  const calls = () => i
  const model = {
    specificationVersion: 'v2',
    modelId: 'fake-model',
    provider: 'fake',
    doGenerate: async () => {
      const r = responses[Math.min(i++, responses.length - 1)]
      if (r instanceof Error) throw r
      return {
        content: [{ type: 'text', text: r }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      }
    },
  } as unknown as LanguageModel
  return { model, calls }
}

test('extractJsonObject：剥离 markdown 围栏与前后杂质', () => {
  const v = extractJsonObject('好的，结果如下：\n```json\n{"a": 1}\n```\n希望有帮助。')
  assert.deepEqual(v, { a: 1 })
})

test('extractJsonObject：非 JSON 抛错（重试循环消费）', () => {
  assert.throws(() => extractJsonObject('没有 JSON'), /未提取到 JSON 对象/)
})

test('extract：纯 JSON 成功 + zod 校验通过', async () => {
  const { model } = fakeModel(['{"company":"A公司","title":"机械工程师","requirements":["SolidWorks"]}'])
  const out = await createStructuredExtractor(model).extract({ text: 'jd' }, schema)
  assert.deepEqual(out, { company: 'A公司', title: '机械工程师', requirements: ['SolidWorks'] })
})

test('extract：模型方言（围栏+叙述杂质）→ 解析成功', async () => {
  const { model } = fakeModel(['这是提取结果：\n```json\n{"company":"B公司","title":"结构工程师","requirements":[]}\n```\n请查收。'])
  const out = await createStructuredExtractor(model).extract({ text: 'jd' }, schema)
  assert.equal(out.company, 'B公司')
})

test('extract：schema 不符 → 带错误提示重试 → 第二次成功', async () => {
  const { model, calls } = fakeModel([
    '{"company":"C公司"}', // 缺 title → zod 拒绝
    '{"company":"C公司","title":"算法工程师","requirements":["Python"]}', // 合规
  ])
  const out = await createStructuredExtractor(model).extract({ text: 'jd', maxRetries: 3 }, schema)
  assert.equal(out.title, '算法工程师')
  assert.equal(calls(), 2, '第一次失败后应重试一次')
})

test('extract：重试耗尽 → No object generated（诚实失败）', async () => {
  const { model } = fakeModel(['这不是 JSON', '{"company":"D公司"}', '再来一段废话'])
  await assert.rejects(
    () => createStructuredExtractor(model).extract({ text: 'jd', maxRetries: 2 }, schema),
    /No object generated/,
  )
})
