// Share-card crawlers (X among them) don't resolve a relative og:image against
// the page, and the HTML can't know which domain it is served from. The site
// URL is configuration: applied at build time (Workers, or any build), and
// again at startup by the Node server, which wins. Without one the image path
// stays relative, and whether it shows is up to each platform.

/** Origin of a configured site URL; anything but a full http(s) URL is a configuration error. */
export function siteOrigin(url: string) {
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  }
  catch {}
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:')
    throw new Error(`SITE_URL must be a full URL such as https://stock.example.com, got "${url}"`)
  return parsed.origin
}

const SHARE_IMAGE = /(<meta (?:property|name)="(?:og|twitter):image" content=")(?:https?:\/\/[^/"]*)?\/(?!\/)/g

/** Points the share-image URLs, relative or already absolute, at `origin`. */
export function withShareOrigin(html: string, origin: string) {
  return html.replace(SHARE_IMAGE, `$1${origin}/`)
}
