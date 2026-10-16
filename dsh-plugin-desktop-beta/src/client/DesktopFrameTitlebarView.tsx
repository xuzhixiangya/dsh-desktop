/** Independent Desktop frame portalled above the upstream content viewport. */

import { LayoutTemplate, PanelTop, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { DESKTOP_DISPLAY_NAME } from '../product-identity.ts'
import { DESKTOP_ALTERNATE_WINDOW_MODES_ENABLED } from '../window-mode-availability.ts'
import type { DesktopSettingsApi } from './desktop-settings-api.ts'
import type { DesktopClientEnvironment, DesktopClientMode } from './environment.ts'
import { DesktopNativeActions } from './DesktopNativeActions.tsx'
import { Button } from '../native-ui/components/ui/button.tsx'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../native-ui/components/ui/hover-card.tsx'

export interface DesktopFrameTitlebarInjected {
  readonly environment: DesktopClientEnvironment
  readonly api: Pick<
    DesktopSettingsApi,
    'openTerminal' | 'restart' | 'restartToRecovery' | 'reloadRenderer' | 'toggleDeveloperTools' | 'checkForUpdates'
  >
  readonly remoteControl?: { readonly seen: boolean; open(): Promise<void> }
  readonly setMode: (mode: DesktopClientMode) => Promise<void>
}

const MODE_OPTIONS = [
  { mode: 'compatibility', title: 'compatibilityMode', body: 'compatibilityModeBody' },
  { mode: 'extended', title: 'extendedMode', body: 'extendedModeBody' },
  { mode: 'advanced', title: 'advancedMode', body: 'advancedModeBody' },
] as const satisfies readonly {
  readonly mode: DesktopClientMode
  readonly title: DesktopSettingsLocaleKey
  readonly body: DesktopSettingsLocaleKey
}[]

function DesktopModeIcon({ mode }: { readonly mode: DesktopClientMode }) {
  if (mode === 'compatibility') return <LayoutTemplate aria-hidden="true" />
  if (mode === 'extended') return <PanelTop aria-hidden="true" />
  return <Sparkles aria-hidden="true" />
}

/** Persist a presentation choice before opening the standard Desktop restart confirmation. */
export async function selectDesktopFrameMode(
  mode: DesktopClientMode,
  setMode: (mode: DesktopClientMode) => Promise<void>,
  restart: () => Promise<void>,
): Promise<void> {
  await setMode(mode)
  await restart()
}

export function DesktopModeControl({
  mode,
  setMode,
  restart,
  t,
}: {
  readonly mode: DesktopClientMode
  readonly remoteControl?: { readonly seen: boolean; open(): Promise<void> }
  readonly setMode: (mode: DesktopClientMode) => Promise<void>
  readonly restart: () => Promise<void>
  readonly t: (key: DesktopSettingsLocaleKey) => string
}) {
  const [switching, setSwitching] = useState<DesktopClientMode>()
  const [failed, setFailed] = useState(false)
  const current = MODE_OPTIONS.find(option => option.mode === mode)
  if (current === undefined) return null

  const switchTo = (next: DesktopClientMode): void => {
    if (switching !== undefined || next === mode) return
    setSwitching(next)
    setFailed(false)
    void selectDesktopFrameMode(next, setMode, restart)
      .catch(() => { setFailed(true) })
      .finally(() => { setSwitching(undefined) })
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        closeDelay={200}
        delay={150}
        render={<button type="button" className="dshDesktopFrameMode" />}
        aria-label={`${t('presentationTitle')}: ${t(current.title)}`}
      >
        {t(current.title)}
      </HoverCardTrigger>
      <HoverCardContent className="dshDesktopVersionPopover dshDesktopModePopover">
        <div className="dshDesktopModePopoverHeader">{t('switchPresentationMode')}</div>
        <div className="dshDesktopModeOptions" role="group" aria-label={t('switchPresentationMode')}>
          {MODE_OPTIONS.filter(option => option.mode !== mode).map(option => (
            <Button
              className="dshDesktopModeOption"
              disabled={switching !== undefined}
              key={option.mode}
              size="sm"
              variant="ghost"
              onClick={() => { switchTo(option.mode) }}
            >
              <DesktopModeIcon mode={option.mode} />
              <span className="dshDesktopModeOptionCopy">
                <strong>{t(option.title)}</strong>
                <small>{switching === option.mode ? t('switchingPresentationMode') : t(option.body)}</small>
              </span>
            </Button>
          ))}
        </div>
        {failed && <span className="dshDesktopVersionCheckError" role="alert">{t('switchPresentationModeError')}</span>}
      </HoverCardContent>
    </HoverCard>
  )
}

/** Horizontal frame surface; the unrelated upstream content starts below it. */
export function DesktopFrameTitlebarView({ api, environment, setMode, t, remoteControl }: DesktopFrameTitlebarInjected & {
  readonly t: (key: DesktopSettingsLocaleKey) => string
}) {
  return (
    <header
      className="dshDesktopFrameTitlebar"
      data-dsh-desktop-frame="titlebar"
      data-mode={environment.mode}
      data-platform={environment.platform}
      data-material={environment.material}
    >
      <div className="dshDesktopFrameIdentity">
        <span className="dshDesktopFrameProduct">{DESKTOP_DISPLAY_NAME}</span>
        {DESKTOP_ALTERNATE_WINDOW_MODES_ENABLED && <DesktopModeControl
          mode={environment.mode}
          setMode={setMode}
          restart={api.restart}
          t={t}
        />}
      </div>
      <div className="dshDesktopFrameActions">
        {remoteControl && <button type="button" className="dshDesktopFrameMode dshDesktopRemoteControl" onClick={() => { void remoteControl.open().catch(() => {}) }}>
          {t('remoteControl')}{!remoteControl.seen && <span className="dshDesktopRemoteControlDot" aria-label={t('remoteControlNew')} />}
        </button>}
        <DesktopNativeActions api={api} t={t} placement="titlebar" />
      </div>
    </header>
  )
}
