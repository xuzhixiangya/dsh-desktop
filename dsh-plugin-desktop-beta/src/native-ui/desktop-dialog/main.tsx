import '../shared/theme.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { DESKTOP_DISPLAY_NAME } from '../../product-identity.ts'
import { DesktopDialogApp } from './App.tsx'

document.title = DESKTOP_DISPLAY_NAME

document.documentElement.classList.add('dshDesktopDialogDocument')
const root = document.getElementById('root')
if (root === null) throw new Error('dsh-desktop-dialog: root element is missing')
createRoot(root).render(<CSPProvider disableStyleElements><DesktopDialogApp /></CSPProvider>)
