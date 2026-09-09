import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TaskflowEngine } from '../src/host/engine.ts'

export async function tempDir(prefix = 'taskflow-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/** 轮询等待引擎状态满足条件（fire-and-forget 会话的汇合点）。 */
export async function waitFor(
  probe: () => boolean,
  opts: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 15000
  const interval = opts.interval ?? 5
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout')
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

export function ledgerOf(engine: TaskflowEngine) {
  return engine.getState().ledger
}

export function taskOf(engine: TaskflowEngine, taskId: string) {
  const task = ledgerOf(engine).tasks.find(t => t.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} not found`)
  return task
}

export function subtaskOf(engine: TaskflowEngine, taskId: string, index: number) {
  const sub = taskOf(engine, taskId).subtasks[index]
  if (sub === undefined) throw new Error(`subtask #${index} of ${taskId} not found`)
  return sub
}
