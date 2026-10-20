import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ command, mode }) => {
  // CUSTOM_DOMAIN (comma-separated) comes from the environment or a git-ignored
  // .env.local. Wrangler creates the DNS record and certificate on deploy, and
  // turns workers.dev off once a route is present. Unset: workers.dev only.
  const domains = (loadEnv(mode, process.cwd(), '').CUSTOM_DOMAIN ?? '')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean)
  const routes = command === 'build' && domains.length
    ? domains.map(pattern => ({ pattern, custom_domain: true }))
    : undefined

  return {
    plugins: [vue(), UnoCSS(), cloudflare(routes ? { config: { routes } } : {})],
    resolve: {
      alias: { '~shared': fileURLToPath(new URL('./shared', import.meta.url)) },
    },
  }
})
