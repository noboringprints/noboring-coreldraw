import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function imposeApiPlugin(): Plugin {
  return {
    name: 'coreldraw-impose-api',
    configureServer(server) {
      server.middlewares.use('/api/impose', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8')
            const data = JSON.parse(raw)
            const { runCorelDrawImposition } = await import('./src/lib/api-impose')
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
            console.error('[coreldraw/api/impose] error:', err)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: err.message || String(err) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), imposeApiPlugin()],
  build: { chunkSizeWarningLimit: 2000 },
  // pre-bundle the sticker background remover at start-up; found later, the dev server would reload the page mid-job
  optimizeDeps: { include: ['@huggingface/transformers'] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never)
