import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyStoredTheme } from './theme.ts'
import { applyStoredLocale, startLocale } from './i18n/index.ts'
import './styles.css'

applyStoredTheme() // before the first paint, so a light-theme user never sees a dark flash
applyStoredLocale()
// a stored Turkish choice loads its catalogue before the first paint (no flash), waiting about 2 s at most
startLocale().then(() => createRoot(document.getElementById('root')!).render(<App />))
