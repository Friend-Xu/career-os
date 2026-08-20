import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_TASK_TYPES,
  CONTEXT_REF_TYPES,
  OUTPUT_TARGETS,
} from '../ir/agent-task.ts'

/**
 * Agent Task Contract IR（ADR-020 Commit A：类型与白名单常量进入系统）。
 * 断言：Registry 12 型 / contextRef 4 型 / Output Boundary 3 型（禁 application/company_assessment）。
 */

test('Task Type Registry：12 型冻结枚举（契约 §3 语义表）', () => {
  assert.equal(AGENT_TASK_TYPES.length, 12)
  assert.deepEqual(AGENT_TASK_TYPES, [
    'job_analysis',
    'company_research',
    'decision_reassessment',
    'decision_review',
    'resume_generation',
    'resume_adaptation',
    'interview_preparation',
    'explanation',
    'career_direction',
    'company_screening',
    'job_lead_search',
    'salary_benchmark_search',
  ])
})

test('ContextReference：仅领域对象引用 4 型（禁 file/markdown/workspace_path）', () => {
  assert.deepEqual(CONTEXT_REF_TYPES, ['job', 'company', 'resume', 'decision'])
})

test('Output Boundary：decision/artifact/none，禁止 application/company_assessment', () => {
  assert.deepEqual(OUTPUT_TARGETS, ['decision', 'artifact', 'none'])
  assert.ok(!OUTPUT_TARGETS.includes('application' as never), 'application 禁止（ADR-019 用户行动事实）')
  assert.ok(!OUTPUT_TARGETS.includes('company_assessment' as never), 'company_assessment 禁止（ADR-018 projection）')
})
