/**
 * model-usage — Claude / Codex subscription usage at a glance (Hermes Desktop).
 *
 * Status bar: one triple-ring gauge per provider, provider letter in the middle
 * (C = Claude, X = Codex). Every ring is filled with the REMAINING share:
 *   outer  (thin)    = context window of the focused chat (current provider only)
 *   middle (normal)  = 5-hour session window
 *   inner  (thinner) = weekly window
 * Color by remaining share: >50 green · 31–50 yellow · 11–30 orange · ≤10 red.
 * Click → popover with every window as a bar + reset countdown.
 *
 * Alerts: when a 5h / weekly window drops to ≤30% and again to ≤10% remaining,
 * one in-app toast plus one native OS notification (the OS one only shows while
 * Hermes is not focused). Each threshold fires once per window period.
 *
 * Data: gateway `model.options` (the same usage cache the model picker uses; the
 * call also kicks a background refresh of the providers' usage APIs) and the
 * focused session's live usage atom. Read-only: never touches credentials.
 * Gemini has no usage API in Hermes, so it gets a link to Google AI Studio.
 */
import {
  cn, haptic, host, Popover, PopoverContent, PopoverTrigger, usePluginI18n, useQuery, useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'model-usage'
const PROVIDERS = [
  { slug: 'anthropic', short: 'C', name: 'Claude' },
  { slug: 'openai-codex', short: 'X', name: 'Codex' }
]
const GEMINI_URL = 'https://aistudio.google.com/usage'
const ALERT_THRESHOLDS = [30, 10] // remaining %, high → low
const FIRED_KEY = 'firedAlerts'

let pluginCtx = null

const STRINGS = {
  en: {
    remaining: pct => `${pct}% left`,
    noData: 'no data',
    tooltip: (name, c, s, w) => `${name}\nOuter · context: ${c}\nMiddle · 5h: ${s}\nInner · weekly: ${w}`,
    chipTitle: 'Model usage — click for details',
    notSignedIn: 'Not signed in',
    loading: 'Loading usage…',
    authExpired: 'Sign-in expired',
    noWindows: 'No data yet',
    account: n => `Account ${n}`,
    context: 'Context (current chat)',
    gemini: 'View usage in AI Studio ↗',
    refreshing: 'Refreshing…',
    failed: 'Failed to load — click to retry',
    auto: 'Auto-refreshes every minute',
    resetSoon: 'Resets soon',
    resetIn: (d, h, m) => `Resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`,
    alertTitle: (name, label, pct) => `${name} ${label}: ${pct}% left`,
    alertBody: reset => (reset ? `${reset}.` : 'Usage limit is getting close.')
  },
  ko: {
    remaining: pct => `${pct}% 남음`,
    noData: '정보 없음',
    tooltip: (name, c, s, w) => `${name}\n바깥 · 컨텍스트: ${c}\n중간 · 5시간: ${s}\n안쪽 · 주간: ${w}`,
    chipTitle: '모델 사용량 — 클릭해서 상세 보기',
    notSignedIn: '로그인 안 됨',
    loading: '사용량 불러오는 중…',
    authExpired: '인증 만료',
    noWindows: '아직 데이터 없음',
    account: n => `계정 ${n}`,
    context: '컨텍스트 (현재 대화)',
    gemini: 'AI Studio에서 사용량 보기 ↗',
    refreshing: '새로고침 중…',
    failed: '불러오기 실패 — 다시 클릭',
    auto: '1분마다 자동 갱신',
    resetSoon: '곧 리셋',
    resetIn: (d, h, m) => `${d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`} 후 리셋`,
    alertTitle: (name, label, pct) => `${name} ${label}: ${pct}% 남음`,
    alertBody: reset => (reset ? `${reset}.` : '사용량 한도가 가까워졌어요.')
  },
  ja: {
    remaining: pct => `残り${pct}%`,
    noData: '情報なし',
    tooltip: (name, c, s, w) => `${name}\n外側 · コンテキスト: ${c}\n中間 · 5時間: ${s}\n内側 · 週間: ${w}`,
    chipTitle: 'モデル使用量 — クリックで詳細',
    notSignedIn: '未ログイン',
    loading: '使用量を読み込み中…',
    authExpired: '認証切れ',
    noWindows: 'データなし',
    account: n => `アカウント ${n}`,
    context: 'コンテキスト (現在の会話)',
    gemini: 'AI Studio で使用量を見る ↗',
    refreshing: '更新中…',
    failed: '読み込み失敗 — クリックで再試行',
    auto: '1分ごとに自動更新',
    resetSoon: 'まもなくリセット',
    resetIn: (d, h, m) => `${d ? `${d}日${h}時間` : h ? `${h}時間${m}分` : `${m}分`}後にリセット`,
    alertTitle: (name, label, pct) => `${name} ${label}: 残り${pct}%`,
    alertBody: reset => (reset ? `${reset}。` : '使用量の上限が近づいています。')
  }
}

function useUsage(sessionId) {
  return useQuery({
    queryKey: ['model-usage-plugin', sessionId || ''],
    queryFn: () =>
      host.request('model.options', sessionId ? { explicit_only: true, session_id: sessionId } : { explicit_only: true }),
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

function contextRemaining(usage) {
  if (!usage) return null
  let used = usage.context_percent
  if (typeof used !== 'number' && usage.context_max > 0 && typeof usage.context_used === 'number') {
    used = (usage.context_used / usage.context_max) * 100
  }
  return typeof used === 'number' && isFinite(used) ? Math.max(0, Math.min(100, Math.round(100 - used))) : null
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

// Triple donut: outer thin = context, middle = 5h session, inner thinner = weekly.
// `context === undefined` → the outer ring is not drawn (provider not in use).
function TripleRing({ context, session, weekly, letter, size = 24 }) {
  const mid = size / 2
  const rings = [
    { key: 'c', pct: context, r: 11.3, w: 1.3, skip: context === undefined },
    { key: 's', pct: session, r: 8.4, w: 2.6 },
    { key: 'w', pct: weekly, r: 5.2, w: 2.0 }
  ]
  const kids = []
  for (const { key, pct, r, w, skip } of rings) {
    if (skip) continue
    const c = 2 * Math.PI * r
    const filled = pct === null ? 0 : (pct / 100) * c
    kids.push(
      jsx('circle', { cx: mid, cy: mid, r, fill: 'none', stroke: 'var(--ui-stroke-secondary)', strokeWidth: w }, `t${key}`),
      jsx('circle', {
        cx: mid, cy: mid, r, fill: 'none',
        stroke: ringColor(pct), strokeWidth: w, strokeLinecap: 'round',
        strokeDasharray: `${filled} ${c}`,
        transform: `rotate(-90 ${mid} ${mid})`,
        style: { transition: 'stroke-dasharray 400ms ease, stroke 400ms ease' }
      }, `f${key}`)
    )
  }
  kids.push(jsx('text', {
    x: mid, y: mid + 2, textAnchor: 'middle', fontSize: 5.6, fontWeight: 800,
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

// Lowest remaining across a provider's accounts, per window kind; keeps the window
// object so alerts can read its label / reset time.
function providerWindows(row) {
  const accts = accountsOf(row)
  const pick = key => {
    let best = null
    for (const a of accts) {
      const w = sessionWeekly(a.windows)[key]
      if (w && (best === null || remaining(w) < remaining(best))) best = w
    }
    return best
  }
  return { session: pick('session'), weekly: pick('weekly') }
}

// ── threshold alerts ─────────────────────────────────────────────────────────
function checkAlerts(t, bySlug) {
  const ctx = pluginCtx
  if (!ctx) return
  const fired = new Set(ctx.storage.get(FIRED_KEY, []))
  let changed = false
  for (const p of PROVIDERS) {
    const row = bySlug[p.slug]
    if (!row || !row.authenticated) continue
    const { session, weekly } = providerWindows(row)
    for (const w of [session, weekly]) {
      if (!w) continue
      const pct = remaining(w)
      const period = `${p.slug}|${w.label}|${w.resets_at || ''}`
      const crossed = ALERT_THRESHOLDS.filter(th => pct <= th)
      if (!crossed.length) continue
      const fresh = crossed.filter(th => !fired.has(`${period}|${th}`))
      if (!fresh.length) continue
      // Mark every crossed threshold, announce only the most severe one.
      crossed.forEach(th => fired.add(`${period}|${th}`))
      changed = true
      const severe = Math.min(...crossed)
      const title = t('alertTitle', p.name, w.label, pct)
      const body = t('alertBody', resetText(t, w.resets_at))
      try {
        host.notify({ kind: severe <= 10 ? 'error' : 'warning', message: `${title} — ${body}` })
      } catch (_) {}
      try {
        if (ctx.os && ctx.os.notify) ctx.os.notify({ title, body })
      } catch (_) {}
    }
  }
  if (changed) ctx.storage.set(FIRED_KEY, Array.from(fired).slice(-200))
}

// ── UI ───────────────────────────────────────────────────────────────────────
function Bar({ label, pct, resetsAt, t }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2 text-[0.6875rem]',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: label }),
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
      resetsAt
        ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: resetText(t, resetsAt) })
        : null
    ]
  })
}

const muted = text => jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: text })

function ProviderBlock({ p, row, t, context }) {
  const accts = accountsOf(row)
  let body
  if (!row || !row.authenticated) body = [muted(t('notSignedIn'))]
  else if (accts.length === 0) body = [muted(t('loading'))]
  else {
    body = accts.map(a =>
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          accts.length > 1
            ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: a.label || t('account', a.index) })
            : null,
          a.windows.length
            ? a.windows.map((w, j) => jsx(Bar, { label: w.label, pct: remaining(w), resetsAt: w.resets_at, t }, j))
            : muted(a.state === 'unavailable' ? t('authExpired') : t('noWindows'))
        ]
      }, a.index)
    )
  }
  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('div', { className: 'text-xs font-semibold', children: p.name }),
      typeof context === 'number' ? jsx(Bar, { label: t('context'), pct: context, t }, 'ctx') : null,
      ...body
    ]
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
  const sessionId = useValue(host.state.focusedSessionId)
  const usage = useValue(host.state.focusedUsage)
  const q = useUsage(sessionId)
  const rows = (q.data && q.data.providers) || []
  const bySlug = Object.fromEntries(rows.map(r => [r.slug, r]))
  const current = String((q.data && q.data.provider) || '').toLowerCase()
  const ctxLeft = contextRemaining(usage)

  useEffect(() => {
    if (rows.length) checkAlerts(t, bySlug)
  }, [q.dataUpdatedAt])

  const gauges = PROVIDERS.map(p => {
    const { session, weekly } = providerWindows(bySlug[p.slug])
    const s = session ? remaining(session) : null
    const w = weekly ? remaining(weekly) : null
    const isCurrent = p.slug === current
    const c = isCurrent ? ctxLeft : undefined
    const fmt = v => (v === null || v === undefined ? t('noData') : t('remaining', v))
    return jsx('span', {
      className: 'inline-flex items-center',
      title: t('tooltip', p.name, isCurrent ? fmt(c) : '—', fmt(s), fmt(w)),
      children: jsx(TripleRing, { context: c, session: s, weekly: w, letter: p.short })
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
            ...PROVIDERS.map(p =>
              jsx(ProviderBlock, {
                p, row: bySlug[p.slug], t,
                context: p.slug === current && ctxLeft !== null ? ctxLeft : undefined
              }, p.slug)
            ),
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
