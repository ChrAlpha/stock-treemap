// OKLCH ↔ sRGB, just enough to build perceptually even diverging ramps.

export interface Oklch { l: number, c: number, h: number }

function linearToSrgb(x: number) {
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  return Math.min(1, Math.max(0, v))
}

function srgbToLinear(x: number) {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

export function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bl)]
}

export function oklchToHex(c: Oklch) {
  return `#${oklchToRgb(c).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}

export function relativeLuminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = srgbToLinear(((n >> 16) & 255) / 255)
  const g = srgbToLinear(((n >> 8) & 255) / 255)
  const b = srgbToLinear((n & 255) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Interpolate in OKLCH along the shorter hue arc. */
export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  let dh = b.h - a.h
  if (dh > 180)
    dh -= 360
  if (dh < -180)
    dh += 360
  return { l: a.l + (b.l - a.l) * t, c: a.c + (b.c - a.c) * t, h: a.h + dh * t }
}
