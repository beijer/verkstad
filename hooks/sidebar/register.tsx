// The verkstad sidebar: a pane for a Project's Runs, a hooks module of the plugin (hooks/hooks.json).
//
// It reads what verkstad leaves behind (the Runs' event logs, `verkstad frontier --json`, the issues and CI on
// GitHub, the current session's transcript) and draws one pane, opened by `/verkstad:sidebar`: the Run going and its
// controls, what waits on the owner, the Tickets up next, and past Runs. The controls only run verkstad's own
// commands: Start launches `verkstad run` detached, so it outlives this session; Stop asks it to stop after its
// Ticket (`verkstad run --stop`); Abort, once confirmed, ends it and discards the Ticket's work
// (`verkstad run --abort`). Every routing decision stays in `verkstad run`. The commands are this plugin copy's
// own `bin/verkstad`, so the sidebar drives the version the Project installed.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Attention, FrontierView, Notice, OwnerView, Project, RunSummary, RunTicket, RunView } from '../../types'
import {
  age,
  attention,
  clip,
  firstLine,
  frontierView,
  issueInfo,
  lastToolCall,
  phase,
  readEvents,
  runSummary,
  runView,
  span,
  stage,
  STAGES,
  transcriptFolder,
  usd,
  when,
} from './events'

const PANE = 'verkstad-run'
const POLL_MS = 2000
const ALIVE_MS = 10_000
const ACTIVITY_MS = 5000
const GITHUB_MS = 2 * 60_000
/** How long a Start waits for its Run's event log before showing what the Run printed. */
const START_MS = 30_000
const HISTORY = 6
/** The desktop app's tool that offers a task as a chip the owner opens in a session of its own. */
const SPAWN_TASK = 'mcp__ccd_session__spawn_task'

// Theme keys, so the pane follows the person's theme.
const ACCENT = 'claude'
const OK = 'success'
const BAD = 'error'
const WARN = 'warning'
const INFO = 'suggestion'
const DIM = 'inactive'

const project = atom({ plugin: 'verkstad', key: 'project' } as const, null)
const run = atom({ plugin: 'verkstad', key: 'run' } as const, null)
const isAlive = atom({ plugin: 'verkstad', key: 'isAlive' } as const, null)
const history = atom({ plugin: 'verkstad', key: 'history' } as const, [])
const frontier = atom({ plugin: 'verkstad', key: 'frontier' } as const, null)
const owner = atom({ plugin: 'verkstad', key: 'owner' } as const, null)
const activity = atom({ plugin: 'verkstad', key: 'activity' } as const, null)
const notice = atom({ plugin: 'verkstad', key: 'notice' } as const, null)
const expanded = atom({ plugin: 'verkstad', key: 'expanded' } as const, null)
const isConfirmingAbort = atom({ plugin: 'verkstad', key: 'isConfirmingAbort' } as const, false)
const startingAt = atom({ plugin: 'verkstad', key: 'startingAt' } as const, 0)
const tick = atom({ plugin: 'verkstad', key: 'tick' } as const, 0)

// The module's own: they start over at each reload, and the next poll reads everything afresh.
let polling = false
let lastNewest = ''
let lastSize = -1
let aliveAt = 0
let activityAt = 0
let githubAt = 0
const summaries = new Map<string, { size: number; summary: RunSummary }>()

function verkstad($: EngineInterface, p: Project, args: string[], timeoutMs = 60_000) {
  return $.process.run([`${$.plugin.root}/bin/verkstad`, ...args], { cwd: p.main, timeoutMs })
}

function outputFile(p: Project): string {
  return `/tmp/verkstad-run-${p.name}.out`
}

async function say($: EngineInterface, text: string, isError = false): Promise<void> {
  const at = await $.clock.now()
  await update($, notice, () => (text ? ({ text, isError, at } satisfies Notice) : null))
}

/** The Project whose main checkout holds `cwd`, or null outside a verkstad Project. */
async function findProject($: EngineInterface, cwd: string): Promise<Project | null> {
  const common = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  const dir = common.stdout.trim()
  if (common.exitCode !== 0 || !dir.endsWith('/.git')) return null
  const main = dir.slice(0, -'/.git'.length)
  const contract = `${main}/.claude/harness.json`
  if (!(await $.fs.exists(contract))) return null
  let base = 'main'
  try {
    base = String(JSON.parse(String(await $.fs.read(contract))).baseBranch ?? 'main')
  } catch {
    // verkstad says what is wrong with it when a Run starts
  }
  const repo = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner'], { cwd: main })
  let nameWithOwner = ''
  try {
    nameWithOwner = repo.exitCode === 0 ? String(JSON.parse(repo.stdout).nameWithOwner ?? '') : ''
  } catch {
    // issues show as plain numbers
  }
  return { main, logDir: `${main}/.claude/verkstad`, repo: nameWithOwner, base, name: main.split('/').pop() ?? 'project' }
}

/** A Run is going while its log has no end line and its process is there; until that is asked, it is not. */
function isGoing(r: RunView | null, alive: boolean | null): boolean {
  return r !== null && !r.ended && alive === true
}

/**
 * Whether the Run that writes `r`'s log is still there: its `pid`, or, for a log from before the Run logged one,
 * any `verkstad run` working in the Project's main checkout (verkstad runs on Linux, which has /proc).
 */
async function isRunAlive($: EngineInterface, p: Project, r: RunView): Promise<boolean> {
  if (r.pid !== null) return (await $.process.run(['kill', '-0', String(r.pid)])).exitCode === 0
  const found = await $.process.run([
    'sh',
    '-c',
    // `[.]`, so that the pattern does not match this shell, whose own command line holds it.
    'for pid in $(pgrep -f "src/cli[.]ts run"); do [ "$(readlink "/proc/$pid/cwd")" = "$1" ] && echo "$pid"; done; true',
    'sh',
    p.main,
  ])
  return found.stdout.trim() !== ''
}

async function readGithub($: EngineInterface, p: Project): Promise<void> {
  const now = await $.clock.now()
  githubAt = now
  const f = await verkstad($, p, ['frontier', '--json'])
  let fv: FrontierView
  try {
    if (f.exitCode !== 0) throw new Error(firstLine(f.stderr) || `exit ${f.exitCode}`)
    fv = frontierView(f.stdout, now)
  } catch (err) {
    const previous = await read($, frontier)
    fv = { ...(previous ?? { ready: [], inProgress: [], waiting: [], specsLabelled: [] }), at: now, error: (err as Error).message }
  }
  await update($, frontier, () => fv)

  const gh = async (args: string[]) => {
    const r = await $.process.run(['gh', ...args], { cwd: p.main, timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `gh ${args[0]} failed`)
    return JSON.parse(r.stdout)
  }
  let view: OwnerView
  try {
    const [issues, pulls, ci] = [
      await gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,labels,assignees']),
      await gh(['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url']),
      await gh(['run', 'list', '--branch', p.base, '--limit', '5', '--json', 'name,status,conclusion,headSha,url']),
    ]
    const r = await read($, run)
    const working = isGoing(r, await read($, isAlive)) ? (r?.current ?? null) : null
    const items = attention({ issues, pulls, ci, frontier: fv, repo: p.repo, base: p.base, working })
    view = { items, issues: issueInfo(issues), at: now, error: '' }
  } catch (err) {
    const previous = await read($, owner)
    view = { items: previous?.items ?? [], issues: previous?.issues ?? [], at: now, error: (err as Error).message }
  }
  await update($, owner, () => view)
}

async function readRuns($: EngineInterface, p: Project, now: number): Promise<void> {
  const entries = (await $.fs.exists(p.logDir)) ? await $.fs.list(p.logDir) : []
  const logs = entries.filter(e => /^run-.*\.jsonl$/.test(e.name)).sort((a, b) => (a.name < b.name ? 1 : -1))
  const newest = logs[0]
  if (!newest) return
  const file = `${p.logDir}/${newest.name}`
  if (newest.name === lastNewest && newest.size === lastSize) return
  const before = await read($, run)
  lastNewest = newest.name
  lastSize = newest.size

  const view = runView(file, readEvents(String(await $.fs.read(file))))
  await update($, run, () => view)
  if (before?.file !== view.file) {
    aliveAt = 0
    await update($, activity, () => null)
  }
  const outcomes = (r: RunView | null) => r?.tickets.map(t => `${t.n}${t.outcome}`).join() ?? ''
  if (before?.file !== view.file || outcomes(before) !== outcomes(view) || Boolean(before?.ended) !== Boolean(view.ended)) githubAt = 0

  const started = await read($, startingAt)
  if (started && Date.parse(view.startedAt) >= started - 10_000) {
    await update($, startingAt, () => 0)
    await say($, '')
  }

  const list: RunSummary[] = []
  for (const log of logs.slice(0, HISTORY + 1)) {
    const path = `${p.logDir}/${log.name}`
    const cached = summaries.get(path)
    if (path === file) list.push(runSummary(view))
    else if (cached && cached.size === log.size) list.push(cached.summary)
    else {
      const summary = runSummary(runView(path, readEvents(String(await $.fs.read(path)))))
      summaries.set(path, { size: log.size, summary })
      list.push(summary)
    }
  }
  await update($, history, () => list)
  void now
}

async function readActivity($: EngineInterface, p: Project, r: RunView): Promise<void> {
  const n = r.current
  if (n === null) return
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const folder = `${config}/projects/${transcriptFolder(`${p.main}/.claude/worktrees/issue-${n}`)}`
  if (!(await $.fs.exists(folder))) return
  const t = r.tickets.find(one => one.n === n)
  const since = Date.parse(r.startedAt)
  const newest = (await $.fs.list(folder))
    .filter(e => e.name.endsWith('.jsonl') && e.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!newest || !t) return
  const out = await $.process.run(['sh', '-c', 'grep -c \'"type":"tool_use"\' "$1"; tail -c 200000 "$1"', 'sh', `${folder}/${newest.name}`])
  const [count = '0', ...tail] = out.stdout.split('\n')
  const next: Activity = { ticket: n, calls: Number(count) || 0, last: lastToolCall(tail.join('\n')) }
  await update($, activity, () => next)
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const p = await read($, project)
    if (!p) return
    const now = await $.clock.now()
    await readRuns($, p, now)

    const r = await read($, run)
    if (r && !r.ended && now - aliveAt > ALIVE_MS) {
      aliveAt = now
      const alive = await isRunAlive($, p, r)
      if ((await read($, isAlive)) !== alive) await update($, isAlive, () => alive)
    } else if (r?.ended && (await read($, isAlive)) !== null) {
      await update($, isAlive, () => null)
    }
    const going = isGoing(r, await read($, isAlive))
    if (going && r && now - activityAt > ACTIVITY_MS) {
      activityAt = now
      await readActivity($, p, r)
    }

    const started = await read($, startingAt)
    if (started && now - started > START_MS) {
      await update($, startingAt, () => 0)
      const out = (await $.fs.exists(outputFile(p))) ? String(await $.fs.read(outputFile(p))) : ''
      await say($, `The Run did not start: ${firstLine(out, 300) || 'it printed nothing'}`, true)
    }

    if (now - githubAt > GITHUB_MS) await readGithub($, p)
    // Ages redraw every poll while something moves, and every half minute otherwise.
    const step = going || started ? POLL_MS : 30_000
    if (now - (await read($, tick)) >= step) await update($, tick, () => now)
  } finally {
    polling = false
  }
}

async function start($: EngineInterface, p: Project, max: number | null): Promise<void> {
  await update($, isConfirmingAbort, () => false)
  await say($, 'Reading the Frontier…')
  const extra = max === null ? [] : ['--max', String(max)]
  const plan = await verkstad($, p, ['run', '--dry-run', ...extra])
  if (plan.exitCode !== 0) return say($, firstLine(plan.stderr, 300) || `verkstad run --dry-run exited ${plan.exitCode}`, true)
  if (!/^Next: /m.test(plan.stdout)) return say($, firstLine(plan.stdout, 300))
  const next = /^Next: (.*)$/m.exec(plan.stdout)?.[1] ?? ''
  const launch = await $.process.run(
    ['sh', '-c', 'out=$1; shift; setsid -f "$@" >"$out" 2>&1 </dev/null', 'sh', outputFile(p), `${$.plugin.root}/bin/verkstad`, 'run', ...extra],
    { cwd: p.main },
  )
  if (launch.exitCode !== 0) return say($, firstLine(launch.stderr, 300) || 'could not start verkstad run', true)
  const now = await $.clock.now()
  await update($, startingAt, () => now)
  await update($, tick, () => now)
  await say($, `Starting: ${next.replace(/\.$/, '')}`)
}

async function control($: EngineInterface, p: Project, what: 'stop' | 'abort'): Promise<void> {
  await update($, isConfirmingAbort, () => false)
  const r = await verkstad($, p, ['run', `--${what}`])
  const text = r.exitCode === 0 ? firstLine(r.stdout, 300) : firstLine(r.stderr, 300) || `verkstad run --${what} exited ${r.exitCode}`
  await say($, text, r.exitCode !== 0)
  aliveAt = 0
}

/**
 * Starts triage of issue #n in a session of its own: on the desktop, a task chip the owner clicks to open the
 * session (the app's `spawn_task` tool); elsewhere, the command put in the prompt for the owner to send.
 */
async function triage($: EngineInterface, p: Project, n: number): Promise<void> {
  const command = `/verkstad:triage ${p.repo ? `${p.repo}#${n}` : `#${n}`}`
  const spawn = (await $.tool.list()).find(t => t.name === SPAWN_TASK)
  if (spawn) {
    await $.tool.call({
      tool: SPAWN_TASK,
      title: `Triage #${n}`,
      tldr: `Triage ${p.repo}#${n} with verkstad's triage skill, from the verkstad sidebar.`,
      prompt: command,
    })
    return say($, `Triage of #${n} is a task chip now: click it to open its session.`)
  }
  const filled = await $.prompt.fill({ text: command, mode: 'replace' })
  return say($, filled.isFilled ? `${command} is in the prompt: send it to start triage here.` : `Run ${command} to triage #${n}.`)
}

async function refresh($: EngineInterface, p: Project): Promise<void> {
  await say($, '')
  await readGithub($, p)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const p = await findProject($, e.cwd)
    await update($, project, () => p)
    if (!p) return started
    $.clock.every(POLL_MS, () => void poll($))
    void poll($)
    void $.ui.open({ id: PANE, title: 'verkstad' })
    return started
  })

  // `/verkstad:sidebar` is the plugin's skill skills/sidebar; answered here, it opens the pane and starts no turn.
  on('command.run', { command: 'verkstad:sidebar' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'verkstad' })
    return { text: opened.isPlaced ? 'verkstad sidebar opened.' : `verkstad sidebar waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const p = await read($, project)
    const r = await read($, run)
    const alive = await read($, isAlive)
    const past = await read($, history)
    const f = await read($, frontier)
    const o = await read($, owner)
    const act = await read($, activity)
    const note = await read($, notice)
    const open = await read($, expanded)
    const confirming = await read($, isConfirmingAbort)
    const starting = await read($, startingAt)
    const now = await read($, tick)
    /** The pane's body, less a cell each side for air. */
    const width = Math.max(24, e.props.bodyColumns - 2)

    if (!p) {
      return (
        <Box flexDirection="column" width={width} paddingX={1}>
          <Text color={DIM}>Not a verkstad Project: its main checkout has no .claude/harness.json.</Text>
        </Box>
      )
    }

    /** An issue's number: a link drawn as in a reply (Markdown), so a surface that previews issue links does here too. */
    const issue = (n: number, color?: string) =>
      p.repo ? <Markdown key={`#${n}`} text={`[#${n}](https://github.com/${p.repo}/issues/${n})`} /> : <Text color={color}>#{n}</Text>

    /** Text that takes the room left in its row and is cut with an ellipsis, never wrapped or spilt. */
    const fill = (text: string, color?: string, bold?: boolean) => (
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={color} bold={bold} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    /** Text kept whole at its row's end. */
    const fixed = (text: string, color = DIM, bold?: boolean) => (
      <Box flexShrink={0}>
        <Text color={color} bold={bold} wrap="truncate">
          {text}
        </Text>
      </Box>
    )
    /** The open issues, which can be triaged. */
    const openIssues = new Set((o?.issues ?? []).map(i => i.n))
    /** A row: a glyph, an issue, its text cut to fit, and a value set to the right; hovered, an open issue's Triage. */
    const row = (key: string, glyph: string, color: string, n: number | null, text: string, right = '', indent = 0) => (
      <Box key={key} flexDirection="row" width={width - indent} marginLeft={indent} gap={1}>
        {fixed(glyph, color)}
        {n === null ? null : <Box flexShrink={0}>{issue(n, color)}</Box>}
        {fill(text)}
        {right ? fixed(right) : null}
        {n !== null && openIssues.has(n) ? (
          <Box flexShrink={0} display="none" hover={{ display: 'flex' }}>
            <Button key={`triage:${key}`} label="Triage" plain onPress={() => void triage($, p, n)} />
          </Box>
        ) : null}
      </Box>
    )
    const section = (key: string, label: string, rows: JSX.Element[], right?: JSX.Element) => (
      <Box key={key} flexDirection="column" width={width} marginTop={1}>
        <Box flexDirection="row" width={width} marginBottom={1}>
          <Box flexGrow={1} flexShrink={0}>
            <Text color={DIM} bold wrap="truncate">
              {label}
            </Text>
          </Box>
          {right ?? null}
        </Box>
        {rows}
      </Box>
    )

    // The Run: its state, the controls, and the Ticket it is on.
    const going = isGoing(r, alive)
    const current = going ? r?.tickets.find(t => t.n === r.current) : undefined
    let state: JSX.Element
    if (starting) {
      state = <Box key="state" flexDirection="row" width={width}>{fixed('◌ Starting…', ACCENT, true)}</Box>
    } else if (going && r) {
      const landed = r.tickets.filter(t => t.outcome === 'landed').length
      const facts = [age(r.startedAt, now), usd(r.cost), landed ? `${landed} landed` : '']
      if (r.asked === 'stop') facts.push(`stops after ${current ? `#${current.n}` : 'this Ticket'}`)
      if (r.asked === 'abort') facts.push('aborting')
      state = (
        <Box key="state" flexDirection="row" width={width} gap={1}>
          {fixed('● Running', ACCENT, true)}
          {fill(facts.filter(Boolean).join(' · '), DIM)}
        </Box>
      )
    } else {
      const last = r?.ended
        ? `last Run ${r.ended.kind} ${age(r.ended.at, now)} ago`
        : r
          ? `last Run did not end (no event for ${age(r.lastAt, now)})`
          : 'no Run yet'
      state = (
        <Box key="state" flexDirection="row" width={width} gap={1}>
          {fixed('○ Idle', DIM, true)}
          {fill(last, DIM)}
        </Box>
      )
    }

    const controls: JSX.Element[] = []
    if (confirming && going && r) {
      controls.push(
        <Box key="confirm-text" width={width} marginTop={1}>
          <Text color={BAD} wrap="wrap">
            Abort discards {current ? `#${current.n}'s` : "the current Ticket's"} work; the next Run starts it afresh.
          </Text>
        </Box>,
        <Box key="confirm" flexDirection="row" gap={1} marginTop={1}>
          <Button key="abort-confirm" label={`✕ Abort${current ? ` #${current.n}` : ''}`} hotkey="y" onPress={() => void control($, p, 'abort')} />
          <Button key="abort-cancel" label="Keep going" hotkey="n" variant="primary" onPress={() => void update($, isConfirmingAbort, () => false)} />
        </Box>,
      )
    } else if (going) {
      controls.push(
        <Box key="controls" flexDirection="row" gap={1} marginTop={1}>
          {r?.asked ? null : (
            <Button key="stop" label={`■ Stop after ${current ? `#${current.n}` : 'this Ticket'}`} hotkey="s" onPress={() => void control($, p, 'stop')} />
          )}
          {r?.asked === 'abort' ? null : <Button key="abort" label="✕ Abort" hotkey="x" onPress={() => void update($, isConfirmingAbort, () => true)} />}
        </Box>,
      )
    } else if (!starting) {
      controls.push(
        <Box key="controls" flexDirection="row" gap={1} marginTop={1}>
          <Button key="start" label="▶ Start" hotkey="g" variant="primary" onPress={() => void start($, p, null)} />
          <Button key="start-one" label="▶ One Ticket" hotkey="1" onPress={() => void start($, p, 1)} />
        </Box>,
      )
    }
    if (note) {
      controls.push(
        <Box key="notice" width={width} marginTop={1}>
          <Text color={note.isError ? BAD : DIM} wrap="wrap">
            {note.text}
          </Text>
        </Box>,
      )
    }

    let card: JSX.Element | null = null
    if (going && r && current) {
      const doing = phase(current.say)
      const at = stage(doing)
      const facts = [current.tier, `${doing} ${age(current.sayAt, now)}`, current.cost ? `${usd(current.cost)} so far` : '']
      card = (
        <Box key="card" flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={2} paddingY={1} marginTop={1} width={width}>
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={0}>{issue(current.n, ACCENT)}</Box>
            {fill(facts.filter(Boolean).join(' · '), DIM)}
          </Box>
          <Text bold wrap="wrap">
            {current.title}
          </Text>
          <Box marginTop={1}>
            <Text wrap="truncate-end">
              {STAGES.map((s, i) => (
                <Text key={s} color={i < at ? OK : i === at ? ACCENT : DIM} bold={i === at}>
                  {i ? '  ›  ' : ''}
                  {i < at ? `✓ ${s}` : s}
                </Text>
              ))}
            </Text>
          </Box>
          {act && act.ticket === current.n && act.last ? (
            <Box flexDirection="row" marginTop={1} gap={1}>
              {fixed(`↳ ${act.calls} tool calls`, DIM)}
              {fill(`· ${act.last}`, DIM)}
            </Box>
          ) : null}
        </Box>
      )
    }

    const glyph = { landed: ['✓', OK], parked: ['⏸', WARN], aborted: ['✕', BAD] } as const
    const outcome = (t: RunTicket, key: string, indent = 0) => {
      if (!t.outcome) return row(key, '·', DIM, t.n, t.title || 'no outcome', usd(t.cost), indent)
      const [g, c] = glyph[t.outcome]
      return row(key, g, c, t.n, t.outcome === 'landed' ? t.title : `${t.outcome}: ${t.detail}`, usd(t.cost), indent)
    }
    const thisRun = (r?.tickets ?? []).filter(t => t.outcome)
    const runRows = going && thisRun.length ? [section('this', 'THIS RUN', thisRun.map(t => outcome(t, `o${t.n}`)))] : []
    if (r?.ended?.kind === 'stopped' && now - Date.parse(r.ended.at) < 24 * 60 * 60_000) {
      runRows.push(
        <Box key="stopped" width={width} marginTop={1}>
          <Text color={BAD} wrap="wrap">
            Last Run stopped: {r.ended.error}
          </Text>
        </Box>,
      )
    }

    // What waits on the owner: shown only when something does.
    const marks: Record<Attention['kind'], [string, string]> = {
      ci: ['✗', BAD],
      pr: ['⇡', INFO],
      info: ['?', WARN],
      human: ['!', WARN],
      claimed: ['!', WARN],
      spec: ['!', WARN],
      triage: ['•', INFO],
    }
    const needs = o?.items ?? []
    const needsRows = needs.length
      ? [
          section(
            'needs',
            'NEEDS YOU',
            needs.map((a, i) =>
              a.kind === 'ci' && a.href ? (
                <Box key={`n${i}`} flexDirection="row" width={width} gap={1}>
                  {fixed('✗', BAD)}
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Link key="ci" href={a.href} label={a.text} />
                  </Box>
                </Box>
              ) : (
                row(`n${i}`, marks[a.kind][0], marks[a.kind][1], a.n, a.text)
              ),
            ),
          ),
        ]
      : []

    // Up next: the Frontier, without the Ticket the Run is on.
    const ready = (f?.ready ?? []).filter(t => t.n !== current?.n)
    const next: JSX.Element[] = []
    if (!f) next.push(<Text key="reading" color={DIM}>Reading the Frontier…</Text>)
    else {
      if (f.error) next.push(<Box key="ferr" width={width}><Text color={BAD} wrap="wrap">verkstad frontier: {f.error}</Text></Box>)
      ready.slice(0, 5).forEach((t, i) => next.push(row(`r${t.n}`, i === 0 && !going ? '▸' : ' ', ACCENT, t.n, t.title, t.tier)))
      if (ready.length > 5) next.push(<Text key="more" color={DIM}>  +{ready.length - 5} more ready</Text>)
      if (ready.length === 0 && !f.error) next.push(<Text key="none" color={DIM}>Nothing is ready.</Text>)
    }
    const waiting = (f?.waiting ?? []).map(t => row(`w${t.n}`, '⧗', DIM, t.n, t.title, `← ${t.waitsOn.join(' ')}`))
    if (waiting.length > 5) waiting.splice(5, waiting.length, <Text key="wmore" color={DIM}>  +{(f?.waiting.length ?? 0) - 5} more waiting</Text>)
    const refreshed = (
      <Box flexDirection="row" flexShrink={0} gap={1}>
        {f && now - f.at >= 60_000 ? <Text color={DIM}>{age(f.at, now)} ago</Text> : null}
        <Button key="refresh" label="↻" plain hotkey="r" onPress={() => void refresh($, p)} />
      </Box>
    )
    const nextRows = [section('next', 'UP NEXT', next, refreshed), ...(waiting.length ? [section('waiting', 'WAITING ON A BLOCKER', waiting)] : [])]

    // History: past Runs, newest first; a Run's date opens its Tickets.
    const done = past.filter(one => one.file !== (going ? r?.file : undefined)).slice(0, HISTORY)
    const most = Math.max(0, ...done.map(one => one.cost))
    const barWidth = Math.max(3, Math.min(14, width - 40))
    const ending = (one: RunSummary): [string, string] =>
      one.ending === 'stopped'
        ? ['stopped', BAD]
        : one.ending === 'aborted'
          ? ['aborted', WARN]
          : one.ending === 'open'
            ? ['no end', DIM]
            : one.askedStop
              ? ['stopped by you', DIM]
              : ['', DIM]
    const past1: JSX.Element[] = []
    for (const one of done) {
      const isOpen = open === one.file
      const [end, endColor] = ending(one)
      /** A column of a fixed number of cells, so the rows line up in any font. */
      const col = (cells: number, text: string, color = DIM, alignRight = false) => (
        <Box width={cells} flexShrink={0} justifyContent={alignRight ? 'flex-end' : 'flex-start'}>
          <Text color={color} wrap="truncate">
            {text}
          </Text>
        </Box>
      )
      const cells = most > 0 && one.cost > 0 ? Math.max(1, Math.round((one.cost / most) * barWidth)) : 0
      past1.push(
        <Box key={one.file} flexDirection="row" width={width}>
          <Box width={15} flexShrink={0}>
            <Button
              key={`h:${one.file}`}
              label={`${isOpen ? '▾' : '▸'} ${when(one.startedAt)}`}
              plain
              onPress={() => void update($, expanded, was => (was === one.file ? null : one.file))}
            />
          </Box>
          {col(4, one.landed ? `✓${one.landed}` : '', OK)}
          {col(4, one.parked ? `⏸${one.parked}` : '', WARN)}
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
            {end ? (
              <Text color={endColor} wrap="truncate-end">
                {end}
              </Text>
            ) : cells ? (
              <Box width={cells} backgroundColor={INFO}>
                <Text> </Text>
              </Box>
            ) : null}
          </Box>
          {col(8, usd(one.cost), DIM, true)}
          {col(6, span(one.startedAt, one.lastAt), DIM, true)}
        </Box>,
      )
      if (isOpen) {
        const tickets = one.tickets.length
          ? one.tickets.map(t => outcome(t, `${one.file}#${t.n}`, 2))
          : [<Box key={`${one.file}:none`} marginLeft={2}><Text color={DIM}>No Ticket was claimed.</Text></Box>]
        if (one.error) {
          tickets.push(
            <Box key={`${one.file}:error`} marginLeft={2} width={width - 2}>
              <Text color={BAD} wrap="wrap">Stopped: {one.error}</Text>
            </Box>,
          )
        }
        past1.push(
          <Box key={`${one.file}:tickets`} flexDirection="column" width={width} marginBottom={1}>
            {tickets}
          </Box>,
        )
      }
    }
    const historyRows = done.length ? [section('history', 'HISTORY', past1)] : []

    return (
      <Box flexDirection="column" width={width + 2} paddingX={1}>
        {state}
        {controls}
        {card}
        {runRows}
        {needsRows}
        {nextRows}
        {historyRows}
      </Box>
    )
  })
}
