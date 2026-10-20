/** Sidebar account menu. This entry shadows the upstream DeepSeek launcher. */

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  IconEllipsisOutlineMedium,
  IconSettingsOutlineMedium,
  IconUserOutlineMedium,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { YxLoginPanel } from './YxLoginPanel.tsx'
import type { YxLoginLocaleKey } from './yx-login-locales.ts'
import {
  applyYxLogin,
  clearYxApiKey,
  confirmYxAccount,
  rememberedYxAccount,
  subscribeYxAccount,
  yxAccountEpoch,
  type YxSettingsRemote,
} from './yx-provider.ts'

/** Below the upstream account launcher (priority 0), so the sidebar renders this one. */
export const YX_ACCOUNT_LAUNCHER_PRIORITY = -1

export interface YxAccountLauncherInjected {
  readonly remote: YxSettingsRemote
}

export type YxAccountLauncherProps =
  PropsRuntime<'settings.launcher'>
  & PropsLocale<'yx.login'>
  & InjectFace<YxAccountLauncherInjected>

export function YxAccountLauncher(props: YxAccountLauncherProps): ReactNode {
  return <YxAccountMenu {...props} />
}

export function YxAccountMenu({
  wide, openSettings, settingsShortcut, t, remote,
}: Pick<YxAccountLauncherProps, 'wide' | 'openSettings' | 'settingsShortcut' | 't' | 'remote'>): ReactNode {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [account, setAccount] = useState<string | null>(() => rememberedYxAccount())
  useEffect(() => subscribeYxAccount(setAccount), [])
  useEffect(() => {
    let cancelled = false
    const epoch = yxAccountEpoch()
    void confirmYxAccount(remote).then(name => {
      if (!cancelled && yxAccountEpoch() === epoch) setAccount(name)
    })
    return () => { cancelled = true }
  }, [remote])
  const signedIn = account !== null
  const label = account ?? ''
  const choose = (id: string) => {
    setOpen(false)
    if (id === 'settings') openSettings()
    else if (id === 'signin') setDialog(true)
    else if (id === 'signout') setSignOutOpen(true)
  }
  return <div className="dshYxLauncher">
    <Menu
      open={open}
      side="top"
      portal
      autoFocus
      className="dshYxLauncherAnchor"
      anchor={<button type="button" className="dshYxLauncherTrigger" data-collapsed={wide ? undefined : 'true'} data-signed-out={signedIn ? undefined : 'true'} aria-label={t('menu')} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {signedIn
          ? <span className="dshYxLauncherAvatar"><IconUserOutlineMedium size={16} /></span>
          : <IconEllipsisOutlineMedium size={14} />}
        {wide && <span className="dshYxLauncherLabel">{signedIn ? label : t('more')}</span>}
      </button>}
      items={[
        {
          id: 'settings',
          label: t('settings'),
          icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }),
        },
        signedIn
          ? { id: 'signout', label: t('signOut'), icon: <YxLogoutIcon /> }
          : { id: 'signin', label: t('menuSignIn'), icon: <IconUserOutlineMedium size={16} /> },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={choose}
    />
    {dialog && typeof document !== 'undefined' && createPortal(
      <YxLoginDialog t={t} remote={remote} onAccount={setAccount} onClose={() => { setDialog(false) }} />,
      document.body,
    )}
    {signOutOpen && typeof document !== 'undefined' && createPortal(
      <YxSignOutDialog t={t} remote={remote} onSignedOut={() => { setAccount(null); setSignOutOpen(false) }} onClose={() => { setSignOutOpen(false) }} />,
      document.body,
    )}
  </div>
}

export function YxLoginDialog({ t, remote, onAccount, onClose }: {
  t: (key: YxLoginLocaleKey) => string
  remote: YxSettingsRemote
  onAccount?: (username: string | null) => void
  onClose: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return <div className="dshDesktopSettingsDialogBackdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="dshDesktopSettingsDialog dshYxLoginDialog" role="dialog" aria-modal="true" aria-label={t('title')} onClick={event => { event.stopPropagation() }}>
      <div className="dshYxLoginDialogBar">
        <Button type="button" variant="outline" onClick={onClose}>{t('close')}</Button>
      </div>
      <YxLoginPanel t={t} save={async result => {
        const outcome = await applyYxLogin(remote, result)
        onAccount?.(outcome === null ? null : result.username)
        return outcome
      }} onFinished={onClose} />
    </div>
  </div>
}

function YxSignOutDialog({ t, remote, onSignedOut, onClose }: {
  t: (key: YxLoginLocaleKey) => string
  remote: YxSettingsRemote
  onSignedOut: () => void
  onClose: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [busy, onClose])
  const signOut = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await clearYxApiKey(remote)
      onSignedOut()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  return <div className="dshDesktopSettingsDialogBackdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="dshDesktopSettingsDialog dshYxLoginDialog" role="dialog" aria-modal="true" aria-label={t('signOutTitle')} onClick={event => { event.stopPropagation() }}>
      <div className="dshYxSignOut">
        <h2>{t('signOutTitle')}</h2>
        <p>{t('signOutDescription')}</p>
        {error !== '' && <p role="alert">{error}</p>}
        <div className="dshYxLoginActions">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => { void signOut() }}>{t('signOut')}</Button>
        </div>
      </div>
    </div>
  </div>
}

function YxLogoutIcon(): ReactNode {
  return <span style={{ width: 16, height: 16, position: 'relative' }} aria-hidden="true"><svg style={{ position: 'absolute', left: 1, top: 1 }} width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M4 1.4c-.62 0-1.04 0-1.36.03-.31.02-.47.08-.57.13a1.4 1.4 0 0 0-.5.5c-.06.11-.11.26-.14.57C1.4 2.96 1.4 3.38 1.4 4v5.58c0 .62 0 1.04.03 1.36.03.31.08.47.14.57.12.21.29.38.5.5.1.06.26.11.57.14.32.03.74.03 1.36.03V13.57c-.59 0-1.08 0-1.48-.03-.41-.04-.78-.12-1.13-.31a2.8 2.8 0 0 1-1.04-1.05 2.7 2.7 0 0 1-.31-1.13C0 10.66 0 10.17 0 9.58V4c0-.59 0-1.08.03-1.48.04-.41.11-.78.31-1.13A2.8 2.8 0 0 1 1.38.34c.35-.2.72-.27 1.13-.31C2.91 0 3.4 0 4 0v1.4Z" fill="currentColor"/>
    <path d="M13.64 6.52c.03.18.03.36 0 .53-.05.33-.21.59-.39.81-.17.21-.4.44-.65.7L9.31 11.84 8.32 10.85l3.29-3.29c.03-.03.05-.05.08-.08H3.74V6.09h7.95c-.03-.03-.05-.05-.08-.08L8.32 2.72l.99-.99 3.29 3.29c.25.25.48.49.65.7.18.22.34.48.39.8Z" fill="currentColor"/>
  </svg></span>
}
