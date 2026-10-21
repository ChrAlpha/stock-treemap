import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'
import { siteOrigin, withShareOrigin } from './shared/site'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // CUSTOM_DOMAIN (comma-separated) comes from the environment or a git-ignored
  // .env.local. Wrangler creates the DNS record and certificate on deploy, and
  // turns workers.dev off once a route is present. Unset: workers.dev only.
  const domains = (env.CUSTOM_DOMAIN ?? '')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean)
  const routes = command === 'build' && domains.length
    ? domains.map(pattern => ({ pattern, custom_domain: true }))
    : undefined
  // Origin for the share card's image link: SITE_URL, else the first custom domain.
  const siteUrl = env.SITE_URL || (domains[0] && `https://${domains[0]}`)
  const origin = siteUrl ? siteOrigin(siteUrl) : undefined

  return {
    plugins: [
      vue(),
      UnoCSS(),
      cloudflare(routes ? { config: { routes } } : {}),
      { name: 'share-origin', transformIndexHtml: html => origin ? withShareOrigin(html, origin) : html },
    ],
    resolve: {
      alias: { '~shared': fileURLToPath(new URL('./shared', import.meta.url)) },
    },
  }
})
