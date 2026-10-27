import { Suspense, lazy, useEffect, useState } from 'react'
import App from './App'
import Launcher, { type Mode } from './components/Launcher'

// the sticker tool is only downloaded when it's opened
const StickerApp = lazy(() => import('./stickers/StickerApp'))
const PrintCutApp = lazy(() => import('./printcut/PrintCutApp'))

const LAST_KEY = 'print-ready.last-mode'
const MODE_NAMES: Record<Mode, string> = { posters: 'Posters', stickers: 'Stickers', printcut: 'Print & Cut' }

function modeFromHash(): Mode | 'home' {
  if (location.hash.startsWith('#/stickers')) return 'stickers'
  if (location.hash.startsWith('#/printcut')) return 'printcut'
  if (location.hash.startsWith('#/posters')) return 'posters'
  return 'home'
}

/**
 * Start screen → Posters, Stickers or Print & Cut. The address (#/posters, #/stickers, #/printcut) says which one is open,
 * so the browser's back button and a page refresh behave. A tool stays alive once opened,
 * so switching back and forth never loses work.
 */
export default function Root() {
  const [mode, setMode] = useState(modeFromHash)
  const [opened, setOpened] = useState<Record<Mode, boolean>>({ posters: mode === 'posters', stickers: mode === 'stickers', printcut: mode === 'printcut' })
  const [last] = useState<Mode | null>(() => {
    try {
      return (localStorage.getItem(LAST_KEY) as Mode | null) ?? null
    } catch {
      return null
    }
  })

  useEffect(() => {
    const onHash = () => setMode(modeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (mode === 'home') {
      document.title = 'Print Ready'
      return
    }
    setOpened((o) => (o[mode] ? o : { ...o, [mode]: true }))
    document.title = `${MODE_NAMES[mode]} – Print Ready`
    try {
      localStorage.setItem(LAST_KEY, mode)
    } catch {
      /* not remembered – fine */
    }
  }, [mode])

  return (
    <>
      {mode === 'home' && <Launcher last={last} onPick={(m) => (location.hash = `#/${m}`)} />}
      {opened.posters && (
        <div className="h-full" hidden={mode !== 'posters'}>
          <App />
        </div>
      )}
      {opened.stickers && (
        <div className="h-full" hidden={mode !== 'stickers'}>
          <Suspense fallback={<div className="grid h-full place-items-center text-slate-400">Loading…</div>}>
            <StickerApp active={mode === 'stickers'} />
          </Suspense>
        </div>
      )}
      {opened.printcut && (
        <div className="h-full" hidden={mode !== 'printcut'}>
          <Suspense fallback={<div className="grid h-full place-items-center text-slate-400">Loading…</div>}>
            <PrintCutApp active={mode === 'printcut'} />
          </Suspense>
        </div>
      )}
    </>
  )
}
