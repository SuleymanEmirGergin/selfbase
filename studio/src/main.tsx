import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyStoredTheme } from './theme.ts'
import './styles.css'

applyStoredTheme() // before the first paint, so a light-theme user never sees a dark flash
createRoot(document.getElementById('root')!).render(<App />)
