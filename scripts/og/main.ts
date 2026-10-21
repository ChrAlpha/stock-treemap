import type { HierarchyRectangularNode } from 'd3-hierarchy'
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { MarketId } from '../../shared/markets'
import { MARKETS } from '../../shared/markets'
import { makeScale } from '../../src/lib/scale'
import '@fontsource-variable/mona-sans/wdth.css'
import './style.css'

// The share card (public/og.png): one treemap filling the canvas, whose
// largest cell is the title. Tiles are a fixed, illustrative cross-section of
// the 13 markets, not live data; colours come from the site's own scale.
//
// To regenerate: `pnpm og`, open the page with a 1200×630 viewport at device
// pixel ratio 1 (DevTools device toolbar) and save a screenshot over public/og.png.

const W = 1200
const H = 630
const MARGIN = 20
const TITLE_W = 404
const GAP = 6
const HEADER = 26

const FONT = '"Mona Sans Variable", "Noto Sans CJK SC", sans-serif'
const STRETCH = [100, 87.5, 75] as const
const STRETCH_KEYWORD = { 100: 'normal', 87.5: 'semi-condensed', 75: 'condensed' } as const
type Stretch = typeof STRETCH[number]

const INK = '#1c232d'
const PAPER = '#f1f7f8'

// [label as the site writes it, market cap (USD bn, rough), illustrative day change %]
type Row = [string, number, number]
const DATA: Record<MarketId, Row[]> = {
  us: [
    ['NVDA', 4600, -0.6],
    ['AAPL', 3900, 0.9],
    ['MSFT', 3700, -0.4],
    ['GOOG', 3100, 1.7],
    ['AMZN', 2400, 0.3],
    ['META', 1800, -1.3],
    ['AVGO', 1600, 2.4],
    ['TSLA', 1450, 3.2],
    ['BRK.A', 1050, 0.2],
    ['JPM', 830, 0.8],
    ['WMT', 820, -0.5],
    ['ORCL', 800, -2.3],
    ['LLY', 780, 2.0],
    ['V', 660, 0.4],
    ['MA', 530, 0.6],
    ['NFLX', 500, -1.7],
    ['XOM', 480, -0.9],
    ['JNJ', 460, 1.0],
    ['PLTR', 430, 4.4],
    ['COST', 420, -0.2],
    ['AMD', 400, -2.9],
    ['HD', 380, 0.5],
    ['ABBV', 370, 1.4],
    ['BAC', 360, 0.9],
    ['PG', 350, -0.3],
    ['UNH', 300, -1.1],
    ['GE', 300, 1.9],
    ['KO', 300, 0.1],
    ['CVX', 300, -0.7],
    ['CSCO', 290, 0.6],
    ['IBM', 280, 2.6],
    ['WFC', 270, 1.1],
    ['MU', 260, -3.4],
    ['CRM', 250, -0.8],
    ['MS', 240, 1.3],
    ['GS', 240, 1.5],
    ['TMUS', 220, -0.4],
    ['AXP', 220, 0.7],
    ['MRK', 220, 0.9],
    ['ABT', 220, -0.6],
    ['PM', 220, 0.3],
    ['CAT', 210, 2.2],
    ['RTX', 210, 0.4],
    ['MCD', 210, -0.2],
    ['LIN', 210, 0.5],
    ['PEP', 200, -0.9],
    ['DIS', 200, 1.6],
    ['T', 190, 0.2],
    ['UBER', 190, -1.5],
    ['INTU', 190, -1.1],
    ['NOW', 190, 2.9],
    ['QCOM', 180, -1.9],
  ],
  cn: [
    ['工商银行', 330, -0.6],
    ['中国移动', 300, -2.1],
    ['农业银行', 260, -0.4],
    ['贵州茅台', 250, -1.4],
    ['建设银行', 250, -0.7],
    ['中国石油', 220, -1.6],
    ['中国银行', 220, 0.4],
    ['宁德时代', 200, 2.7],
    ['中国海油', 160, -1.1],
    ['招商银行', 140, -0.3],
    ['比亚迪', 140, 1.2],
    ['中国平安', 130, -0.2],
    ['中国神华', 110, -3.0],
    ['长江电力', 100, -0.9],
    ['紫金矿业', 90, 1.8],
  ],
  hk: [
    ['騰訊控股', 700, 1.8],
    ['阿里巴巴', 350, 3.6],
    ['匯豐控股', 230, 0.4],
    ['小米集團', 150, -1.9],
    ['友邦保險', 100, 0.8],
    ['美團', 90, -2.6],
    ['香港交易所', 65, 1.1],
    ['京東集團', 50, 0.3],
  ],
  jp: [
    ['7203', 280, 1.2],
    ['8306', 170, 0.6],
    ['6758', 150, -0.8],
    ['9984', 130, 3.9],
    ['6501', 120, 1.5],
    ['9983', 100, -0.4],
    ['8316', 100, 0.7],
    ['8035', 90, 2.8],
    ['6861', 90, -1.2],
    ['7974', 90, 0.2],
  ],
  tw: [
    ['台積電', 1200, 2.3],
    ['鴻海', 90, 1.0],
    ['聯發科', 70, -1.4],
    ['台達電', 50, 3.1],
    ['廣達', 35, 0.6],
    ['富邦金', 35, -0.2],
  ],
  kr: [
    ['005930', 400, 3.0],
    ['000660', 200, 4.6],
    ['373220', 60, -1.8],
    ['207940', 55, 0.5],
    ['005380', 40, -0.6],
  ],
  in: [
    ['RELIANCE', 220, -0.7],
    ['HDFCBANK', 170, -0.3],
    ['TCS', 130, -1.6],
    ['BHARTIARTL', 130, 0.4],
    ['ICICIBANK', 110, -0.5],
    ['SBIN', 90, 0.9],
    ['INFY', 75, -2.2],
  ],
  uk: [
    ['AZN', 230, 0.9],
    ['HSBA', 220, 0.5],
    ['SHEL', 210, -1.0],
    ['ULVR', 150, 0.2],
    ['RIO', 100, 1.7],
  ],
  de: [
    ['SAP', 300, -1.3],
    ['SIE', 200, 0.6],
    ['DTE', 170, 0.3],
    ['ALV', 150, 1.1],
  ],
  fr: [
    ['MC', 300, -2.0],
    ['RMS', 250, -1.1],
    ['OR', 220, -0.5],
    ['TTE', 130, -0.8],
    ['SAN', 110, 0.4],
  ],
  ca: [
    ['RY', 200, 0.6],
    ['SHOP', 200, 2.5],
    ['TD', 140, 0.3],
    ['ENB', 100, -0.4],
  ],
  au: [
    ['CBA', 180, -0.6],
    ['BHP', 140, 1.4],
  ],
  sg: [
    ['D05', 100, 0.3],
    ['O39', 60, -0.2],
  ],
}

// Each market's share of the map: real caps would leave the US nine tenths
// of it. Within a market, sizes stay close to market cap.
const SHARE: Record<MarketId, number> = {
  us: 40, cn: 10, hk: 7.5, jp: 7.5, tw: 5.5, kr: 4.5, in: 5, uk: 4, de: 3.5, fr: 4, ca: 3.5, au: 2.5, sg: 2,
}
const area = (m: MarketId, cap: number) =>
  cap ** 0.9 * SHARE[m] / DATA[m].reduce((sum, [, c]) => sum + c ** 0.9, 0)

interface Node {
  key: string
  label: string
  /** Leaves only. */
  size?: number
  change?: number
  children?: Node[]
}

const params = new URLSearchParams(location.search)
const scale = makeScale('d1', 'red-up', 'pigment')

const canvas = document.querySelector<HTMLCanvasElement>('#map')!
const dpr = window.devicePixelRatio || 1
canvas.width = W * dpr
canvas.height = H * dpr
const c = canvas.getContext('2d')!
c.scale(dpr, dpr)

function setFont(weight: number, size: number, stretch: Stretch = 100) {
  c.font = `${weight} ${STRETCH_KEYWORD[stretch]} ${size}px ${FONT}`
  c.fontStretch = STRETCH_KEYWORD[stretch]
}

function measure(text: string, weight: number, stretch: Stretch) {
  setFont(weight, 100, stretch)
  return c.measureText(text).width
}

function roundRect(x0: number, y0: number, x1: number, y1: number, r: number) {
  c.beginPath()
  c.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(r, (x1 - x0) / 5, (y1 - y0) / 5))
  c.fill()
}

// Same fitting rules as the live map, with a larger ceiling: the card is read shrunk.
function drawLabel(label: string, x0: number, y0: number, x1: number, y1: number, ink: string) {
  const w = x1 - x0
  const h = y1 - y0
  const pad = Math.min(Math.max(w * 0.06, 2), 10)
  const aw = w - pad * 2
  const ah = h - pad * 2
  if (aw < 12 || ah < 7)
    return
  const cap = Math.min(9 + Math.sqrt(w * h) * 0.1, 64)
  let size = 0
  let stretch: Stretch = 100
  for (const s of STRETCH) {
    const fit = Math.min(aw / (measure(label, 650, s) / 100), ah / 1.1, cap)
    if (fit > size * 1.12) {
      size = fit
      stretch = s
    }
  }
  if (size < 7)
    return
  c.fillStyle = ink
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  setFont(650, size, stretch)
  c.fillText(label, (x0 + x1) / 2, (y0 + y1) / 2 + size * 0.04)
}

function draw() {
  c.fillStyle = PAPER
  c.fillRect(0, 0, W, H)

  const tree: Node = {
    key: 'root',
    label: '',
    children: (Object.entries(DATA) as [MarketId, Row[]][]).map(([m, rows]) => ({
      key: m,
      label: MARKETS[m].label,
      children: rows.map(([label, cap, change]) => ({ key: `${m}:${label}`, label, size: area(m, cap), change })),
    })),
  }
  const root = treemap<Node>()
    .tile(treemapSquarify.ratio(1.15))
    .size([W - MARGIN * 2 - TITLE_W - GAP, H - MARGIN * 2])
    .paddingInner(n => (n.depth === 0 ? GAP : 1.5))
    .paddingTop((n) => {
      const w = n.x1 - n.x0
      const h = n.y1 - n.y0
      return n.depth === 1 && w > 64 && h > 60 ? HEADER : 0
    })
    .round(false)(
    hierarchy(tree)
      .sum(d => d.size ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  )

  const ox = MARGIN + TITLE_W + GAP
  const oy = MARGIN
  root.each((n: HierarchyRectangularNode<Node>) => {
    const x0 = n.x0 + ox
    const y0 = n.y0 + oy
    const x1 = n.x1 + ox
    const y1 = n.y1 + oy
    if (n.depth === 2) {
      const sw = scale.at(n.data.change!)
      c.fillStyle = sw.fill
      roundRect(x0, y0, x1, y1, 3)
      drawLabel(n.data.label, x0, y0, x1, y1, sw.text)
    }
    else if (n.depth === 1 && n.y1 - n.y0 > 60 && n.x1 - n.x0 > 64) {
      c.fillStyle = INK
      c.textAlign = 'left'
      c.textBaseline = 'middle'
      setFont(620, 15)
      c.fillText(n.data.label, x0 + 1, y0 + HEADER / 2 - 1)
    }
  })
}

// The site's red-up scale, as its legend draws it.
document.querySelector('.legend .bar')!.append(...[-3, -2.5, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3].map((v) => {
  const el = document.createElement('i')
  el.style.background = scale.at(v).fill
  return el
}))
document.body.dataset.tile = params.get('tile') ?? 'card'

await Promise.all([
  document.fonts.load(`650 20px "Mona Sans Variable"`),
  document.fonts.load(`650 condensed 20px "Mona Sans Variable"`),
  document.fonts.load(`650 semi-condensed 20px "Mona Sans Variable"`),
  document.fonts.load(`700 20px "Noto Sans CJK SC"`, '版图'),
])
draw()
document.body.dataset.ready = '1'
