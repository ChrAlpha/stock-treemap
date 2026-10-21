// The markets the map covers, shared by the Worker and the web app.
//
// Everything here is what the page needs to know without fetching anything:
// names, trading hours, index universes. How each market is fetched lives in
// worker/sources.ts. Each market is loaded independently, only when someone
// opens it, so adding one here costs nothing until it is viewed.

/** Minutes after local midnight. */
export interface Segment { open: number, close: number }

export interface UniverseSpec {
  id: string
  label: string
  /** Index quote that stands for it (`IndexQuote.symbol`). */
  index?: string
  /** Constituent count, used to approximate by size if membership is unavailable. */
  size?: number
}

export interface ExtraQuote {
  symbol: string
  label: string
  title?: string
  /** Up isn't good or bad (volatility): print the change in neutral ink. */
  neutral?: boolean
}

export interface MarketSpec {
  id: MarketId
  /** Short name for the picker: 美股, 港股… */
  label: string
  /** For the page title: 美股, 印度股市… */
  title: string
  region: 'americas' | 'asia' | 'europe'
  tz: string
  /** Clock prefix: 美东 / 东京… */
  city: string
  /** Regular sessions, in order; more than one means a lunch break. */
  sessions: Segment[]
  /** Pre-market start, if the source has extended-hours data. */
  pre?: number
  /** Post-market length after the close, in minutes. */
  post?: number
  /** Full-day closures. Markets without a list rely on the source to report holidays. */
  holidays?: ReadonlySet<string>
  /** date → close (minutes) on shortened days. */
  earlyCloses?: ReadonlyMap<string, number>
  /** Quote refresh cadence in session, ms. */
  refresh: number
  /** Extended-hours cadence, ms. */
  extRefresh?: number
  /** Feed delay in minutes: how long after an open before the data shows anything new. */
  delay: number
  /** Minutes after a session ends for its last delayed prints and closing auction to land. */
  settle: number
  /** Market cap and turnover currency. */
  currency: string
  /** Tiles show the ticker, or the name where tickers are numeric codes and names are short. */
  tileLabel: 'symbol' | 'name'
  /** The last one is always `all`. */
  universes: UniverseSpec[]
  extras: ExtraQuote[]
}

export const MARKET_IDS = ['us', 'cn', 'hk', 'jp', 'kr', 'tw', 'in', 'sg', 'au', 'uk', 'de', 'fr', 'ca'] as const
export type MarketId = typeof MARKET_IDS[number]

const MIN = 60_000
// Outside the US the feed runs 10–20 minutes behind; every ten minutes keeps
// the whole set inside the free plan's KV write budget (see test/clock.test.ts).
const REFRESH = 10 * MIN

/** Everything the source returns for the market; how deep that goes is set in worker/sources.ts. */
const all = (label = '全市场'): UniverseSpec => ({ id: 'all', label })

const hm = (h: number, m = 0) => h * 60 + m

export const MARKETS: Record<MarketId, MarketSpec> = {
  us: {
    id: 'us',
    label: '美股',
    title: '美股',
    region: 'americas',
    tz: 'America/New_York',
    city: '美东',
    sessions: [{ open: hm(9, 30), close: hm(16) }],
    pre: hm(4),
    post: 4 * 60,
    // NYSE full-day closures. Extend yearly.
    holidays: new Set([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
      '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
      '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    ]),
    earlyCloses: new Map([['2026-11-27', hm(13)], ['2026-12-24', hm(13)], ['2027-11-26', hm(13)]]),
    refresh: MIN,
    extRefresh: 10 * MIN,
    delay: 20,
    settle: 20,
    currency: '美元',
    tileLabel: 'symbol',
    universes: [
      { id: 'sp500', label: '标普 500', index: 'SPX', size: 500 },
      { id: 'ndx', label: '纳指 100', index: 'NDX', size: 100 },
      { id: 'dji', label: '道指 30', index: 'DJI', size: 30 },
      all(),
    ],
    extras: [{ symbol: 'VIX', label: 'VIX 恐慌指数', title: 'CBOE 波动率指数', neutral: true }],
  },
  cn: {
    id: 'cn',
    label: 'A 股',
    title: 'A 股',
    region: 'asia',
    tz: 'Asia/Shanghai',
    city: '北京',
    sessions: [{ open: hm(9, 30), close: hm(11, 30) }, { open: hm(13), close: hm(15) }],
    refresh: REFRESH,
    delay: 15,
    settle: 20,
    currency: '人民币',
    tileLabel: 'name',
    universes: [{ id: 'csi300', label: '沪深 300', index: 'CSI300', size: 300 }, all('全部 A 股')],
    extras: [
      { symbol: 'SSEC', label: '上证指数' },
      { symbol: 'SZI', label: '深证成指' },
      { symbol: 'CHINEXT', label: '创业板指' },
    ],
  },
  hk: {
    id: 'hk',
    label: '港股',
    title: '港股',
    region: 'asia',
    tz: 'Asia/Hong_Kong',
    city: '香港',
    sessions: [{ open: hm(9, 30), close: hm(12) }, { open: hm(13), close: hm(16) }],
    refresh: REFRESH,
    delay: 15,
    // Closing auction runs to 16:10.
    settle: 30,
    currency: '港元',
    tileLabel: 'name',
    universes: [
      { id: 'hsi', label: '恒生指数', index: 'HSI', size: 85 },
      { id: 'hstech', label: '恒生科技', index: 'HSTECH', size: 30 },
      all('全部港股'),
    ],
    extras: [{ symbol: 'HSCEI', label: '国企指数' }],
  },
  jp: {
    id: 'jp',
    label: '日股',
    title: '日股',
    region: 'asia',
    tz: 'Asia/Tokyo',
    city: '东京',
    sessions: [{ open: hm(9), close: hm(11, 30) }, { open: hm(12, 30), close: hm(15, 30) }],
    refresh: REFRESH,
    delay: 20,
    settle: 25,
    currency: '日元',
    tileLabel: 'symbol',
    universes: [{ id: 'n225', label: '日经 225', index: 'N225', size: 225 }, all()],
    extras: [{ symbol: 'TOPIX', label: 'TOPIX' }],
  },
  kr: {
    id: 'kr',
    label: '韩股',
    title: '韩股',
    region: 'asia',
    tz: 'Asia/Seoul',
    city: '首尔',
    sessions: [{ open: hm(9), close: hm(15, 30) }],
    refresh: REFRESH,
    delay: 20,
    settle: 25,
    currency: '韩元',
    tileLabel: 'symbol',
    universes: [
      { id: 'kospi200', label: 'KOSPI 200', index: 'KOSPI200', size: 200 },
      { id: 'kosdaq150', label: 'KOSDAQ 150', index: 'KOSDAQ150', size: 150 },
      all(),
    ],
    extras: [{ symbol: 'KOSPI', label: 'KOSPI 综合' }, { symbol: 'KOSDAQ', label: 'KOSDAQ 综合' }],
  },
  tw: {
    id: 'tw',
    label: '台股',
    title: '台股',
    region: 'asia',
    tz: 'Asia/Taipei',
    city: '台北',
    sessions: [{ open: hm(9), close: hm(13, 30) }],
    refresh: REFRESH,
    delay: 15,
    settle: 20,
    currency: '新台币',
    tileLabel: 'name',
    universes: [{ id: 'tw50', label: '台湾 50', index: 'TW50', size: 50 }, all()],
    extras: [{ symbol: 'TAIEX', label: '加权指数' }],
  },
  in: {
    id: 'in',
    label: '印度',
    title: '印度股市',
    region: 'asia',
    tz: 'Asia/Kolkata',
    city: '孟买',
    sessions: [{ open: hm(9, 15), close: hm(15, 30) }],
    refresh: REFRESH,
    delay: 15,
    settle: 25,
    currency: '卢比',
    tileLabel: 'symbol',
    universes: [{ id: 'nifty50', label: 'Nifty 50', index: 'NIFTY', size: 50 }, all()],
    extras: [{ symbol: 'SENSEX', label: 'Sensex' }],
  },
  sg: {
    id: 'sg',
    label: '新加坡',
    title: '新加坡股市',
    region: 'asia',
    tz: 'Asia/Singapore',
    city: '新加坡',
    sessions: [{ open: hm(9), close: hm(17) }],
    refresh: REFRESH,
    delay: 10,
    settle: 20,
    currency: '新加坡元',
    tileLabel: 'symbol',
    universes: [{ id: 'sti', label: '海峡时报', index: 'STI', size: 30 }, all()],
    extras: [],
  },
  au: {
    id: 'au',
    label: '澳洲',
    title: '澳洲股市',
    region: 'asia',
    tz: 'Australia/Sydney',
    city: '悉尼',
    sessions: [{ open: hm(10), close: hm(16) }],
    refresh: REFRESH,
    delay: 20,
    // Closing auction to ~16:12, then a 20-minute delay.
    settle: 35,
    currency: '澳元',
    tileLabel: 'symbol',
    // No index quote for the ASX 200 at the source: the tab shows its constituents' weighted change.
    universes: [{ id: 'asx200', label: 'ASX 200', size: 200 }, all()],
    extras: [],
  },
  uk: {
    id: 'uk',
    label: '英国',
    title: '英国股市',
    region: 'europe',
    tz: 'Europe/London',
    city: '伦敦',
    sessions: [{ open: hm(8), close: hm(16, 30) }],
    refresh: REFRESH,
    delay: 5,
    settle: 20,
    currency: '英镑',
    tileLabel: 'symbol',
    universes: [{ id: 'ftse100', label: '富时 100', index: 'UKX', size: 100 }, all()],
    extras: [],
  },
  de: {
    id: 'de',
    label: '德国',
    title: '德国股市',
    region: 'europe',
    tz: 'Europe/Berlin',
    city: '法兰克福',
    sessions: [{ open: hm(9), close: hm(17, 30) }],
    refresh: REFRESH,
    delay: 15,
    settle: 25,
    currency: '欧元',
    tileLabel: 'symbol',
    universes: [{ id: 'dax', label: 'DAX', index: 'DAX', size: 40 }, all()],
    extras: [],
  },
  fr: {
    id: 'fr',
    label: '法国',
    title: '法国股市',
    region: 'europe',
    tz: 'Europe/Paris',
    city: '巴黎',
    sessions: [{ open: hm(9), close: hm(17, 30) }],
    refresh: REFRESH,
    delay: 15,
    settle: 25,
    currency: '欧元',
    tileLabel: 'symbol',
    universes: [{ id: 'cac40', label: 'CAC 40', index: 'PX1', size: 40 }, all()],
    extras: [],
  },
  ca: {
    id: 'ca',
    label: '加拿大',
    title: '加拿大股市',
    region: 'americas',
    tz: 'America/Toronto',
    city: '多伦多',
    sessions: [{ open: hm(9, 30), close: hm(16) }],
    refresh: REFRESH,
    delay: 15,
    settle: 20,
    currency: '加元',
    tileLabel: 'symbol',
    // The source has no TSX 60 membership; its quote is shown alongside.
    universes: [all()],
    extras: [{ symbol: 'TSX', label: 'S&P/TSX 综合' }, { symbol: 'TX60', label: 'S&P/TSX 60' }],
  },
}

export const REGIONS = [
  { id: 'asia', label: '亚太' },
  { id: 'americas', label: '美洲' },
  { id: 'europe', label: '欧洲' },
] as const

export function isMarketId(v: unknown): v is MarketId {
  return typeof v === 'string' && (MARKET_IDS as readonly string[]).includes(v)
}
