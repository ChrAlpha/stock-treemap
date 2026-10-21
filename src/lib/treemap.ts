import type { HierarchyRectangularNode } from 'd3-hierarchy'
import type { Period, Stock } from '~shared/snapshot'
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'

export type SizeBy = 'marketCap' | 'valueTraded'

interface Datum {
  id: string
  kind: 'root' | 'sector' | 'industry' | 'stock'
  key: string
  stock?: Stock
  children?: Datum[]
}

export interface Rect { x0: number, y0: number, x1: number, y1: number }

export interface Group {
  id: string
  kind: 'sector' | 'industry'
  key: string
  /** Sector key for industries; own key for sectors. */
  sector: string
  rect: Rect
  /** Height of the label strip reserved at the top (0 = no label). */
  header: number
  change: number | null
  count: number
}

export interface Leaf {
  id: string
  stock: Stock
  rect: Rect
  industryId: string
  sectorId: string
}

export interface MapLayout {
  leaves: Leaf[]
  groups: Group[]
}

/** `s:Sector` / `i:Sector/Industry`; null = whole market. */
export type Focus = string | null

export const sectorId = (s: string) => `s:${s}`
export const industryId = (s: string, i: string) => `i:${s}/${i}`

/** The sector, and the industry when zoomed that far, a focus points at; null for none or a malformed id. */
export function parseFocus(focus: Focus): { sector: string, industry: string | null } | null {
  if (focus?.startsWith('s:') && focus.length > 2)
    return { sector: focus.slice(2), industry: null }
  if (focus?.startsWith('i:')) {
    // Industry names may contain '/' ("Electronics/Appliances"); sector names don't.
    const body = focus.slice(2)
    const cut = body.indexOf('/')
    if (cut > 0 && cut < body.length - 1)
      return { sector: body.slice(0, cut), industry: body.slice(cut + 1) }
  }
  return null
}

/** One level up: industry → its sector → the whole market. */
export function parentFocus(focus: Focus): Focus {
  const p = parseFocus(focus)
  return p?.industry ? sectorId(p.sector) : null
}

export function buildTree(stocks: Stock[]): Datum {
  const sectors = new Map<string, Map<string, Stock[]>>()
  for (const s of stocks) {
    let inds = sectors.get(s.sector)
    if (!inds)
      sectors.set(s.sector, (inds = new Map()))
    let list = inds.get(s.industry)
    if (!list)
      inds.set(s.industry, (list = []))
    list.push(s)
  }
  return {
    id: 'root',
    kind: 'root',
    key: '',
    children: [...sectors].map(([sector, inds]) => ({
      id: sectorId(sector),
      kind: 'sector',
      key: sector,
      children: [...inds].map(([industry, list]) => ({
        id: industryId(sector, industry),
        kind: 'industry',
        key: industry,
        children: list.map(stock => ({ id: `t:${stock.symbol}`, kind: 'stock', key: stock.symbol, stock })),
      })),
    })),
  }
}

function find(node: Datum, id: string): Datum | null {
  if (node.id === id)
    return node
  for (const c of node.children ?? []) {
    if (c.kind === 'stock')
      return null
    const hit = find(c, id)
    if (hit)
      return hit
  }
  return null
}

/** Market-cap-weighted mean change, ignoring stocks without data. */
export function weightedChange(stocks: Iterable<Stock>, period: Period) {
  let sum = 0
  let weight = 0
  for (const s of stocks) {
    const v = s.change[period]
    if (v == null)
      continue
    sum += v * s.marketCap
    weight += s.marketCap
  }
  return weight ? sum / weight : null
}

const SECTOR_HEADER = 20
const INDUSTRY_HEADER = 15

export function layoutMap(
  tree: Datum,
  focus: Focus,
  width: number,
  height: number,
  sizeBy: SizeBy,
  period: Period,
): MapLayout {
  const base = (focus && find(tree, focus)) || tree
  const rootKind = base.kind
  const h = hierarchy(base)
    .sum(d => (d.stock ? Math.max(d.stock[sizeBy], 0) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  const deep = rootKind !== 'root'
  const headerOf = (n: HierarchyRectangularNode<Datum>) => {
    if (n.depth === 0)
      return 0
    const w = n.x1 - n.x0
    const hh = n.y1 - n.y0
    if (n.data.kind === 'sector')
      return w > 54 && hh > 44 ? SECTOR_HEADER : 0
    if (n.data.kind === 'industry') {
      // Industry labels only where there's room to spare; in the overview they'd crowd out tickers.
      const roomy = deep ? w > 72 && hh > 48 : w > 120 && hh > 90
      return roomy ? INDUSTRY_HEADER : 0
    }
    return 0
  }
  const layout = treemap<Datum>()
    .tile(treemapSquarify.ratio(1.15))
    .size([width, height])
    .paddingInner((n) => {
      switch (n.data.kind) {
        case 'root': return 4
        case 'sector': return deep ? 3 : 2
        default: return 1
      }
    })
    // Called once a node's own rect is final, so the label decision can depend on its size.
    .paddingTop(n => headerOf(n as HierarchyRectangularNode<Datum>))
    .round(false)

  const root = layout(h)
  const leaves: Leaf[] = []
  const groups: Group[] = []
  const rectOf = (n: HierarchyRectangularNode<Datum>): Rect => ({ x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 })

  root.each((n) => {
    const d = n.data
    if (d.kind === 'stock' && (n.value ?? 0) > 0) {
      const ind = n.parent!.data
      const sec = n.parent!.parent?.data
      leaves.push({
        id: d.id,
        stock: d.stock!,
        rect: rectOf(n),
        industryId: ind.id,
        sectorId: sec?.kind === 'sector' ? sec.id : sectorId(d.stock!.sector),
      })
    }
    else if ((d.kind === 'sector' || d.kind === 'industry') && (n.value ?? 0) > 0) {
      const stocks = n.leaves().map(l => l.data.stock!).filter(Boolean)
      groups.push({
        id: d.id,
        kind: d.kind,
        key: d.key,
        sector: d.kind === 'sector' ? d.key : (n.parent?.data.key ?? stocks[0]?.sector ?? ''),
        rect: rectOf(n),
        header: headerOf(n),
        change: weightedChange(stocks, period),
        count: stocks.length,
      })
    }
  })
  return { leaves, groups }
}
