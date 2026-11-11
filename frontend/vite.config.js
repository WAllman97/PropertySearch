import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'

// Dev only: serve the Vercel functions in api/ from the Vite dev server, so
// the whole app (including /api/* and the public /book/<slug> page) works
// with `npm run dev`. In production Vercel runs api/ itself and this plugin
// is never used.
//
// Server-side secrets come from api/.env and ../backend/.env (both
// gitignored). Emails are NOT sent locally unless DEV_SEND_EMAILS=1, so
// testing bookings doesn't email real agents.
function vercelApiDev() {
  return {
    name: 'vercel-api-dev',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root

      // Corporate networks often re-sign TLS with their own root CA, which
      // Node doesn't trust by default (Supabase calls then fail with
      // "self-signed certificate in chain"). Also trust the OS store.
      try {
        tls.setDefaultCACertificates([
          ...tls.getCACertificates('default'),
          ...tls.getCACertificates('system'),
        ])
      } catch {
        // Older Node: no-op; set NODE_USE_SYSTEM_CA=1 instead.
      }
      const envFiles = [path.join(root, 'api/.env'), path.join(root, '../backend/.env')]

      for (const file of envFiles) {
        if (!fs.existsSync(file)) continue
        for (const [key, value] of Object.entries(loadEnvFile(file))) {
          if (process.env[key] === undefined) process.env[key] = value
        }
      }

      Object.assign(process.env, loadEnv('development', root, ''), {
        ...(process.env.DEV_SEND_EMAILS === '1' ? {} : { RESEND_API_KEY: '' }),
      })

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const match = url.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/)
        if (!match) return next()

        const file = path.join(root, 'api', `${match[1]}.js`)
        if (!fs.existsSync(file)) return next()

        try {
          const { default: handler } = await server.ssrLoadModule(file)

          let raw = ''
          for await (const chunk of req) raw += chunk
          req.body = raw ? JSON.parse(raw) : {}
          req.query = Object.fromEntries(url.searchParams)

          res.status = (code) => {
            res.statusCode = code
            return res
          }
          res.json = (body) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
            return res
          }

          await handler(req, res)
        } catch (error) {
          console.error(`[api/${match[1]}]`, error)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Dev server error' }))
        }
      })
    },
  }
}

function loadEnvFile(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

export default defineConfig({
  plugins: [react(), vercelApiDev()],
  server: {
    port: 5173,
    open: false,
  },
})
