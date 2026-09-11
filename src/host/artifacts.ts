/**
 * 交付物只读预览（§4.5b/§7.4b，2026-09-11）：验收台在弹窗内直接查看产物本体。
 *
 * 安全口径（§7.4b）：
 * - 白名单：只放行 ledger 里证据 artifacts 声明过的路径（任务级终检证据 + 各子任务证据），
 *   未声明的路径一律拒绝——预览面 = AI 自己举证过的产物集合，不是任意文件读取口；
 * - 只读：仅 open(r)/stat，从不写；
 * - 截断：单次最多读 MAX_ARTIFACT_PREVIEW_BYTES（256KiB），超出标记 truncated；
 * - 二进制拒显：头部 8KiB 含 NUL 即判二进制，content 置空；
 * - 同源信任围栏沿既有 /api/taskflow 形态（loopback/受信主机 + 同源 Origin，§6）。
 *
 * @module dsh-taskflow/host
 */

import { promises as fs } from 'node:fs'
import { MAX_ARTIFACT_PREVIEW_BYTES } from '../protocol/types.ts'
import type { Artifact, ArtifactPreview, Task } from '../protocol/types.ts'

/** 预览失败的可分类错误（HTTP 层映射状态码；message 可安全回给浏览器）。 */
export class ArtifactPreviewError extends Error {
  readonly code: 'invalid-path' | 'not-declared' | 'not-found' | 'not-a-file' | 'io'

  constructor(code: ArtifactPreviewError['code'], message: string) {
    super(message)
    this.name = 'ArtifactPreviewError'
    this.code = code
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 任务内可预览的声明集合：任务级终检证据 + 全部子任务证据的 artifacts（按声明原样精确匹配）。 */
export function declaredArtifactPaths(task: Task): string[] {
  const declared: string[] = []
  const pushAll = (artifacts: Artifact[] | undefined) => {
    for (const item of artifacts ?? []) declared.push(item.path)
  }
  pushAll(task.evidence?.artifacts)
  for (const sub of task.subtasks) pushAll(sub.evidence?.artifacts)
  return declared
}

/** 读取一个「已声明交付物」的文本预览。任何失败都以 {@link ArtifactPreviewError} 抛出。 */
export async function readArtifactPreview(task: Task, requestedPath: string): Promise<ArtifactPreview> {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new ArtifactPreviewError('invalid-path', 'path is required.')
  }
  if (requestedPath.length > 4096) {
    throw new ArtifactPreviewError('invalid-path', 'path exceeds 4096 characters.')
  }
  const path = requestedPath.trim()
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new ArtifactPreviewError('invalid-path', 'path must be an absolute path.')
  }
  if (!declaredArtifactPaths(task).includes(path)) {
    // 刻意不区分「任务不存在路径声明」的细节：预览面只对声明集合开放
    throw new ArtifactPreviewError('not-declared', 'path is not declared in this task\'s evidence artifacts.')
  }

  let size: number
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) {
      throw new ArtifactPreviewError('not-a-file', 'artifact is not a regular file (directory or special file).')
    }
    size = stat.size
  } catch (error) {
    if (error instanceof ArtifactPreviewError) throw error
    throw new ArtifactPreviewError('not-found', `artifact is not readable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const length = Math.min(size, MAX_ARTIFACT_PREVIEW_BYTES)
  let buffer: Buffer
  try {
    const handle = await fs.open(path, 'r')
    try {
      buffer = Buffer.alloc(length)
      if (length > 0) {
        const read = await handle.read(buffer, 0, length, 0)
        buffer = buffer.subarray(0, read.bytesRead)
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new ArtifactPreviewError('io', `artifact read failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 二进制嗅探：头部（≤8KiB）出现 NUL 字节即拒绝文本预览
  const sniffLength = Math.min(buffer.length, 8192)
  const binary = sniffLength > 0 && buffer.subarray(0, sniffLength).includes(0)
  if (binary) {
    return { path, size, truncated: false, binary: true, content: '' }
  }
  // 流式解码避免在截断边界切碎多字节字符
  const decoder = new TextDecoder('utf-8')
  const content = decoder.decode(buffer, { stream: true }) + decoder.decode()
  return { path, size, truncated: size > length, binary: false, content }
}

/** 类型守卫：HTTP 层把未知错误与预览分类错误区分开。 */
export function isArtifactPreviewError(error: unknown): error is ArtifactPreviewError {
  return isObject(error) && error instanceof ArtifactPreviewError
}
