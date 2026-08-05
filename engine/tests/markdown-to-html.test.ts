/**
 * markdown-to-html 单测（M3-2.3b）：受限子集转换——h1/h2/bullet 映射、HTML 转义、
 * claimId 注释原样保留、空行容错、纯函数稳定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToHtml } from '../renderers/markdown-to-html.ts'

test('结构映射：# → h1，## → h2，- → ul/li', () => {
  const html = markdownToHtml('# 我\n\n## 工作经历\n- 负责结构设计\n- 完成样机验证\n')
  assert.ok(html.includes('<h1>我</h1>'))
  assert.ok(html.includes('<h2>工作经历</h2>'))
  assert.ok(html.includes('<ul>'))
  assert.ok(html.includes('<li>负责结构设计</li>'))
  assert.ok(html.includes('<li>完成样机验证</li>'))
  assert.ok(html.includes('</ul>'))
})

test('HTML 转义：bullet 内特殊字符不破结构', () => {
  const html = markdownToHtml('- 负责 <b>机架</b> 设计 & 传动\n')
  assert.ok(html.includes('<li>负责 &lt;b&gt;机架&lt;/b&gt; 设计 &amp; 传动</li>'))
  assert.ok(!html.includes('<b>机架</b>'))
})

test('claimId HTML 注释原样保留（不转义不删除，headless 不显示，产物可追溯）', () => {
  const html = markdownToHtml('- 负责结构设计 <!-- claimId:claim_20260804_00001 -->\n')
  assert.ok(html.includes('<!-- claimId:claim_20260804_00001 -->'))
  assert.ok(html.includes('<li>负责结构设计 <!-- claimId:claim_20260804_00001 --></li>'))
})

test('空行与空白行容错（不产生空结构标签）', () => {
  const html = markdownToHtml('# 我\n\n\n## 技能\n\n- SolidWorks\n\n\n')
  assert.equal((html.match(/<ul>/g) ?? []).length, 1)
  assert.equal((html.match(/<\/ul>/g) ?? []).length, 1)
})

test('纯函数稳定（same input → same output）', () => {
  const md = '# 我\n## 工作经历\n- 负责结构设计\n'
  assert.equal(markdownToHtml(md), markdownToHtml(md))
})
