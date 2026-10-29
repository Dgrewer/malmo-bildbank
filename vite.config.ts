import fs from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Appen får aldrig prata med något utanför sin egen origin. All data läses
// lokalt via File System Access API och visas som blob:-URL:er.
// 'wasm-unsafe-eval' behövs för Transformers.js (ONNX Runtime kör WebAssembly).
const productionCsp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// Vites utvecklingsserver kräver inline-skript/-stilar (React Refresh, HMR)
// och en websocket mot den lokala servern. Fortfarande inga externa anrop.
const developmentCsp = productionCsp
  .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*")

function contentSecurityPolicy(): Plugin {
  let csp = productionCsp
  return {
    name: 'content-security-policy',
    configResolved(config) {
      csp = config.command === 'serve' ? developmentCsp : productionCsp
    },
    // Platshållaren står direkt efter charset i index.html, så att policyn
    // gäller innan något skript laddas.
    transformIndexHtml(html) {
      return html.replace('%APP_CSP%', csp)
    },
  }
}

// Endast utvecklingsservern: lägger in testkroken src/dev/testdataHook.ts och
// lämnar ut testdata/ till den. Finns inte i bygget.
function testdataServer(): Plugin {
  return {
    name: 'testdata-server',
    apply: 'serve',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: '/src/dev/testdataHook.ts' }, injectTo: 'head' }]
    },
    configureServer(server) {
      const root = path.resolve(server.config.root, 'testdata')
      server.middlewares.use('/__testdata', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const target = path.resolve(root, url.searchParams.get('path') ?? '')
        if (target !== root && !target.startsWith(root + path.sep)) {
          res.statusCode = 403
          res.end()
          return
        }
        try {
          if (url.pathname === '/list') {
            const entries = await fs.readdir(target, { withFileTypes: true })
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify(
                await Promise.all(
                  entries.map(async (entry) => ({
                    name: entry.name,
                    kind: entry.isDirectory() ? 'directory' : 'file',
                    size: entry.isDirectory() ? undefined : (await fs.stat(path.join(target, entry.name))).size,
                  })),
                ),
              ),
            )
          } else if (url.pathname === '/file') {
            res.setHeader('Content-Type', 'application/octet-stream')
            res.end(await fs.readFile(target))
          } else {
            res.statusCode = 404
            res.end()
          }
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy(), testdataServer()],
  // Workern importeras först när importen startar. Utan listan upptäcker
  // utvecklingsservern beroendena först då och laddar om sidan mitt i importen.
  optimizeDeps: { include: ['exifr'] },
})
