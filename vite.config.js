import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import './scripts/lib/env.js'; // loads .env for the local API (never exposed to the browser)

// Local dev only: serve /api/* from the same handler Netlify runs in production,
// so `npm run dev` needs no extra tooling (no netlify-cli).
function localApi() {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        try {
          const { handle } = await server.ssrLoadModule('/server/routes.js');
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          headers.set('x-nf-client-connection-ip', req.socket.remoteAddress || 'local');
          const response = await handle(new Request(`http://${req.headers.host}${req.originalUrl}`, {
            method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) || !body.length ? undefined : body,
          }));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
          const sc = response.headers.getSetCookie?.() ?? [];
          if (sc.length) res.setHeader('set-cookie', sc);
          res.end(await response.text());
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Server error' }));
        }
      });
    },
  };
}

// Stamp the service worker with a per-build id so each deploy replaces the old cached app.
function swBuildId() {
  return {
    name: 'sw-build-id', apply: 'build',
    closeBundle() {
      const f = 'dist/sw.js';
      if (existsSync(f)) writeFileSync(f, readFileSync(f, 'utf8').replace('__BUILD_ID__', String(Date.now())));
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi(), swBuildId()],
  define: { __APP_BUILD__: JSON.stringify(String(Date.now())) }, // changes every build: phones re-download their data once per new version
});
