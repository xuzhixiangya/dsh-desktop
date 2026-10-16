/**
 * Sidebar "更多" row.
 *
 * The shell owns the global panel rows and gives them no nested menu. This
 * row sits in that same list and opens the shared menu card to the right,
 * the way a "更多" entry reveals its children. "生图" hands the center column
 * back to the conversation and opens the installed image studio.
 */

import { useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

const STYLE_ID = 'dsh-desktop-sidebar-more-menu-styles'
const HOST_ATTR = 'data-dsh-more-host'
const IMAGE_TAB_SELECTOR = '[data-dsh-imagegen-tab="image"]'

const CSS = `
nav .dsh-more-menu-anchor {
  display: flex;
  min-width: 0;
  margin: 0 2px;
}
button[data-dsh-more-menu] {
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  margin: 0;
  padding: 7px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
button[data-dsh-more-menu]:hover,
button[data-dsh-more-menu][aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
button[data-dsh-more-menu] svg {
  width: 16px;
  height: 16px;
  flex: none;
}
[data-dsh-more-label] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-more-chevron] {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  display: inline-flex;
}
[class*="_collapsed"] nav .dsh-more-menu-anchor {
  width: 36px;
  margin: 0;
}
[class*="_collapsed"] button[data-dsh-more-menu] {
  width: 36px;
  height: 36px;
  min-height: 36px;
  padding: 0;
  justify-content: center;
}
[class*="_collapsed"] [data-dsh-more-label],
[class*="_collapsed"] [data-dsh-more-chevron] {
  display: none;
}
/* The studio's own Session/Image tabs stay mounted so 生图 can open it,
   but 更多 is the only visible entry. */
[data-dsh-imagegen-session-tabs] {
  display: none !important;
}
html[data-dsh-imagegen-active] [data-dsh-imagegen-sidebar-root] nav[class*="panelList"] {
  display: flex !important;
}
`

function MoreIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="2.2" y="2.2" width="4.2" height="4.2" rx="1" />
      <rect x="9.6" y="2.2" width="4.2" height="4.2" rx="1" />
      <rect x="2.2" y="9.6" width="4.2" height="4.2" rx="1" />
      <rect x="9.6" y="9.6" width="4.2" height="4.2" rx="1" />
    </svg>
  )
}

function ImageIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="5.6" cy="5.8" r="1" />
      <path d="M2.5 12.5l3.6-3.4 2.4 2.2 3-3 2 2.4" />
    </svg>
  )
}

function Chevron(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

interface MenuCopy {
  more: string
  image: string
}

function menuCopy(): MenuCopy {
  const lang = `${document.documentElement.lang || navigator.language || 'zh'}`.toLowerCase()
  if (lang.startsWith('en')) return { more: 'More', image: 'Image' }
  return { more: '更多', image: '生图' }
}

/** Open the image studio's own sidebar tab, when that plugin has mounted it. */
export function openImageStudio(): void {
  document.querySelector<HTMLButtonElement>(IMAGE_TAB_SELECTOR)?.click()
}

function MoreMenu({ onOpenImage }: { onOpenImage: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const copy = menuCopy()
  return (
    <Menu
      open={open}
      side="right"
      align="start"
      portal
      autoFocus
      className="dsh-more-menu-anchor"
      getAnchorRect={() => buttonRef.current?.getBoundingClientRect() ?? null}
      onClose={() => { setOpen(false) }}
      onSelect={id => {
        setOpen(false)
        if (id === 'image') onOpenImage()
      }}
      anchor={(
        <button
          ref={buttonRef}
          type="button"
          data-dsh-more-menu=""
          aria-label={copy.more}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <MoreIcon />
          <span data-dsh-more-label="">{copy.more}</span>
          <span data-dsh-more-chevron=""><Chevron /></span>
        </button>
      )}
      items={[{ id: 'image', label: copy.image, icon: <ImageIcon /> }]}
    />
  )
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/sidebar-more-menu'
  style.textContent = CSS
  document.head.appendChild(style)
}

function panelNav(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>('nav[class*="_panelList"]') ?? undefined
}

/**
 * Keep a "更多" row at the end of the shell's panel list.
 * React rebuilds that list, so a removed host is mounted again.
 * @param onOpenImage - called when 生图 is chosen.
 * @returns disposer.
 */
export function installSidebarMoreMenu(onOpenImage: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  installStyles()
  const roots = new Map<HTMLElement, Root>()

  const mount = (nav: HTMLElement): void => {
    if (nav.querySelector(`[${HOST_ATTR}]`) !== null) return
    const host = document.createElement('div')
    host.setAttribute(HOST_ATTR, '')
    nav.appendChild(host)
    const root = createRoot(host)
    roots.set(host, root)
    flushSync(() => { root.render(<MoreMenu onOpenImage={onOpenImage} />) })
  }

  const sync = (): void => {
    for (const [host, root] of [...roots]) {
      if (host.isConnected) continue
      root.unmount()
      roots.delete(host)
    }
    const nav = panelNav()
    if (nav !== undefined) mount(nav)
  }

  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true })
  sync()

  const leaveStudio = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const nav = target?.closest('nav[class*="panelList"]')
    if (nav === null || nav === undefined) return
    if (target?.closest('[data-dsh-more-host]') !== null) return
    document.querySelector<HTMLButtonElement>('[data-dsh-imagegen-tab="session"]')?.click()
  }
  document.addEventListener('click', leaveStudio, true)

  return () => {
    document.removeEventListener('click', leaveStudio, true)
    observer.disconnect()
    for (const root of roots.values()) root.unmount()
    roots.clear()
    document.getElementById(STYLE_ID)?.remove()
  }
}
