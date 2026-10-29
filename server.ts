/**
 * Standalone CorelDraw Imposition HTTP Server
 *
 * Can be run independently on port 5174:
 *   npx tsx server.ts
 *
 * Accepts POST /api/impose with JSON:
 *   { size: "A4"|"A5", sheet: "13x19", title: "...", items: [{ name, base64 }] }
 * Returns:
 *   { ok: true, totalSheets, totalPosters, pdfBase64 }
 */
import { createServer } from 'node:http'
import { runCorelDrawImposition } from './src/lib/api-impose'

const PORT = Number(process.env.CORELDRAW_PORT || 5174)

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

  if (req.url === '/api/impose' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const data = JSON.parse(raw)

        const items = (data.items || []).map((it: any) => ({
          name: it.name,
          bytes: Buffer.from(it.base64, 'base64'),
          copies: it.copies,
        }))

        const result = await runCorelDrawImposition({
          size: data.size,
          sheet: data.sheet,
          title: data.title,
          items,
        })

        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            ok: true,
            totalSheets: result.totalSheets,
            totalPosters: result.totalPosters,
            pdfBase64: Buffer.from(result.pdfBytes).toString('base64'),
          }),
        )
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
  console.log(`CorelDraw Imposition Server running at http://localhost:${PORT}/api/impose`)
})

