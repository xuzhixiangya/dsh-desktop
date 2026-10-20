import '../shared/theme.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { DESKTOP_DISPLAY_NAME } from '../../product-identity.ts'
import { RecoveryApp } from './App.tsx'

document.title = DESKTOP_DISPLAY_NAME

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-recovery: root element is missing')
createRoot(root).render(<CSPProvider disableStyleElements><RecoveryApp /></CSPProvider>)
