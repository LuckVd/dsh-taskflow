/**
 * 宿主运行时原语的最小内联等价物。
 *
 * 插件包对 @deepseek-ai/* 只允许类型导入（类型擦除后零运行时依赖）：运行时
 * 导入会解析到本仓 devDep 副本，与宿主实际运行版本漂移，且 link 安装形态下
 * 副本自身的依赖树并不完整。此文件行为对齐宿主 0.1.2-rc.1 源码；若宿主
 * 升级改变语义，以真机复验为准。
 *
 * @module dsh-taskflow/host
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

// —— SessionId（dsh-session 的品牌字符串；运行时即普通字符串） ——

declare const sessionBrand: unique symbol

/** dsh 会话 id 品牌类型。 */
export type SessionId = string & { readonly [sessionBrand]: true }

/** 把原始字符串标记为会话 id（同 dsh-session 的 SessionId）。 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

// —— createUserMessage（dsh-llm 的冻结用户消息构造） ——

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return Object.freeze(value)
}

/** 构造一条带稳定身份的冻结 user 消息（同 dsh-llm 的 createUserMessage）。 */
export function createUserMessage(input: {
  content: ReadonlyArray<{ type: string; text?: string }>
  source: { kind: 'plugin'; plugin: string }
}): Readonly<{ id: string; role: 'user'; content: ReadonlyArray<{ type: string; text?: string }>; source: { kind: 'plugin'; plugin: string } }> {
  return deepFreeze({ ...input, role: 'user' as const, id: randomUUID() })
}

// —— dshHomePath（dsh-home-paths 的家目录拼接） ——

/** $DSH_HOME 下的子路径（环境变量缺省回落 ~/.dsh）。 */
export function dshHomePath(...segments: string[]): string {
  const env = process.env.DSH_HOME
  const home = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
  return join(home, ...segments)
}
