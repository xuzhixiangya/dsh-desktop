/** User-visible product wording. The data folder and the harness command stay unchanged. */

import { DESKTOP_DISPLAY_NAME, DESKTOP_RELEASE_IDENTITIES } from './product-identity.ts'

const BETA_VISIBLE_NAME = DESKTOP_RELEASE_IDENTITIES.beta.displayName

/** Rewrite leftover DSH product wording in text an employee can read. */
export function brandDesktopText(value: string): string {
  return value
    .replaceAll('DSH Desktop Beta', BETA_VISIBLE_NAME)
    .replaceAll('DSH Desktop', DESKTOP_DISPLAY_NAME)
    .replaceAll('DSH Terminal', `${DESKTOP_DISPLAY_NAME} Terminal`)
    .replaceAll('DSH 终端', `${DESKTOP_DISPLAY_NAME} 终端`)
    .replaceAll('DSH Host', DESKTOP_DISPLAY_NAME)
    .replaceAll('访问这台电脑上的 DSH', `访问这台电脑上的 ${DESKTOP_DISPLAY_NAME}`)
    .replaceAll('access DSH on this computer', `access ${DESKTOP_DISPLAY_NAME} on this computer`)
    .replaceAll('可以通过 DSH 操作', `可以通过 ${DESKTOP_DISPLAY_NAME} 操作`)
    .replaceAll('can use DSH to operate', `can use ${DESKTOP_DISPLAY_NAME} to operate`)
    .replaceAll(' DSH 数据目录', '数据目录')
    .replaceAll('DSH 数据目录', '数据目录')
    .replaceAll(' DSH 数据', '数据')
    .replaceAll('DSH 数据', '数据')
    .replaceAll('DSH data directory', 'data directory')
    .replaceAll('existing DSH data', 'existing data')
    .replaceAll('current DSH data', 'current data')
    .replaceAll('DSH 插件', '插件')
    .replaceAll('桌面版/DSH 版本', '桌面版本')
    .replaceAll('当前 DSH 版本', '当前版本')
    .replaceAll('DSH 版本', '版本')
    .replaceAll('DSH 内核', '内核')
    .replaceAll('this DSH version', 'this version')
    .replaceAll('Desktop/DSH version', 'Desktop version')
    .replaceAll('DSH version', 'version')
    .replaceAll('Desktop/DSH', 'Desktop')
    .replaceAll('different DSH cores', 'different cores')
}

/** Apply {@link brandDesktopText} to strings and to functions that return strings. */
export function brandDesktopCopy<T>(value: T): T {
  return brandValue(value) as T
}

function brandValue(value: unknown): unknown {
  if (typeof value === 'string') return brandDesktopText(value)
  if (typeof value === 'function') {
    return (...args: readonly unknown[]) => brandValue((value as (...inner: readonly unknown[]) => unknown)(...args))
  }
  if (Array.isArray(value)) return value.map(item => brandValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, brandValue(item)]))
  }
  return value
}
