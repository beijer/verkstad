// Reading what verkstad leaves behind, as plain data for the pane.
//
// A Run's event log, `run-<time>.jsonl` in the log directory, is one JSON object per line, each with `at`,
// written by `verkstad run` (src/run.ts). A Ticket's lines carry `ticket`: `say` is the line the Run printed,
// `claimed` and `tier` its claim, `session` a session's ending with its `cost`, `landed` (with `commit`),
// `parked` and `aborted` its outcome. `run` is `started` (with `ready` and `pid`), then `finished`, `stopped`
// (with `error`) or `aborted`; `asked` is the owner asking the Run to `stop` or `abort`.

import type { Attention, FrontierEntry, FrontierView, RunSummary, RunTicket, RunView } from '../../types'

type Event = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export function firstLine(text: string, max = 160): string {
  return clip(text.split('\n').map(l => l.trim()).find(Boolean) ?? '', max)
}

/** The log's complete lines as events; a line cut mid-write, or not JSON, is skipped. */
export function readEvents(text: string): Event[] {
  const events: Event[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object') events.push(e)
    } catch {
      // the Run is writing it
    }
  }
  return events
}

export function runView(file: string, events: Event[]): RunView {
  const view: RunView = {
    file,
    startedAt: str(events[0]?.at),
    lastAt: str(events[events.length - 1]?.at),
    pid: null,
    asked: null,
    ended: null,
    ready: [],
    tickets: [],
    current: null,
    sessions: 0,
    cost: 0,
  }
  const tickets = new Map<number, RunTicket>()
  for (const e of events) {
    if (e.run === 'started') {
      if (Array.isArray(e.ready)) view.ready = e.ready.filter((n): n is number => typeof n === 'number')
      if (typeof e.pid === 'number') view.pid = e.pid
    }
    if (e.asked === 'stop' && view.asked === null) view.asked = 'stop'
    if (e.asked === 'abort') view.asked = 'abort'
    const end = e.run
    if (end === 'finished' || end === 'stopped' || end === 'aborted') {
      view.ended = { kind: end, at: str(e.at), error: firstLine(str(e.error)) }
      view.current = null
    }
    if (typeof e.ticket !== 'number') continue
    let t = tickets.get(e.ticket)
    if (!t) {
      t = { n: e.ticket, title: '', tier: '', say: '', sayAt: '', cost: 0, outcome: null, detail: '' }
      tickets.set(e.ticket, t)
    }
    if (typeof e.claimed === 'string') t.title = e.claimed
    if (typeof e.tier === 'string') t.tier = e.tier
    if (typeof e.say === 'string') {
      t.say = e.say
      t.sayAt = str(e.at)
    }
    if (typeof e.session === 'string') {
      t.cost += num(e.cost)
      view.cost += num(e.cost)
      view.sessions++
    }
    if (typeof e.landed === 'string') {
      t.outcome = 'landed'
      t.detail = str(e.commit) || e.landed
    }
    if (typeof e.parked === 'string') {
      t.outcome = 'parked'
      t.detail = firstLine(e.parked)
    }
    if (typeof e.aborted === 'string') {
      t.outcome = 'aborted'
      t.detail = firstLine(e.aborted)
    }
    view.current = t.outcome || view.ended ? null : t.n
  }
  view.tickets = [...tickets.values()]
  return view
}

export function runSummary(view: RunView): RunSummary {
  const count = (o: RunTicket['outcome']) => view.tickets.filter(t => t.outcome === o).length
  return {
    file: view.file,
    startedAt: view.startedAt,
    lastAt: view.lastAt,
    ending: view.ended?.kind ?? 'open',
    askedStop: view.asked === 'stop',
    landed: count('landed'),
    parked: count('parked'),
    aborted: count('aborted'),
    cost: view.cost,
    error: view.ended?.error ?? '',
    tickets: view.tickets,
  }
}

/** What the Ticket is doing, from the Run's last line about it, in a few words. */
export function phase(say: string): string {
  const phases: Array<[RegExp, string]> = [
    [/: claimed, /, 'claimed'],
    [/^implementing in /, 'implementing'],
    [/^Resuming on the /, 'implementing (Resume)'],
    [/^Fix round/, 'fixing (Fix round)'],
    [/resuming the implementer's session to review/, 'reviewing'],
    [/asking it to commit and report/, 'wrapping up'],
    [/^implementer reported /, 'routing'],
    [/the Verifier Walks it/, 'verifying'],
    [/^Verdict: /, 'routing'],
    [/landing\.$/, 'landing'],
    [/^conflicts with /, 'finishing a conflict'],
  ]
  return phases.find(([pattern]) => pattern.test(say))?.[1] ?? firstLine(say, 48)
}

export const STAGES = ['claim', 'build', 'verify', 'land'] as const

/** Which of STAGES a phase is in. */
export function stage(p: string): number {
  if (p === 'claimed') return 0
  if (p === 'verifying') return 2
  if (p === 'landing') return 3
  return 1
}

type ListingEntry = {
  number: number
  title: string
  labels: string[]
  assignees: string[]
  open_blockers: Array<{ number: number; labels: string[] }>
}

const OWNER_MARKERS: Array<[string, string]> = [
  ['ready-for-human', '[human]'],
  ['needs-info', '[needs-info]'],
]

function entry(e: ListingEntry): FrontierEntry {
  const tier = e.labels.find(l => /^tier:/.test(l))?.slice(5) ?? 'standard'
  const waitsOn = e.open_blockers.map(b => {
    const marker = OWNER_MARKERS.find(([label]) => b.labels.includes(label))?.[1]
    return marker ? `#${b.number} ${marker}` : `#${b.number}`
  })
  return { n: e.number, title: e.title, tier, assignees: e.assignees, waitsOn }
}

/** `verkstad frontier --json`'s listing. */
export function frontierView(json: string, at: number): FrontierView {
  const listing = JSON.parse(json) as Record<string, ListingEntry[]>
  const list = (key: string) => (listing[key] ?? []).map(entry)
  return {
    ready: list('ready'),
    inProgress: list('in_progress'),
    waiting: list('waiting'),
    specsLabelled: (listing.specs_labelled ?? []).map(e => e.number),
    at,
    error: '',
  }
}

type Issue = { number: number; title: string; labels: Array<{ name: string }> }
type Pull = { number: number; title: string; headRefName: string; url: string }
type CiRun = { name: string; status: string; conclusion: string; headSha: string; url: string }

/**
 * What waits on the owner: a red CI on the base branch, a Ticket's pull request to merge, issues labelled for
 * the owner, Tickets claimed with no Run working them, and Specs labelled as if an agent could take them.
 */
export function attention(
  input: { issues: Issue[]; pulls: Pull[]; ci: CiRun[]; frontier: FrontierView | null; repo: string; base: string; working: number | null },
): Attention[] {
  const href = (n: number) => (input.repo ? `https://github.com/${input.repo}/issues/${n}` : null)
  const items: Attention[] = []
  const ci = input.ci.find(r => r.status === 'completed')
  if (ci && ci.conclusion !== 'success' && ci.conclusion !== 'skipped') {
    items.push({ kind: 'ci', n: null, text: `CI ${ci.conclusion} on ${input.base} at ${ci.headSha.slice(0, 7)} (${ci.name})`, href: ci.url || null })
  }
  for (const p of input.pulls) {
    if (/^issue-\d+$/.test(p.headRefName)) items.push({ kind: 'pr', n: p.number, text: `merge: ${p.title}`, href: p.url || href(p.number) })
  }
  const has = (i: Issue, label: string) => i.labels.some(l => l.name === label)
  for (const i of input.issues) {
    if (has(i, 'needs-info')) items.push({ kind: 'info', n: i.number, text: i.title, href: href(i.number) })
  }
  for (const i of input.issues) {
    if (has(i, 'ready-for-human')) items.push({ kind: 'human', n: i.number, text: i.title, href: href(i.number) })
  }
  for (const t of input.frontier?.inProgress ?? []) {
    if (t.n !== input.working) items.push({ kind: 'claimed', n: t.n, text: `claimed, but no Run works it: ${t.title}`, href: href(t.n) })
  }
  for (const n of input.frontier?.specsLabelled ?? []) {
    items.push({ kind: 'spec', n, text: 'a Spec labelled ready-for-agent', href: href(n) })
  }
  for (const i of input.issues) {
    if (has(i, 'needs-triage') || i.labels.length === 0) items.push({ kind: 'triage', n: i.number, text: i.title, href: href(i.number) })
  }
  return items
}

/** The last tool call in a transcript's tail, in a few words. */
export function lastToolCall(tail: string): string {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"tool_use"')) continue
    let row: { message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const content = Array.isArray(row.message?.content) ? row.message.content : []
    const uses = content.filter((b): b is { type: string; name: string; input?: Record<string, unknown> } => b?.type === 'tool_use')
    const use = uses[uses.length - 1]
    if (!use) continue
    const input = use.input ?? {}
    const what =
      str(input.description) || str(input.command) || str(input.file_path).split('/').pop() || str(input.pattern) || str(input.skill) || str(input.prompt)
    return what ? `${use.name}: ${firstLine(what, 80)}` : use.name
  }
  return ''
}

/** `/a/b.c/d` as Claude Code names its transcript folder for that working directory. */
export function transcriptFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function age(from: string | number, now: number): string {
  const ms = typeof from === 'number' ? from : Date.parse(from)
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.max(0, Math.floor((now - ms) / 60000))
  if (minutes < 1) return `${Math.max(0, Math.floor((now - ms) / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
  return `${Math.floor(minutes / 1440)}d`
}

export function span(from: string, to: string): string {
  return age(from, Date.parse(to))
}

/** `Oct 8 13:43`, in the machine's own time. */
export function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

