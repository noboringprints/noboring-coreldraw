/**
 * Standalone Print Ready HTTP Server
 *
 * Can be run independently on port 5174:
 *   npx tsx server.ts
 *
 * Every route takes a JSON POST with { items: [{ name, base64, ... }], ... } and answers
 *   { ok: true, totalSheets, pdfBase64, warnings, ... }  or  { ok: false, error }
 * See "API" in the README for each route's options.
 *
 *   POST /api/posters    bleed, crop marks, ups
 *   POST /api/stickers   background removal, contour cut lines, nesting
 *   POST /api/printcut   any size and shape, ganged with cut lines
 *   POST /api/impose     the storefront's poster route: takes every file to have its own bleed
 */
import { createServer } from 'node:http'
import { nodeRasterizer } from './scripts/rasterNode'
import { runCorelDrawImposition } from './src/lib/api-impose'
import { runPrintCutJob } from './src/lib/api-printcut'
import { runStickerJob } from './src/lib/api-stickers'

const PORT = Number(process.env.CORELDRAW_PORT || 5174)

const withBytes = (data: any) => (data.items || []).map(({ base64, ...it }: any) => ({ ...it, bytes: Buffer.from(base64, 'base64') }))

/** Base64 for the PDF, everything else as the engine reported it. */
const answer = <T extends { pdfBytes: Uint8Array }>({ pdfBytes, ...rest }: T) => ({ ok: true, ...rest, pdfBase64: Buffer.from(pdfBytes).toString('base64') })

const routes: Record<string, (data: any) => Promise<object>> = {
  '/api/impose': async (data) => answer(await runCorelDrawImposition({ size: data.size, sheet: data.sheet, title: data.title, items: withBytes(data) })),
  '/api/posters': async (data) =>
    answer(await runCorelDrawImposition({ size: data.size, sheet: data.sheet, title: data.title, bleedMm: data.bleedMm, autoBleed: true, rasterizer: nodeRasterizer, items: withBytes(data) })),
  '/api/stickers': async (data) => answer(await runStickerJob({ ...data, items: withBytes(data) })),
  '/api/printcut': async (data) => answer(await runPrintCutJob({ ...data, items: withBytes(data) })),
}

const server = createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', service: 'coreldraw-imposition' }))
    return
  }

  const route = req.method === 'POST' ? routes[req.url ?? ''] : undefined
  if (route) {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const result = await route(JSON.parse(raw))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (err: any) {
        console.error('[coreldraw server] error:', err)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }))
      }
    })
    return
  }

  res.statusCode = 404
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log(`Print Ready API running at http://localhost:${PORT} (/api/posters, /api/stickers, /api/printcut, /api/impose)`)
})
