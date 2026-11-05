/**
 * Caption fonts, bundled with the app (no font is fetched from the internet).
 * A canvas only draws a web font once it has been loaded, so `loadCaptionFonts` must finish before drawing captions.
 */
import '@fontsource/caveat/600.css'
import '@fontsource/permanent-marker/400.css'
import '@fontsource/special-elite/400.css'
import '@fontsource/dancing-script/600.css'
import '@fontsource/pacifico/400.css'
import { FONTS } from './model'

let loading: Promise<void> | null = null

export function loadCaptionFonts(): Promise<void> {
  if (!loading)
    loading = Promise.all(FONTS.map((f) => document.fonts.load(`${f.weight} 32px "${f.family}"`, 'Aa').catch(() => []))).then(() => undefined)
  return loading
}
