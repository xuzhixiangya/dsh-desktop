/**
 * Extended and enhanced window layouts stay implemented, but they are not
 * offered yet. While this is false the window always boots in compatibility
 * mode, and the chooser stays out of the title bar, settings, setup, and tray.
 * Flip it when those layouts are ready for users.
 */
export const DESKTOP_ALTERNATE_WINDOW_MODES_ENABLED = false

/** Mode the running window actually uses. Stored preferences are left intact. */
export function presentedDesktopShellMode<Mode extends string>(mode: Mode): Mode | 'compatibility' {
  return DESKTOP_ALTERNATE_WINDOW_MODES_ENABLED ? mode : 'compatibility'
}
