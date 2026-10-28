/**
 * model-usage — Claude / Codex subscription usage at a glance (Hermes Desktop).
 *
 * Status bar: one double-ring gauge per provider.
 *   outer ring = 5-hour session window, inner ring = weekly window,
 *   provider letter in the middle (C = Claude, X = Codex).
 *   Color by REMAINING share: >50 green · 31–50 yellow · 11–30 orange · ≤10 red.
 * Click → popover with every window as a bar + reset countdown.
 *
 * Data: gateway `model.options` (the same usage cache the model picker uses; the
 * call also kicks a background refresh of the providers' usage APIs). Read-only:
 * this plugin never touches credentials. Gemini has no usage API in Hermes, so it
 * gets a link to Google AI Studio instead.
 */
import {
  cn, haptic, host, Popover, PopoverContent, PopoverTrigger, usePluginI18n, useQuery
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'model-usage'
const PROVIDERS = [
  { slug: 'anthropic', short: 'C', name: 'Claude' },
  { slug: 'openai-codex', short: 'X', name: 'Codex' }
]
const GEMINI_URL = 'https://aistudio.google.com/usage'

let pluginCtx = null

const STRINGS = {
  en: {
    remaining: pct => `${pct}% left`,
    noData: 'no data',
    tooltip: (name, s, w) => `${name}\nOuter ring · 5h: ${s}\nInner ring · weekly: ${w}`,
    chipTitle: 'Model usage — click for details',
    notSignedIn: 'Not signed in',
    loading: 'Loading usage…',
    authExpired: 'Sign-in expired',
    noWindows: 'No data yet',
    account: n => `Account ${n}`,
    gemini: 'View usage in AI Studio ↗',
    refreshing: 'Refreshing…',
    failed: 'Failed to load — click to retry',
    auto: 'Auto-refreshes every minute',
    resetSoon: 'Resets soon',
    resetIn: (d, h, m) => `Resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`
  },
  ko: {
    remaining: pct => `${pct}% 남음`,
    noData: '정보 없음',
    tooltip: (name, s, w) => `${name}\n바깥 원 · 5시간: ${s}\n안쪽 원 · 주간: ${w}`,
    chipTitle: '모델 사용량 — 클릭해서 상세 보기',
    notSignedIn: '로그인 안 됨',
    loading: '사용량 불러오는 중…',
    authExpired: '인증 만료',
    noWindows: '아직 데이터 없음',
    account: n => `계정 ${n}`,
    gemini: 'AI Studio에서 사용량 보기 ↗',
    refreshing: '새로고침 중…',
    failed: '불러오기 실패 — 다시 클릭',
    auto: '1분마다 자동 갱신',
    resetSoon: '곧 리셋',
    resetIn: (d, h, m) => `${d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`} 후 리셋`
  },
  ja: {
    remaining: pct => `残り${pct}%`,
    noData: '情報なし',
    tooltip: (name, s, w) => `${name}\n外側 · 5時間: ${s}\n内側 · 週間: ${w}`,
    chipTitle: 'モデル使用量 — クリックで詳細',
    notSignedIn: '未ログイン',
    loading: '使用量を読み込み中…',
    authExpired: '認証切れ',
    noWindows: 'データなし',
    account: n => `アカウント ${n}`,
    gemini: 'AI Studio で使用量を見る ↗',
    refreshing: '更新中…',
    failed: '読み込み失敗 — クリックで再試行',
    auto: '1分ごとに自動更新',
    resetSoon: 'まもなくリセット',
    resetIn: (d, h, m) => `${d ? `${d}日${h}時間` : h ? `${h}時間${m}分` : `${m}分`}後にリセット`
  }
}

function useUsage() {
  return useQuery({
    queryKey: ['model-usage-plugin'],
    queryFn: () => host.request('model.options', { explicit_only: true }),
    refetchInterval: 60_000,
    staleTime: 30_000
  })
}

// One list of {label, windows, state} per provider (pool → one row per account).
// Deduped: the same login often sits in a pool twice (e.g. a Claude Code import
// plus Hermes OAuth), which would otherwise render identical blocks.
function accountsOf(row) {
  const u = row && row.usage
  if (!u) return []
  const uniqWindows = ws => {
    const seen = new Set()
    return (ws || []).filter(w => (seen.has(w.label) ? false : (seen.add(w.label), true)))
  }
  let list
  if (Array.isArray(u.accounts) && u.accounts.length) {
    list = u.accounts.map((a, i) => ({ label: a.label || '', index: i + 1, windows: uniqWindows(a.windows), state: a.state }))
  } else {
    const ws = uniqWindows(u.windows)
    list = [{ label: '', index: 1, windows: ws, state: ws.length ? 'ready' : 'unknown' }]
  }
  const sig = a => JSON.stringify(a.windows.map(w => w.label))
  const seen = new Set()
  const out = list.filter(a => (a.windows.length && seen.has(sig(a)) ? false : (seen.add(sig(a)), true)))
  const real = out.filter(a => a.windows.length)
  // Claude: "Claude OAuth" and "Claude" pool rows are the same subscription → show one.
  if (row.slug === 'anthropic' && real.length > 1) return [{ ...real[0], label: '' }]
  return real.length ? real : out.slice(0, 1)
}

function remaining(w) {
  return Math.max(0, Math.min(100, Math.round(100 - Number(w.used_percent || 0))))
}

function resetText(t, iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!(ms > 0)) return t('resetSoon')
  const m = Math.round(ms / 60000)
  return t('resetIn', Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60)
}

// Color by remaining %: >50 green, 31–50 yellow, 11–30 orange, ≤10 red, unknown muted.
// Inline styles (not Tailwind classes): disk plugins aren't scanned by the app's CSS build.
function ringColor(pct) {
  if (pct === null || pct === undefined) return 'var(--ui-text-quaternary)'
  if (pct <= 10) return 'var(--ui-red,#e5484d)'
  if (pct <= 30) return 'var(--ui-orange,#f5a524)'
  if (pct <= 50) return 'var(--ui-yellow,#e2c400)'
  return 'var(--ui-green,#30a46c)'
}

function toneStyle(pct) {
  return pct === null || pct === undefined ? undefined : { color: ringColor(pct) }
}

// Double donut: outer = 5h session, inner = weekly, provider letter in the center.
function DualRing({ session, weekly, letter, size = 20 }) {
  const mid = size / 2
  const rings = [
    { pct: session, r: 8.6, w: 2.6 },
    { pct: weekly, r: 4.9, w: 2.2 }
  ]
  const kids = []
  rings.forEach(({ pct, r, w }, i) => {
    const c = 2 * Math.PI * r
    const filled = pct === null ? 0 : (pct / 100) * c
    kids.push(
      jsx('circle', { cx: mid, cy: mid, r, fill: 'none', stroke: 'var(--ui-stroke-secondary)', strokeWidth: w }, `t${i}`),
      jsx('circle', {
        cx: mid, cy: mid, r, fill: 'none',
        stroke: ringColor(pct), strokeWidth: w, strokeLinecap: 'round',
        strokeDasharray: `${filled} ${c}`,
        transform: `rotate(-90 ${mid} ${mid})`,
        style: { transition: 'stroke-dasharray 400ms ease, stroke 400ms ease' }
      }, `f${i}`)
    )
  })
  kids.push(jsx('text', {
    x: mid, y: mid + 2.4, textAnchor: 'middle', fontSize: 6.5, fontWeight: 800,
    fill: 'currentColor', children: letter
  }, 'l'))
  return jsx('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { flex: 'none' }, children: kids })
}

// Pick the 5h session and the account-wide weekly window out of a provider's windows.
function sessionWeekly(windows) {
  const ws = windows || []
  const isWeek = w => /week|주간|7d/i.test(w.label || '')
  const session = ws.find(w => /session|5h|5-hour|세션/i.test(w.label || '')) || ws.find(w => !isWeek(w)) || null
  const weekly = ws.find(w => isWeek(w) && w.scope !== 'model') || ws.find(isWeek) || null
  return { session, weekly }
}

function Bar({ w, t }) {
  const pct = remaining(w)
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2 text-[0.6875rem]',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: w.label }),
          jsx('span', { className: 'tabular-nums font-medium', style: toneStyle(pct), children: t('remaining', pct) })
        ]
      }),
      jsx('div', {
        className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-stroke-secondary)',
        children: jsx('div', {
          className: 'h-full rounded-full',
          style: { width: `${pct}%`, background: ringColor(pct), transition: 'width 400ms ease' }
        })
      }),
      w.resets_at
        ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: resetText(t, w.resets_at) })
        : null
    ]
  })
}

const muted = text => jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: text })

function ProviderBlock({ p, row, t }) {
  const accts = accountsOf(row)
  let body
  if (!row || !row.authenticated) body = muted(t('notSignedIn'))
  else if (accts.length === 0) body = muted(t('loading'))
  else {
    body = accts.map(a =>
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          accts.length > 1
            ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: a.label || t('account', a.index) })
            : null,
          a.windows.length
            ? a.windows.map((w, j) => jsx(Bar, { w, t }, j))
            : muted(a.state === 'unavailable' ? t('authExpired') : t('noWindows'))
        ]
      }, a.index)
    )
  }
  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [jsx('div', { className: 'text-xs font-semibold', children: p.name }), body]
  })
}

function openExternal(url) {
  const os = pluginCtx && pluginCtx.os
  if (os && os.openExternal) {
    os.openExternal(url).then(ok => { if (!ok) window.open(url, '_blank') })
  } else {
    window.open(url, '_blank')
  }
}

function Chip() {
  const t = usePluginI18n(ID)
  const q = useUsage()
  const rows = (q.data && q.data.providers) || []
  const bySlug = Object.fromEntries(rows.map(r => [r.slug, r]))

  const gauges = PROVIDERS.map(p => {
    const accts = accountsOf(bySlug[p.slug])
    // lowest remaining across accounts, per window type
    const pick = key => {
      const vals = accts.map(a => sessionWeekly(a.windows)[key]).filter(Boolean).map(remaining)
      return vals.length ? Math.min(...vals) : null
    }
    const s = pick('session')
    const w = pick('weekly')
    const fmt = v => (v === null ? t('noData') : t('remaining', v))
    return jsx('span', {
      className: 'inline-flex items-center',
      title: t('tooltip', p.name, fmt(s), fmt(w)),
      children: jsx(DualRing, { session: s, weekly: w, letter: p.short })
    }, p.slug)
  })

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          title: t('chipTitle'),
          onClick: () => {
            haptic('tap')
            q.refetch()
          },
          className: cn(
            'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          children: gauges.flatMap((el, i) =>
            i ? [jsx('span', { className: 'opacity-40', children: '·' }, `d${i}`), el] : [el]
          )
        })
      }),
      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        className: 'w-64',
        children: jsxs('div', {
          className: 'flex flex-col gap-3 p-1',
          children: [
            ...PROVIDERS.map(p => jsx(ProviderBlock, { p, row: bySlug[p.slug], t }, p.slug)),
            jsxs('div', {
              className: 'flex flex-col gap-1 border-t border-(--ui-stroke-secondary) pt-2',
              children: [
                jsx('div', { className: 'text-xs font-semibold', children: 'Gemini' }),
                jsx('button', {
                  type: 'button',
                  className: 'text-left text-[0.6875rem] text-(--ui-accent) hover:underline',
                  onClick: () => openExternal(GEMINI_URL),
                  children: t('gemini')
                })
              ]
            }),
            muted(q.isFetching ? t('refreshing') : q.isError ? t('failed') : t('auto'))
          ]
        })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Model Usage',
  register(ctx) {
    pluginCtx = ctx
    ctx.i18n.register(STRINGS)
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => jsx(Chip, {}) })
  }
}
