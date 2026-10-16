// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  return {
    Menu: ({ open, anchor, items, onSelect }: {
      open: boolean
      anchor: ReactNode
      items?: ReadonlyArray<{ id: string; label: ReactNode }>
      onSelect?: (id: string) => void
    }) => createElement('div', null,
      anchor,
      open && items?.map(item => createElement('button', {
        key: item.id,
        type: 'button',
        onClick: () => onSelect?.(item.id),
      }, item.label)),
    ),
  }
})

import { installSidebarMoreMenu } from '../src/client/sidebar-more-menu.tsx'

function sidebar(): void {
  document.documentElement.lang = 'zh-CN'
  document.body.innerHTML = `
    <div class="l4U6KG_root">
      <nav class="l4U6KG_panelList" aria-label="全局面板">
        <button type="button" class="l4U6KG_panelRow">插件</button>
      </nav>
    </div>
  `
}

describe('sidebar more menu', () => {
  it('adds 更多 to the panel list and opens 生图 from the submenu', () => {
    sidebar()
    const openImage = vi.fn()
    const restore = installSidebarMoreMenu(openImage)
    try {
      const trigger = document.querySelector<HTMLButtonElement>('[data-dsh-more-menu]')

      expect(trigger?.textContent).toContain('更多')
      expect(trigger?.closest('nav')?.getAttribute('aria-label')).toBe('全局面板')
      expect(document.getElementById('dsh-desktop-sidebar-more-menu-styles')).not.toBeNull()

      act(() => { trigger?.click() })
      const item = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('生图'))
      expect(item).toBeTruthy()
      act(() => { item?.click() })
      expect(openImage).toHaveBeenCalledOnce()
    }
    finally {
      restore()
    }
    expect(document.querySelector('[data-dsh-more-menu]')).toBeNull()
    expect(document.getElementById('dsh-desktop-sidebar-more-menu-styles')).toBeNull()
  })

  it('puts the row back after the shell rebuilds the panel list', async () => {
    sidebar()
    const restore = installSidebarMoreMenu(() => {})
    try {
      const nav = document.querySelector('nav')
      expect(nav?.querySelector('[data-dsh-more-menu]')).not.toBeNull()

      nav?.replaceChildren(document.createElement('button'))
      await Promise.resolve()
      expect(nav?.querySelector('[data-dsh-more-menu]')).not.toBeNull()
    }
    finally {
      restore()
    }
  })
})
