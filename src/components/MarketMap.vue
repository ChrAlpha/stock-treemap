<script setup lang="ts">
import type { Focus, Group, Leaf, MapLayout, Rect, SizeBy } from '../lib/treemap'
import type { Scale } from '../lib/scale'
import type { MarketSpec } from '~shared/markets'
import type { Period, Stock } from '~shared/snapshot'
import { useResizeObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { pct } from '../lib/format'
import { stockLabel, stockSubLabel } from '../lib/names'
import { industryName, sectorName } from '../lib/taxonomy'
import { buildTree, layoutMap, parentFocus } from '../lib/treemap'

export interface HoverInfo {
  stock: Stock
  /** Pointer position relative to the map. */
  x: number
  y: number
  pinned: boolean
}

const props = defineProps<{
  market: MarketSpec
  stocks: Stock[]
  period: Period
  sizeBy: SizeBy
  scale: Scale
  focus: Focus
  /** When set, tiles failing the predicate are dimmed. */
  highlight: ((s: Stock) => boolean) | null
  /** Symbol to ring (search result). */
  marked: string | null
  label: string
}>()

const emit = defineEmits<{
  focus: [id: Focus]
  hover: [info: HoverInfo | null]
}>()

const PAPER = '#f1f7f8'
const INK = '#1c232d'
const INK_2 = '#4b535c'
const FONT = '"Mona Sans Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const STRETCH = [100, 87.5, 75] as const
const STRETCH_KEYWORD = { 100: 'normal', 87.5: 'semi-condensed', 75: 'condensed' } as const
type Stretch = typeof STRETCH[number]

const wrap = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const width = ref(0)
const height = ref(0)

useResizeObserver(wrap, ([entry]) => {
  const box = entry!.contentRect
  width.value = Math.floor(box.width)
  height.value = Math.floor(box.height)
})

const tree = computed(() => buildTree(props.stocks))
const layout = shallowRef<MapLayout>({ leaves: [], groups: [] })

watch([tree, () => props.focus, width, height, () => props.sizeBy, () => props.period], () => {
  if (!width.value || !height.value)
    return
  layout.value = layoutMap(tree.value, props.focus, width.value, height.value, props.sizeBy, props.period)
}, { immediate: true })

// ── Animation state ──────────────────────────────────────────────

interface Tile { rect: Rect, value: number | null }
/** What is on screen right now, keyed by leaf id. */
let shown = new Map<string, Tile>()
let shownGroups = new Map<string, Rect>()

interface Transition {
  start: number
  duration: number
  from: Map<string, Tile>
  fromGroups: Map<string, Rect>
  exiting: { leaf: Leaf, from: Tile, to: Rect }[]
  /** Zoom transform old→new, used to fly tiles in/out of view. */
  zoom: ((r: Rect) => Rect) | null
  zoomInverse: ((r: Rect) => Rect) | null
  /** First paint: tiles sit in place and colour bleeds in from neutral. */
  inkIn: boolean
}
let transition: Transition | null = null
let frame = 0
let firstPaint = true
// The settled map (tiles, labels, headers) is cached offscreen so hover and
// search rings only repaint overlays. Bump `baseVersion` when it goes stale.
let baseVersion = 0
let cachedVersion = -1
const baseCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
let lastLeaves = new Map<string, Leaf>()

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const ease = (t: number) => 1 - (1 - t) ** 3
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x0: lerp(a.x0, b.x0, t),
  y0: lerp(a.y0, b.y0, t),
  x1: lerp(a.x1, b.x1, t),
  y1: lerp(a.y1, b.y1, t),
})

function affine(from: Rect, to: Rect) {
  const sx = (to.x1 - to.x0) / Math.max(from.x1 - from.x0, 1e-6)
  const sy = (to.y1 - to.y0) / Math.max(from.y1 - from.y0, 1e-6)
  return (r: Rect): Rect => ({
    x0: to.x0 + (r.x0 - from.x0) * sx,
    y0: to.y0 + (r.y0 - from.y0) * sy,
    x1: to.x0 + (r.x1 - from.x0) * sx,
    y1: to.y0 + (r.y1 - from.y0) * sy,
  })
}

let prevFocus: Focus = null
let prevGroupRects = new Map<string, Rect>()

watch(layout, (next) => {
  const now = performance.now()
  // Freeze whatever is mid-flight as the new starting point.
  const current = new Map(shown)
  const full: Rect = { x0: 0, y0: 0, x1: width.value, y1: height.value }

  let zoom: Transition['zoom'] = null
  let zoomInverse: Transition['zoomInverse'] = null
  const focus = props.focus
  if (focus !== prevFocus) {
    const wasVisible = focus && prevGroupRects.get(focus)
    const nowChild = prevFocus && next.groups.find(g => g.id === prevFocus)
    if (wasVisible) {
      // Zoom in: the clicked group's old rect becomes the whole canvas.
      zoom = affine(wasVisible, full)
      zoomInverse = affine(full, wasVisible)
    }
    else if (nowChild) {
      // Zoom out: the whole canvas shrinks back into the group's new rect.
      zoom = affine(full, nowChild.rect)
      zoomInverse = affine(nowChild.rect, full)
    }
  }

  const nextIds = new Set(next.leaves.map(l => l.id))
  const exiting: Transition['exiting'] = []
  for (const [id, tile] of current) {
    if (!nextIds.has(id)) {
      const leaf = lastLeaves.get(id)
      if (leaf)
        exiting.push({ leaf, from: tile, to: zoom ? zoom(tile.rect) : tile.rect })
    }
  }

  transition = {
    start: now,
    duration: reducedMotion ? 0 : firstPaint ? 900 : zoom ? 520 : 420,
    inkIn: firstPaint,
    from: current,
    fromGroups: new Map(shownGroups),
    exiting,
    zoom,
    zoomInverse,
  }
  firstPaint = firstPaint && next.leaves.length === 0
  prevFocus = focus
  prevGroupRects = new Map(next.groups.map(g => [g.id, g.rect]))
  lastLeaves = new Map(next.leaves.map(l => [l.id, l]))
  baseVersion++
  schedule()
})

// Period changes flow through `layout` (group averages depend on it) and tween there.
watch([() => props.scale, () => props.highlight], () => {
  baseVersion++
  schedule()
})
watch(() => props.marked, () => schedule())

function schedule() {
  if (!frame)
    frame = requestAnimationFrame(draw)
}

// ── Text measurement ────────────────────────────────────────────

const widthCache = new Map<string, number>()
let ctx: CanvasRenderingContext2D | null = null

function setFont(c: CanvasRenderingContext2D, weight: number, size: number, stretch: Stretch = 100) {
  c.font = `${weight} ${STRETCH_KEYWORD[stretch]} ${size}px ${FONT}`
  if ('fontStretch' in c)
    (c as CanvasRenderingContext2D & { fontStretch: string }).fontStretch = STRETCH_KEYWORD[stretch]
}

/** Width of `text` at 100px, cached. */
function measure(text: string, weight: number, stretch: Stretch) {
  const key = `${weight}|${stretch}|${text}`
  let w = widthCache.get(key)
  if (w === undefined && ctx) {
    setFont(ctx, weight, 100, stretch)
    w = ctx.measureText(text).width
    widthCache.set(key, w)
  }
  return w ?? text.length * 60
}

function ellipsize(c: CanvasRenderingContext2D, text: string, max: number) {
  if (c.measureText(text).width <= max)
    return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.measureText(`${text.slice(0, mid)}…`).width <= max)
      lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : ''
}

// ── Drawing ─────────────────────────────────────────────────────

function drawTile(c: CanvasRenderingContext2D, stock: Stock, r: Rect, value: number | null, alpha: number, dim: boolean) {
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0
  if (w < 0.6 || h < 0.6)
    return
  const sw = props.scale.at(value)
  c.globalAlpha = alpha * (dim ? 0.2 : 1)
  c.fillStyle = sw.fill
  const radius = Math.min(2.5, w / 5, h / 5)
  c.beginPath()
  c.roundRect(r.x0, r.y0, w, h, radius)
  c.fill()
  if (dim && alpha < 1)
    return
  c.globalAlpha = alpha * (dim ? 0.35 : 1)
  drawLabel(c, stock, r, value, sw.text, sw.textSoft)
  c.globalAlpha = 1
}

function drawLabel(c: CanvasRenderingContext2D, stock: Stock, r: Rect, value: number | null, ink: string, inkSoft: string) {
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0
  const pad = Math.min(Math.max(w * 0.06, 2), 8)
  const aw = w - pad * 2
  const ah = h - pad * 2
  if (aw < 12 || ah < 7)
    return

  const ticker = stockLabel(stock, props.market)
  // Bigger tiles get bigger type, but sub-linearly so mega-caps don't shout.
  const cap = Math.min(9 + Math.sqrt(w * h) * 0.085, 44)
  const twoLine = ah / 1.78 >= 8.5
  const byHeight = twoLine ? ah / 1.78 : ah / 1.1

  let size = 0
  let stretch: Stretch = 100
  for (const s of STRETCH) {
    const fit = Math.min(aw / (measure(ticker, 650, s) / 100), byHeight, cap)
    // Narrow widths only when they buy a clearly larger label.
    if (fit > size * 1.12) {
      size = fit
      stretch = s
    }
  }
  if (size < 7)
    return

  const changeSize = Math.max(size * 0.6, 8)
  const changeText = pct(value)
  const showChange = twoLine && measure(changeText, 500, 87.5) / 100 * changeSize <= aw
  const showName = showChange && size >= 22 && ah > size * 1.78 + 26

  const nameSize = Math.max(Math.min(size * 0.36, 13), 10)
  const blockH = size + (showChange ? changeSize * 1.18 : 0) + (showName ? nameSize * 1.5 : 0)
  const cx = (r.x0 + r.x1) / 2
  let y = (r.y0 + r.y1) / 2 - blockH / 2

  c.textAlign = 'center'
  c.textBaseline = 'top'
  c.fillStyle = ink
  setFont(c, 650, size, stretch)
  c.fillText(ticker, cx, y + size * 0.04)
  y += size
  if (showName) {
    setFont(c, 450, nameSize, 100)
    c.fillStyle = inkSoft
    c.fillText(ellipsize(c, stockSubLabel(stock, props.market), aw), cx, y + nameSize * 0.35)
    y += nameSize * 1.5
  }
  if (showChange) {
    setFont(c, 500, changeSize, 87.5)
    c.fillStyle = inkSoft
    c.fillText(changeText, cx, y + changeSize * 0.14)
  }
}

function drawHeader(c: CanvasRenderingContext2D, g: Group, r: Rect, alpha: number) {
  if (!g.header)
    return
  const w = r.x1 - r.x0
  const isSector = g.kind === 'sector'
  const name = isSector ? sectorName(g.key) : industryName(g.key)
  const size = isSector ? 12 : 10.5
  const x = r.x0 + (isSector ? 1 : 3)
  const yMid = r.y0 + g.header / 2 + (isSector ? 0 : 0.5)
  const change = pct(g.change)
  c.globalAlpha = alpha
  c.textBaseline = 'middle'
  c.textAlign = 'left'

  setFont(c, 500, size - 0.5, 87.5)
  const changeW = c.measureText(change).width
  setFont(c, isSector ? 620 : 500, size, 100)
  const room = w - (isSector ? 2 : 6)
  const showChange = room > changeW + 40
  const label = ellipsize(c, name, showChange ? room - changeW - 6 : room)
  if (!label)
    return
  c.fillStyle = isSector ? INK : INK_2
  c.fillText(label, x, yMid)
  if (showChange) {
    const lw = c.measureText(label).width
    setFont(c, 500, size - 0.5, 87.5)
    c.fillStyle = props.scale.ink(g.change)
    c.fillText(change, x + lw + 6, yMid)
  }
  c.globalAlpha = 1
}

function outline(c: CanvasRenderingContext2D, r: Rect, color: string, lineWidth: number, alpha = 1) {
  c.globalAlpha = alpha
  c.strokeStyle = color
  c.lineWidth = lineWidth
  const i = lineWidth / 2
  c.beginPath()
  c.roundRect(r.x0 + i, r.y0 + i, Math.max(r.x1 - r.x0 - lineWidth, 0), Math.max(r.y1 - r.y0 - lineWidth, 0), 2.5)
  c.stroke()
  c.globalAlpha = 1
}

const hoverId = ref<string | null>(null)

function drawBase(c: CanvasRenderingContext2D, tr: Transition | null, t: number, W: number, H: number) {
  c.globalAlpha = 1
  c.fillStyle = PAPER
  c.fillRect(0, 0, W, H)

  const e = ease(t)
  const { leaves, groups } = layout.value
  const highlight = props.highlight
  const nextShown = new Map<string, Tile>()

  // Exiting tiles underneath, flying out with the zoom.
  if (tr && t < 1) {
    for (const { leaf, from, to } of tr.exiting)
      drawTile(c, leaf.stock, lerpRect(from.rect, to, e), from.value, 1 - e, !!highlight && !highlight(leaf.stock))
  }

  for (const leaf of leaves) {
    const target = leaf.stock.change[props.period]
    const prev = tr?.from.get(leaf.id)
    let rect = leaf.rect
    let value = target
    let alpha = 1
    if (tr && t < 1) {
      if (prev) {
        rect = lerpRect(prev.rect, leaf.rect, e)
        value = prev.value != null && target != null ? lerp(prev.value, target, e) : target
      }
      else if (tr.zoomInverse) {
        rect = lerpRect(tr.zoomInverse(leaf.rect), leaf.rect, e)
      }
      else {
        // Colour bleeds in from neutral, like ink into paper; new tiles also fade unless it's the first paint.
        alpha = tr.inkIn ? 1 : e
        if (target != null)
          value = target * e
      }
    }
    nextShown.set(leaf.id, { rect, value })
    drawTile(c, leaf.stock, rect, value, alpha, !!highlight && !highlight(leaf.stock))
  }

  const nextGroups = new Map<string, Rect>()
  for (const g of groups) {
    const prev = tr?.fromGroups.get(g.id)
    const rect = tr && t < 1
      ? prev ? lerpRect(prev, g.rect, e) : tr.zoomInverse ? lerpRect(tr.zoomInverse(g.rect), g.rect, e) : g.rect
      : g.rect
    nextGroups.set(g.id, rect)
    drawHeader(c, g, rect, tr && t < 1 && !prev && !tr.zoomInverse ? e : 1)
  }

  shown = nextShown
  shownGroups = nextGroups
}

function draw(now: number) {
  frame = 0
  const el = canvas.value
  if (!el || !width.value)
    return
  const dpr = window.devicePixelRatio || 1
  const W = width.value
  const H = height.value
  if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
    el.width = Math.round(W * dpr)
    el.height = Math.round(H * dpr)
  }
  const c = (ctx ??= el.getContext('2d'))
  if (!c)
    return
  const tr = transition
  const t = tr ? (tr.duration ? Math.min((now - tr.start) / tr.duration, 1) : 1) : 1
  const { leaves, groups } = layout.value

  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalAlpha = 1
  if (!tr && cachedVersion === baseVersion && baseCanvas?.width === el.width && baseCanvas.height === el.height) {
    c.drawImage(baseCanvas, 0, 0)
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  else {
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawBase(c, tr, t, W, H)
    if (t >= 1 && baseCanvas) {
      baseCanvas.width = el.width
      baseCanvas.height = el.height
      baseCanvas.getContext('2d')!.drawImage(el, 0, 0)
      cachedVersion = baseVersion
    }
  }

  if (t >= 1) {
    const marked = props.marked && leaves.find(l => l.stock.symbol === props.marked)
    if (marked) {
      outline(c, marked.rect, PAPER, 5)
      outline(c, { x0: marked.rect.x0 + 1.5, y0: marked.rect.y0 + 1.5, x1: marked.rect.x1 - 1.5, y1: marked.rect.y1 - 1.5 }, INK, 2)
    }
    const hovered = hoverId.value && leaves.find(l => l.id === hoverId.value)
    if (hovered) {
      const ind = groups.find(g => g.id === hovered.industryId)
      if (ind)
        outline(c, ind.rect, INK, 1, 0.45)
      outline(c, hovered.rect, INK, 2)
    }
  }

  if (t < 1)
    schedule()
  else
    transition = null
}

// ── Interaction ─────────────────────────────────────────────────

function hit(x: number, y: number) {
  for (const g of layout.value.groups) {
    const r = g.rect
    if (g.header && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y0 + g.header)
      return { kind: 'header' as const, group: g }
  }
  for (const l of layout.value.leaves) {
    const r = l.rect
    if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)
      return { kind: 'leaf' as const, leaf: l }
  }
  return null
}

const cursor = ref('default')
let pinnedId: string | null = null
// `click` isn't a PointerEvent everywhere; remember what pressed.
let pressType = 'mouse'

function local(e: PointerEvent | MouseEvent) {
  const box = wrap.value!.getBoundingClientRect()
  return { x: e.clientX - box.left, y: e.clientY - box.top }
}

function onMove(e: PointerEvent) {
  if (e.pointerType === 'touch' || transition)
    return
  const { x, y } = local(e)
  const h = hit(x, y)
  const id = h?.kind === 'leaf' ? h.leaf.id : null
  cursor.value = h?.kind === 'header' || (h?.kind === 'leaf' && props.focus?.startsWith('i:') !== true) ? 'pointer' : 'default'
  if (id !== hoverId.value) {
    hoverId.value = id
    schedule()
  }
  emit('hover', h?.kind === 'leaf' ? { stock: h.leaf.stock, x, y, pinned: false } : null)
}

function onLeave(e: PointerEvent) {
  if (e.pointerType === 'touch')
    return
  hoverId.value = null
  schedule()
  emit('hover', null)
}

function drillFrom(leaf: Leaf) {
  if (!props.focus)
    return leaf.sectorId
  if (props.focus.startsWith('s:'))
    return leaf.industryId
  return null
}

function onClick(e: MouseEvent) {
  const { x, y } = local(e)
  const h = hit(x, y)
  if (!h) {
    pinnedId = null
    emit('hover', null)
    return
  }
  if (h.kind === 'header') {
    pinnedId = null
    emit('hover', null)
    emit('focus', h.group.id)
    return
  }
  // Touch: first tap shows details, second tap on the same tile drills in.
  if (pressType === 'touch' && pinnedId !== h.leaf.id) {
    pinnedId = h.leaf.id
    hoverId.value = h.leaf.id
    schedule()
    emit('hover', { stock: h.leaf.stock, x, y, pinned: true })
    return
  }
  const next = drillFrom(h.leaf)
  if (next) {
    pinnedId = null
    hoverId.value = null
    emit('hover', null)
    emit('focus', next)
  }
}

function onContext(e: MouseEvent) {
  if (!props.focus)
    return
  e.preventDefault()
  emit('focus', parentFocus(props.focus))
}

onMounted(async () => {
  // Labels are measured with the real face; re-measure once it's in.
  try {
    await Promise.all([
      document.fonts.load(`650 20px "Mona Sans Variable"`),
      document.fonts.load(`650 condensed 20px "Mona Sans Variable"`),
    ])
  }
  catch {}
  widthCache.clear()
  baseVersion++
  schedule()
})

onBeforeUnmount(() => cancelAnimationFrame(frame))

</script>

<template>
  <div ref="wrap" class="relative h-full w-full select-none" :style="{ cursor }">
    <canvas
      ref="canvas"
      class="absolute inset-0 h-full w-full"
      role="img"
      :aria-label="label"
      @pointermove="onMove"
      @pointerleave="onLeave"
      @pointerdown="pressType = $event.pointerType"
      @click="onClick"
      @contextmenu="onContext"
    />
  </div>
</template>
