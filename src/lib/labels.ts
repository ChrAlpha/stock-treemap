import type { Period } from '~shared/snapshot'

export const PERIOD_LABEL: Record<Period, string> = {
  d1: '今日',
  pre: '盘前',
  post: '盘后',
  d5: '5 日',
  m1: '1 月',
  m3: '3 月',
  ytd: '年初至今',
  y1: '1 年',
}

export const PERIOD_SHORT: Record<Period, string> = {
  d1: '今日',
  pre: '盘前',
  post: '盘后',
  d5: '5日',
  m1: '1月',
  m3: '3月',
  ytd: '今年',
  y1: '1年',
}
