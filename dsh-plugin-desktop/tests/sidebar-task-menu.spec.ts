import { describe, expect, it, vi } from 'vitest'
import { installSidebarTaskCopy, installSidebarTaskMenuStyles } from '../src/client/sidebar-task-menu.ts'

function localeRuntime() {
  const dictionaries: Record<string, Record<string, string>> = {
    sidebar: {
      'session.new': '新会话',
      'session.new.label': '新建会话',
      'toggle.open': '打开侧边栏',
    },
    workspace: {
      'section.sessions': '会话',
      'session.new': '新会话',
      'section.workspaces': '工作区',
      'toast.archived': '会话已归档，可',
      'empty.none': '暂无会话',
    },
  }
  class Runtime {
    translate(ns: string, key: string): string {
      return dictionaries[ns]?.[key] ?? key
    }
  }
  const runtime = new Runtime()
  const t = (ns: string, key: string): string => runtime.translate(ns, key)
  return { runtime, t, dictionaries }
}

describe('sidebar task copy', () => {
  it('renames the new-session control and the list heading, and leaves other session copy alone', () => {
    const { runtime, t } = localeRuntime()
    const restore = installSidebarTaskCopy(runtime)

    expect(t('sidebar', 'session.new')).toBe('新建任务')
    expect(t('sidebar', 'session.new.label')).toBe('新建任务')
    expect(t('workspace', 'section.sessions')).toBe('任务')
    expect(t('workspace', 'session.new')).toBe('新任务')
    expect(t('sidebar', 'toggle.open')).toBe('打开侧边栏')
    expect(t('workspace', 'section.workspaces')).toBe('工作区')
    expect(t('workspace', 'toast.archived')).toBe('会话已归档，可')
    expect(t('workspace', 'empty.none')).toBe('暂无会话')

    restore()
    expect(t('sidebar', 'session.new')).toBe('新会话')
    expect(t('workspace', 'section.sessions')).toBe('会话')
    expect(t('workspace', 'session.new')).toBe('新会话')
  })

  it('renames the English strings for the same keys', () => {
    const { runtime, dictionaries } = localeRuntime()
    const sidebar = dictionaries.sidebar
    const workspace = dictionaries.workspace
    if (sidebar === undefined || workspace === undefined) throw new Error('missing locale dictionaries')
    sidebar['session.new'] = 'New Session'
    sidebar['session.new.label'] = 'New session'
    workspace['section.sessions'] = 'Sessions'
    workspace['session.new'] = 'New Session'
    const restore = installSidebarTaskCopy(runtime)

    expect(runtime.translate('sidebar', 'session.new')).toBe('New Task')
    expect(runtime.translate('sidebar', 'session.new.label')).toBe('New task')
    expect(runtime.translate('workspace', 'section.sessions')).toBe('Tasks')
    expect(runtime.translate('workspace', 'session.new')).toBe('New task')

    restore()
    expect(runtime.translate('sidebar', 'session.new')).toBe('New Session')
  })

  it('does nothing when the locale runtime has no translator', () => {
    expect(installSidebarTaskCopy({})()).toBeUndefined()
  })
})

describe('sidebar task menu styles', () => {
  it('rests the new-task control on the same row as the other menus, and leaves the collapsed rail alone', () => {
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {} as Record<string, string>,
      id: '',
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installSidebarTaskMenuStyles()
      expect(style.id).toBe('dsh-desktop-sidebar-task-menu-styles')
      expect(css).toContain('button[class*="_newSession"]')
      expect(css).toContain('min-height: 36px')
      expect(css).toContain('padding: 7px 8px')
      expect(css).toContain('border: none')
      expect(css).toContain('background: transparent')
      expect(css).toContain('justify-content: flex-start')
      expect(css).toContain('gap: 8px')
      expect(css).toContain(':not([class*="_collapsed"])')
      expect(css).toContain('var(--dsw-alias-interactive-bg-hover)')
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
