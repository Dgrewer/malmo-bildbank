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

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
})
