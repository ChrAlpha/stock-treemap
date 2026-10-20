import { defineConfig, presetWind4, transformerDirectives } from 'unocss'

// Palette: 月白 paper, 黛 ink. Up/down pigments live in src/lib/scale.ts.
export default defineConfig({
  presets: [presetWind4()],
  transformers: [transformerDirectives()],
  theme: {
    colors: {
      paper: { DEFAULT: '#f1f7f8', deep: '#e5edef', card: '#fbfdfd' },
      ink: { DEFAULT: '#1c232d', 2: '#4b535c', 3: '#7a8187' },
      rule: { DEFAULT: '#dbe1e4', soft: '#e6ebed' },
    },
    font: {
      sans: '"Mona Sans Variable", "PingFang SC", "Hiragino Sans GB", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    },
  },
  shortcuts: {
    'tnum': '[font-variant-numeric:tabular-nums]',
    'focus-ring': 'outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ink focus-visible:outline-offset-2',
    'chip': 'focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ink-2 transition-colors duration-150 hover:text-ink hover:bg-paper-deep',
  },
})
