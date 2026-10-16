import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 2000 },
  // pre-bundle the sticker background remover at start-up; found later, the dev server would reload the page mid-job
  optimizeDeps: { include: ['@huggingface/transformers'] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never)
