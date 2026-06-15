import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './globals.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Fade out the instant HTML splash (index.html) once React has committed and
// painted the real UI — two RAFs ensure the first frame is on screen, so there's
// no black flash between the splash and the app.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    // Fade out the instant HTML splash (index.html) once React has painted.
    const loader = document.getElementById('app-loader')
    if (!loader) return
    loader.classList.add('al-hide')
    loader.addEventListener('transitionend', () => loader.remove(), { once: true })
    setTimeout(() => loader.remove(), 600) // fallback if transitionend doesn't fire
  }),
)
