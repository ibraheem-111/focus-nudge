import { getInsights, isDown } from './api.js'
import { dayKey, dayKeysBack, sumDays, calendarWeeks, heatLevel, pct, weekly } from './insights-model.js'

// Every number on this page comes from GET /insights; nothing here reads the
// log or decides anything. Built with createElement / createElementNS only:
// site names come from the user's browsing, so no markup is ever parsed.

const el = id => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SERIES = {
  blocks: { label: 'blocks completed', color: 'var(--series-blocks)' },
  continued: { label: 'continued anyway', color: 'var(--series-continued)' },
  nudgeOffs: { label: 'nudging switched off', color: 'var(--series-off)' },
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'style') Object.assign(node.style, v)
    else if (k.startsWith('data-')) node.setAttribute(k, v)
    else node[k] = v
  }
  node.append(...children.filter(c => c !== null && c !== undefined))
  return node
}

function s(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const hours = minutes => (minutes >= 60 ? `${fmt(Math.round(minutes / 6) / 10)}h` : `${Math.round(minutes)}m`)
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`
const prettyDay = key => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

// --- tooltip ----------------------------------------------------------------
// One tooltip for the page, driven by data-tip on any mark or hit target.
const tip = el('tip')
document.addEventListener('pointermove', e => {
  const target = e.target.closest?.('[data-tip]')
  if (!target) { tip.hidden = true; return }
  tip.textContent = target.getAttribute('data-tip')
  tip.hidden = false
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)
  const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
})
document.addEventListener('pointerleave', () => { tip.hidden = true })

function legend(target, keys) {
  target.replaceChildren(...keys.map(k =>
    h('span', {}, h('i', { class: 'swatch', style: { background: SERIES[k].color } }), SERIES[k].label)))
}

// --- grouped vertical bars ----------------------------------------------------
// One y-axis, shared by every series: they are all counts of the same unit.
function groupedBars(target, { categories, keys, value, label, tipFor, labelEvery = 1, height = 170 }) {
  const pad = { l: 28, r: 6, t: 8, b: 20 }
  // Fill the card: the step comes from the space actually available.
  const avail = Math.max(240, target.clientWidth || 720)
  const step = Math.max(8, Math.min(48, (avail - pad.l - pad.r) / categories.length))
  const width = pad.l + pad.r + step * categories.length
  const plotH = height - pad.t - pad.b
  const max = Math.max(1, ...categories.flatMap(c => keys.map(k => value(c, k))))
  const nice = niceMax(max)
  const y = v => pad.t + plotH - (v / nice) * plotH

  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' })
  for (const t of [0, nice / 2, nice]) {
    svg.append(s('line', { class: 'gridline', x1: pad.l, x2: width - pad.r, y1: y(t), y2: y(t) }))
    const txt = s('text', { x: pad.l - 5, y: y(t) + 3, 'text-anchor': 'end' })
    txt.textContent = fmt(t)
    svg.append(txt)
  }
  const gap = 2
  const barW = Math.max(2, (step - 4 - gap * (keys.length - 1)) / keys.length)
  categories.forEach((c, i) => {
    const x0 = pad.l + i * step + 2
    keys.forEach((k, j) => {
      const v = value(c, k)
      if (v <= 0) return
      const top = y(v)
      svg.append(roundedTop(x0 + j * (barW + gap), top, barW, pad.t + plotH - top, SERIES[k].color))
    })
    const hit = s('rect', { class: 'hit', x: pad.l + i * step, y: pad.t, width: step, height: plotH, 'data-tip': tipFor(c) })
    svg.append(hit)
    if (i % labelEvery === 0) {
      const txt = s('text', { x: pad.l + i * step + step / 2, y: height - 6, 'text-anchor': 'middle' })
      txt.textContent = label(c)
      svg.append(txt)
    }
  })
  svg.setAttribute('aria-label', `${keys.map(k => SERIES[k].label).join(' and ')} by ${categories.length} categories`)
  target.replaceChildren(svg)
}

// A bar with 4px rounding on the data end only, square on the baseline.
function roundedTop(x, y, w, hgt, fill) {
  const r = Math.min(4, w / 2, hgt)
  const d = `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`
  return s('path', { d, fill, style: 'pointer-events:none' })
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.max(2, m * p)
  return v
}

// --- horizontal bars with direct labels --------------------------------------
function hbars(target, rows, { kind = '', empty = 'nothing recorded yet' } = {}) {
  const max = Math.max(0, ...rows.map(r => r.value))
  if (max === 0) { target.replaceChildren(h('p', { class: 'empty' }, empty)); return }
  const grid = h('div', { class: 'hbars' })
  for (const r of rows) {
    grid.append(
      h('span', { class: 'name' }, r.name),
      h('div', {}, r.value > 0
        ? h('div', { class: `hbar ${r.kind ?? kind}`, style: { width: `${(r.value / max) * 100}%` }, 'data-tip': r.tip ?? `${r.name}: ${fmt(r.value)}` })
        : null),
      h('span', { class: 'val' }, r.label ?? fmt(r.value)),
    )
  }
  target.replaceChildren(grid)
}

// --- sections ----------------------------------------------------------------

function renderKpis(data, keys) {
  const range = sumDays(data.byDay, keys)
  const shown = data.funnel.shown
  const tiles = [
    ['Focus time', hours(range.focusMinutes), `${hours(data.kpis.focusMinutes.today)} today`],
    ['Blocks completed', fmt(range.blocks), `${data.kpis.blocks.today} today · ${data.kpis.blocks.last7} this week`],
    ['Streak', plural(data.kpis.streak.current, 'day'), `best ${plural(data.kpis.streak.best, 'day')}`],
    ['Turned back', shown ? `${pct(data.funnel.back, shown)}%` : '—', shown ? `of ${plural(shown, 'nudge')}` : 'tracked from now on'],
    ['Continued anyway', fmt(data.kpis.continued), topSite(data.bySite)],
    ['Nudging off', hours(data.kpis.nudgeOffHours * 60), plural(data.kpis.nudgeOffs, 'time')],
    ['Tasks done', fmt(data.kpis.tasksDone), `${data.kpis.tasksAdded} added`],
  ]
  el('kpis').replaceChildren(...tiles.map(([label, value, sub]) =>
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub))))
}

function topSite(bySite) {
  const [name, row] = Object.entries(bySite).sort((a, b) => b[1].continued - a[1].continued)[0] ?? []
  return row?.continued ? `most on ${name}` : 'none in this range'
}

function renderCalendar(data) {
  const weeks = calendarWeeks(new Date(), 26)
  const values = weeks.flat().filter(Boolean).map(k => data.byDay[k]?.blocks ?? 0)
  const max = Math.max(0, ...values)
  const gap = 3, left = 28, top = 14
  const avail = Math.max(240, el('calendar').clientWidth || 600)
  const cell = Math.max(8, Math.min(20, Math.floor((avail - left) / weeks.length - gap)))
  const width = left + weeks.length * (cell + gap)
  const height = top + 7 * (cell + gap)
  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'completed blocks per day, last 26 weeks' })
  for (const [row, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    const t = s('text', { x: 0, y: top + row * (cell + gap) + cell - 3 })
    t.textContent = name
    svg.append(t)
  }
  let lastMonth = null
  weeks.forEach((week, w) => {
    const first = week.find(Boolean)
    const month = first && new Date(`${first}T12:00:00`).toLocaleDateString(undefined, { month: 'short' })
    if (month && month !== lastMonth) {
      const t = s('text', { x: left + w * (cell + gap), y: 10 })
      t.textContent = month
      svg.append(t)
      lastMonth = month
    }
    week.forEach((key, d) => {
      if (!key) return
      const day = data.byDay[key]
      const v = day?.blocks ?? 0
      const tipText = `${prettyDay(key)}\n${plural(v, 'block')}${day ? ` · ${hours(day.focusMinutes)} focus\n${plural(day.continued, 'continue')} anyway` : ''}`
      svg.append(s('rect', {
        x: left + w * (cell + gap), y: top + d * (cell + gap), width: cell, height: cell, rx: 3,
        fill: `var(--heat-${heatLevel(v, max)})`, 'data-tip': tipText,
      }))
    })
  })
  el('calendar').replaceChildren(svg)
  const steps = [0, 1, 2, 3, 4].map(l => h('i', { class: 'swatch', style: { background: `var(--heat-${l})` } }))
  el('calendar-legend').replaceChildren(h('span', {}, 'none', ...steps, max ? `${max} blocks` : 'more'))
}

function renderTrend(data, keys, rangeLabel) {
  const folded = keys.length > 45
  const rows = folded
    ? weekly(data.byDay, keys).map(w => ({ key: w.start, label: w.start.slice(5), blocks: w.blocks, continued: w.continued, tip: `week from ${prettyDay(w.start)}\n${plural(w.blocks, 'block')}\n${plural(w.continued, 'continue')} anyway` }))
    : keys.map(k => {
      const d = data.byDay[k]
      return { key: k, label: k.slice(8), blocks: d?.blocks ?? 0, continued: d?.continued ?? 0, tip: `${prettyDay(k)}\n${plural(d?.blocks ?? 0, 'block')}\n${plural(d?.continued ?? 0, 'continue')} anyway` }
    })
  el('trend-title').textContent = `Blocks and continue-anyway, ${folded ? 'by week' : 'by day'} — ${rangeLabel}`
  legend(el('trend-legend'), ['blocks', 'continued'])
  groupedBars(el('trend'), {
    categories: rows, keys: ['blocks', 'continued'], value: (r, k) => r[k], label: r => r.label,
    tipFor: r => r.tip, labelEvery: Math.ceil(rows.length / 16),
  })
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, folded ? 'week from' : 'day'), h('th', {}, 'blocks'), h('th', {}, 'continued'))),
    h('tbody', {}, ...rows.slice().reverse().map(r => h('tr', {}, h('td', {}, r.key), h('td', {}, fmt(r.blocks)), h('td', {}, fmt(r.continued))))))
  el('trend-table').replaceChildren(table)
}

function renderHours(data) {
  const keys = ['blocks', 'continued', 'nudgeOffs']
  legend(el('hour-legend'), keys)
  groupedBars(el('hours'), {
    categories: data.byHour.map((v, hour) => ({ hour, ...v })), keys,
    value: (c, k) => c[k], label: c => String(c.hour), labelEvery: 3, height: 160,
    tipFor: c => `${String(c.hour).padStart(2, '0')}:00–${String(c.hour + 1).padStart(2, '0')}:00\n${plural(c.blocks, 'block')}\n${plural(c.continued, 'continue')} anyway\nnudging off ${plural(c.nudgeOffs, 'time')}`,
  })
}

function renderWeekdays(data) {
  const keys = ['blocks', 'continued']
  legend(el('weekday-legend'), keys)
  // Monday first: the working week reads left to right.
  const order = [1, 2, 3, 4, 5, 6, 0]
  groupedBars(el('weekdays'), {
    categories: order.map(d => ({ d, ...data.byWeekday[d] })), keys,
    value: (c, k) => c[k], label: c => WEEKDAYS[c.d], height: 160,
    tipFor: c => `${WEEKDAYS[c.d]}\n${plural(c.blocks, 'block')}\n${plural(c.continued, 'continue')} anyway`,
  })
}

function renderSites(data) {
  const rows = Object.entries(data.bySite).sort((a, b) => (b[1].continued + b[1].shown) - (a[1].continued + a[1].shown))
  if (!rows.length) { el('sites').replaceChildren(h('p', { class: 'empty' }, 'no site activity in this range')); return }
  const max = Math.max(1, ...rows.map(([, r]) => r.continued))
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ...['site', 'nudged', 'turned back', 'continued anyway', '', 'saved for later'].map(t => h('th', {}, t)))),
    h('tbody', {}, ...rows.map(([name, r]) => h('tr', {},
      h('td', {}, name),
      h('td', {}, fmt(r.shown)),
      h('td', {}, r.shown ? `${fmt(r.back)} (${pct(r.back, r.shown)}%)` : fmt(r.back)),
      h('td', {}, fmt(r.continued)),
      h('td', { class: 'barcell' }, r.continued > 0
        ? h('div', { class: 'hbar continued', style: { width: `${(r.continued / max) * 100}%` }, 'data-tip': `${name}: continued anyway ${plural(r.continued, 'time')}` })
        : null),
      h('td', {}, fmt(r.saved)),
    ))))
  el('sites').replaceChildren(table)
}

function renderFunnel(data) {
  const f = data.funnel
  const of = v => (f.shown ? `${fmt(v)} · ${pct(v, f.shown)}%` : fmt(v))
  hbars(el('funnel'), [
    { name: 'shown', value: f.shown },
    { name: 'turned back', value: f.back, label: of(f.back) },
    { name: 'saved for later', value: f.saved, label: of(f.saved) },
    { name: 'continued anyway', value: f.continued, label: of(f.continued), kind: 'continued' },
  ])
  el('funnel-note').textContent = data.shownTrackedSince
    ? `“shown” and “turned back” are recorded since ${prettyDay(dayKey(new Date(data.shownTrackedSince)))}; older visits only logged continue and save.`
    : '“shown” and “turned back” are recorded from this version on; older visits only logged continue and save.'
}

function renderOutcomes(data) {
  const o = data.blockOutcomes
  const total = o.completed + o.stopped + o.nudgeOff
  const label = v => (total ? `${fmt(v)} · ${pct(v, total)}%` : fmt(v))
  hbars(el('outcomes'), [
    { name: 'completed', value: o.completed, label: label(o.completed) },
    { name: 'stopped', value: o.stopped, label: label(o.stopped) },
    { name: 'ended by a snooze (old version)', value: o.nudgeOff, label: label(o.nudgeOff) },
  ], { empty: 'no finished work blocks in this range' })
}

function renderDurations(data) {
  const order = label => (label === 'until on' ? Infinity : parseFloat(label))
  const rows = Object.entries(data.nudgeOffDurations).sort((a, b) => order(a[0]) - order(b[0]))
    .map(([name, value]) => ({ name, value, tip: `${name}: ${plural(value, 'time')}` }))
  hbars(el('durations'), rows, { kind: 'off', empty: 'nudging was not switched off in this range' })
}

// --- load --------------------------------------------------------------------

const RANGE_LABEL = { 7: 'last 7 days', 30: 'last 30 days', 90: 'last 90 days', all: 'all time' }

let last = null   // the payload on screen, re-drawn when the window resizes

async function load() {
  const choice = el('range').value
  const days = choice === 'all' ? null : Number(choice)
  const data = await getInsights(days)
  el('down').hidden = !isDown(data)
  if (isDown(data)) return
  last = { data, days, choice }
  draw()
}

function draw() {
  const { data, days, choice } = last

  const first = data.firstAt ? new Date(data.firstAt) : new Date()
  const spanDays = days ?? Math.max(1, Math.round((Date.now() - first.getTime()) / 86_400_000) + 1)
  const keys = dayKeysBack(new Date(), spanDays)

  el('span').textContent = data.firstAt
    ? `history since ${prettyDay(dayKey(first))} · work block ${data.workMinutes} min`
    : 'no history yet'
  renderKpis(data, keys)
  renderCalendar(data)
  renderTrend(data, keys, RANGE_LABEL[choice])
  renderHours(data)
  renderWeekdays(data)
  renderSites(data)
  renderFunnel(data)
  renderOutcomes(data)
  renderDurations(data)
}

try {
  const saved = localStorage.getItem('insightsRange')
  if (saved && RANGE_LABEL[saved]) el('range').value = saved
} catch {}
el('range').addEventListener('change', () => {
  try { localStorage.setItem('insightsRange', el('range').value) } catch {}
  let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (last) draw() }, 150)
})
load()
})
load()
