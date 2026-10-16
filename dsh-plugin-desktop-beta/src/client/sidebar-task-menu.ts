/**
 * Sidebar wording and the new-task row.
 *
 * Upstream draws "新会话" as a centered elevated pill and titles the list
 * "会话". Desktop says "新建任务" / "任务", and rests that control on the same
 * row as the other sidebar menus (transparent, left aligned, 36px).
 *
 * Locale namespaces cannot be registered twice, so the copy is applied when
 * those keys are translated. The row styles key off the CSS-module local name
 * (`*_newSession`), which stays put when the content hash changes. Collapsed
 * rail geometry is upstream's and is left alone.
 */

const STYLE_ID = 'dsh-desktop-sidebar-task-menu-styles'

const CSS = `
body [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"] {
  box-sizing: border-box;
  height: auto;
  min-height: 36px;
  margin: 0 2px 4px;
  padding: 7px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 22px;
  text-align: left;
  justify-content: flex-start;
  align-items: center;
  gap: 0;
}
body [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
html[data-platform="darwin"] body [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"],
html[data-platform="darwin"] body[data-ds-dark-theme] [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"] {
  background: transparent;
  border-color: transparent;
}
html[data-platform="darwin"] body [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"]:hover,
html[data-platform="darwin"] body[data-ds-dark-theme] [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
body [class*="_root"]:not([class*="_collapsed"]) [class*="_newSessionContent"] {
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  width: auto;
}
body [class*="_root"]:not([class*="_collapsed"]) button[class*="_newSession"] svg {
  width: 16px;
  height: 16px;
  flex: none;
}
`

type Translate = (this: unknown, ns: string, key: string, params?: Record<string, unknown>) => string

interface LocalePrototype {
  translate?: Translate
}

/** Upstream text for the two sidebar keys and the session-list heading. */
const REPLACEMENTS: Record<string, string> = {
  'sidebar\0session.new\0新会话': '新建任务',
  'sidebar\0session.new\0New Session': 'New Task',
  'sidebar\0session.new.label\0新建会话': '新建任务',
  'sidebar\0session.new.label\0New session': 'New task',
  'workspace\0section.sessions\0会话': '任务',
  'workspace\0section.sessions\0Sessions': 'Tasks',
  // A blank row has no title yet. Upstream shows that placeholder as 新会话.
  'workspace\0session.new\0新会话': '新任务',
  'workspace\0session.new\0New Session': 'New task',
}

/** Install the menu-row sheet once; tolerate headless Client boot. */
export function installSidebarTaskMenuStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/sidebar-task-menu'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Point the new-session control and the session-list heading at 任务.
 * @param locale - active locale runtime.
 * @returns disposer restoring the previous translator.
 */
export function installSidebarTaskCopy(locale: object): () => void {
  const proto = Object.getPrototypeOf(locale) as LocalePrototype | null
  const original = proto?.translate
  if (proto === null || typeof original !== 'function') return () => {}
  const patched: Translate = function (ns, key, params) {
    const text = original.call(this, ns, key, params)
    return REPLACEMENTS[`${ns}\0${key}\0${text}`] ?? text
  }
  proto.translate = patched
  return () => {
    if (proto.translate === patched) proto.translate = original
  }
}
