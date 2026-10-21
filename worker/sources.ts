import type { MarketId } from '../shared/markets'
import type { QuoteSource } from '../shared/snapshot'
import type { BackupQuotes } from './nasdaq'
import { fetchNasdaqQuotes } from './nasdaq'

// How each market is fetched: TradingView's screener, plus a backup where one
// exists. One market's refresh touches only its own scanner, so opening one
// market never pulls another.

type Filter = { left: string, operation: string, right?: unknown }

export interface IndexTicker {
  ticker: string
  /** `IndexQuote.symbol`, matched by shared/markets.ts. */
  symbol: string
}

export interface Source {
  /** scanner.tradingview.com/{scanner}/scan */
  scanner: string
  /** Name language: `zh` gives Chinese names for A-shares, `zh_TW` for Hong Kong and Taiwan. */
  lang: string
  filter: Filter[]
  filter2?: unknown
  /** Largest N by market cap. Bounds the response, and so the CPU spent parsing it. */
  limit: number
  /** Fewer rows than this means a truncated or broken response. */
  minRows: number
  /** Request pre/post-market changes. Elsewhere those columns mean opening/closing auctions. */
  extended: boolean
  /** Scanner the index tickers resolve on. */
  indexScanner: string
  indices: IndexTicker[]
  /** Listing to read the session state from when there's no index quote. Defaults to the first index. */
  probe?: string
  /** Universe id → TradingView symbol set of the index's constituents, and the least a full list has. */
  membership: Record<string, { set: string, min: number }>
  /** Daily change from elsewhere, for when TradingView has been down since before the latest session. */
  backup?: { source: QuoteSource, fetch: () => Promise<BackupQuotes> }
}

/** Common stock. DRs are left out: they carry the parent's whole market cap. */
const STOCK: Filter[] = [
  { left: 'type', operation: 'equal', right: 'stock' },
  { left: 'subtype', operation: 'nequal', right: 'preferred' },
  { left: 'market_cap_basic', operation: 'greater', right: 0 },
]

const only = (left: string, right: unknown): Filter =>
  ({ left, operation: Array.isArray(right) ? 'in_range' : 'equal', right })

/**
 * One row per company where the scanner also lists other venues' copies
 * (Nagoya, BSE, LSE's international order book, German regional exchanges).
 * Where a market's own big names are "non-primary" because they list first
 * elsewhere, filter by venue and currency instead.
 */
const PRIMARY = [...STOCK, only('is_primary', true)]

function market(scanner: string, limit: number, rest: Partial<Source> & Pick<Source, 'indices' | 'membership'>): Source {
  return {
    scanner,
    lang: 'en',
    filter: PRIMARY,
    limit,
    minRows: Math.round(limit / 2),
    extended: false,
    indexScanner: scanner,
    ...rest,
  }
}

const idx = (ticker: string, symbol = ticker.slice(ticker.indexOf(':') + 1)): IndexTicker => ({ ticker, symbol })

export const SOURCES: Record<MarketId, Source> = {
  us: {
    scanner: 'america',
    lang: 'en',
    // US-listed common stock and listed ADRs above $1B, one row per company.
    filter: [
      { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
      { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
      { left: 'type', operation: 'in_range', right: ['stock', 'dr'] },
      { left: 'subtype', operation: 'nequal', right: 'preferred' },
    ],
    // Primary listings only (drops GOOGL next to GOOG), but keep foreign companies whose primary listing is abroad.
    filter2: {
      operator: 'and',
      operands: [{
        operation: {
          operator: 'or',
          operands: [
            { expression: { left: 'is_primary', operation: 'equal', right: true } },
            { expression: { left: 'type', operation: 'equal', right: 'dr' } },
            // Foreign companies cross-listed as common stock (RY, AZN, TRI).
            { expression: { left: 'country', operation: 'nequal', right: 'United States' } },
          ],
        },
      }],
    },
    limit: 4000,
    minRows: 1000,
    extended: true,
    indexScanner: 'global',
    indices: [idx('SP:SPX'), idx('NASDAQ:NDX'), idx('DJ:DJI'), idx('TVC:RUT'), idx('TVC:VIX')],
    // Expected sizes: 503 / 101 / 30 listings; anything well short means a truncated response.
    membership: {
      sp500: { set: 'SYML:SP;SPX', min: 480 },
      ndx: { set: 'SYML:NASDAQ;NDX', min: 95 },
      dji: { set: 'SYML:DJ;DJI', min: 29 },
    },
    backup: { source: 'nasdaq', fetch: fetchNasdaqQuotes },
  },
  cn: market('china', 2500, {
    lang: 'zh',
    // SMIC's A-shares are "non-primary" (Hong Kong comes first); B-shares, in HKD and USD, duplicate A-shares.
    filter: [...STOCK, only('currency', 'CNY')],
    indices: [idx('SSE:000300', 'CSI300'), idx('SSE:000001', 'SSEC'), idx('SZSE:399001', 'SZI'), idx('SZSE:399006', 'CHINEXT')],
    membership: { csi300: { set: 'SYML:SSE;000300', min: 280 } },
  }),
  hk: market('hongkong', 1500, {
    lang: 'zh_TW',
    // H-shares, Alibaba, JD, HSBC… are "non-primary" (their first listing is elsewhere); RMB counters (80700…) duplicate HKD ones.
    filter: [...STOCK, only('exchange', 'HKEX'), only('currency', 'HKD')],
    indices: [idx('HSI:HSI'), idx('HSI:HSTECH'), idx('HSI:HSCEI')],
    membership: {
      hsi: { set: 'SYML:HSI;HSI', min: 70 },
      hstech: { set: 'SYML:HSI;HSTECH', min: 28 },
    },
  }),
  jp: market('japan', 2000, {
    indices: [idx('TVC:NI225', 'N225'), idx('TSE:TOPIX')],
    membership: { n225: { set: 'SYML:TVC;NI225', min: 210 } },
  }),
  kr: market('korea', 1500, {
    indices: [idx('KRX:KOSPI200'), idx('KRX:KOSDAQ150'), idx('KRX:KOSPI'), idx('KRX:KOSDAQ')],
    membership: {
      kospi200: { set: 'SYML:KRX;KOSPI200', min: 190 },
      kosdaq150: { set: 'SYML:KRX;KOSDAQ150', min: 140 },
    },
  }),
  tw: market('taiwan', 1200, {
    lang: 'zh_TW',
    indices: [idx('FTSE:TW50'), idx('TWSE:IX0001', 'TAIEX')],
    membership: { tw50: { set: 'SYML:FTSE;TW50', min: 45 } },
  }),
  in: market('india', 1500, {
    indices: [idx('NSE:NIFTY'), idx('BSE:SENSEX')],
    membership: { nifty50: { set: 'SYML:NSE;NIFTY', min: 45 } },
  }),
  sg: market('singapore', 300, {
    indexScanner: 'global',
    indices: [idx('TVC:STI')],
    membership: { sti: { set: 'SYML:TVC;STI', min: 27 } },
  }),
  au: market('australia', 800, {
    // Rio Tinto Limited and the New Zealand dual listings are "non-primary".
    filter: [...STOCK, only('exchange', 'ASX')],
    indices: [],
    probe: 'ASX:BHP',
    membership: { asx200: { set: 'SYML:ASX;XJO', min: 180 } },
  }),
  uk: market('uk', 600, {
    indices: [idx('FTSE:UKX')],
    membership: { ftse100: { set: 'SYML:TVC;UKX', min: 90 } },
  }),
  de: market('germany', 300, {
    indices: [idx('XETR:DAX')],
    membership: { dax: { set: 'SYML:XETR;DAX', min: 36 } },
  }),
  fr: market('france', 300, {
    indices: [idx('EURONEXT:PX1')],
    membership: { cac40: { set: 'SYML:EURONEXT;PX1', min: 36 } },
  }),
  ca: market('canada', 800, {
    // Shopify and Brookfield are "non-primary" (New York comes first); NEO and USD (.U) lines duplicate TSX ones.
    filter: [...STOCK, only('exchange', ['TSX', 'TSXV']), only('currency', 'CAD')],
    indices: [idx('TSX:TSX'), idx('TSX:TX60')],
    membership: {},
  }),
}
