import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = '/home/owner/code/project'
const LOGS = `${MAIN}/.claude/verkstad`
const HOME = '/home/owner'
const NOW = Date.parse('2026-10-08T18:00:00.000Z')

const line = (e: object) => JSON.stringify(e) + '\n'
const PAST =
  line({ at: '2026-10-08T13:43:25.000Z', run: 'started', ready: [44, 45] }) +
  line({ at: '2026-10-08T13:43:27.000Z', ticket: 44, claimed: 'Landing refuses a narrowed Surface', tier: 'standard' }) +
  line({ at: '2026-10-08T13:49:54.000Z', ticket: 44, session: 'implementer', cost: 2.39, turns: 44 }) +
  line({ at: '2026-10-08T13:49:58.000Z', ticket: 44, landed: 'landed on main in f342b87', commit: 'f342b87' }) +
  line({ at: '2026-10-08T13:50:03.000Z', ticket: 45, claimed: 'Show the plan', tier: 'light' }) +
  line({ at: '2026-10-08T13:58:46.000Z', ticket: 45, session: 'implementer', cost: 7.49, turns: 55 }) +
  line({ at: '2026-10-08T13:58:50.000Z', ticket: 45, parked: 'The owner must pick a layout.' }) +
  line({ at: '2026-10-08T14:12:41.000Z', run: 'finished', sessions: 2, cost: 9.88 })
const LIVE =
  line({ at: '2026-10-08T17:50:00.000Z', run: 'started', ready: [49, 50], pid: 4242 }) +
  line({ at: '2026-10-08T17:50:01.000Z', ticket: 49, claimed: 'The owner can stop a Run', tier: 'standard' }) +
  line({ at: '2026-10-08T17:50:02.000Z', ticket: 49, say: 'implementing in .claude/worktrees/issue-49.' })

const FRONTIER = JSON.stringify({
  ready: [
    { number: 49, title: 'The owner can stop a Run', labels: ['ready-for-agent'], assignees: [], open_blockers: [] },
    { number: 50, title: 'Next thing', labels: ['ready-for-agent', 'tier:light'], assignees: [], open_blockers: [] },
  ],
  in_progress: [],
  waiting: [{ number: 51, title: 'After the next thing', labels: ['ready-for-agent'], assignees: [], open_blockers: [{ number: 50, labels: [] }] }],
  specs_labelled: [],
})
const ISSUES = JSON.stringify([
  { number: 39, title: 'Is tiering needed?', labels: [{ name: 'ready-for-human' }] },
  { number: 50, title: 'Next thing', labels: [{ name: 'ready-for-agent' }, { name: 'tier:light' }] },
  { number: 52, title: 'A new idea', labels: [] },
])
const CI = JSON.stringify([
  { name: 'CI', status: 'completed', conclusion: 'failure', headSha: '07abb4a1234', url: 'https://github.com/owner/project/actions/runs/1' },
])
const TRANSCRIPT_DIR = `${HOME}/.claude/projects/-home-owner-code-project--claude-worktrees-issue-49`
const TAIL = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })

/** A verkstad Project on disk and on GitHub, in memory; `verkstad` records what the controls ran. */
function world(on: On, logs: Record<string, string>, options: { alive?: boolean; runProcess?: boolean; desktop?: boolean } = {}) {
  const ran: string[][] = []
  const launched: string[][] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const value = <T>(v: T) => ({ value: v })
  const ok = (stdout: string, exitCode = 0, stderr = '') => value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  const files: Record<string, string> = { [`${MAIN}/.claude/harness.json`]: '{"baseBranch":"main"}' }
  for (const [name, text] of Object.entries(logs)) files[`${LOGS}/${name}`] = text
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const [cmd, ...rest] = e.argv
    if (cmd === 'git') return ok(`${MAIN}/.git\n`)
    if (cmd === 'kill') return ok('', options.alive === false ? 1 : 0)
    if (cmd === 'gh' && rest[0] === 'repo') return ok('{"nameWithOwner":"owner/project"}')
    if (cmd === 'gh' && rest[0] === 'issue') return ok(ISSUES)
    if (cmd === 'gh' && rest[0] === 'pr') return ok('[]')
    if (cmd === 'gh' && rest[0] === 'run') return ok(CI)
    const script = rest[1] ?? ''
    if (cmd === 'sh' && script.includes('setsid')) {
      launched.push(e.argv.slice(6))
      return ok('')
    }
    if (cmd === 'sh' && script.includes('grep -c')) return ok(`12\n${TAIL}`)
    if (cmd === 'sh' && script.includes('pgrep')) {
      expect(e.argv.at(-1)).toBe(MAIN)
      // As on the machine: a pattern written plainly in the script matches the shell running it, in the main checkout.
      const self = script.includes('src/cli.ts run') ? '999\n' : ''
      return ok(self + (options.runProcess ? '777\n' : ''))
    }
    if (cmd?.endsWith('/bin/verkstad')) {
      const args = rest
      ran.push(args)
      if (args[0] === 'frontier') return ok(FRONTIER)
      if (args.join(' ') === 'run --dry-run') return ok('Ready: #49 …, #50 ….\nNext: #49, on the standard Tier (opus, medium effort, $25 budget).\n')
      if (args.join(' ') === 'run --stop') return ok('The Run stops after #49.\n')
      if (args.join(' ') === 'run --abort') return ok('The Run aborts #49 and discards its work.\n')
    }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('fs.exists', (_$, e) => value(e.path in files || e.path === LOGS || e.path === TRANSCRIPT_DIR))
  on('fs.list', (_$, e) =>
    value(
      e.path === TRANSCRIPT_DIR
        ? [{ name: 's1.jsonl', kind: 'file' as const, size: 10, mtimeMs: NOW - 1000, isLink: false }]
        : Object.keys(logs).map(name => ({ name, kind: 'file' as const, size: logs[name]!.length, mtimeMs: 0, isLink: false })),
    ),
  )
  on('fs.read', (_$, e) => value(files[e.path] ?? ''))
  const opened: string[] = []
  const spawned: unknown[] = []
  const filled: string[] = []
  on('tool.list', () => value(options.desktop ? [{ name: 'mcp__ccd_session__spawn_task', description: '', mcp: true }] : []))
  on('tool.call', (_$, e) => {
    spawned.push(e)
    return { result: { task_id: 't1' } } as never
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return value({ isPlaced: true as const })
  })
  return { clock, ran, launched, opened, spawned, filled }
}

const PANE = {
  plugin: 'verkstad',
  component: 'Pane' as const,
  requestId: 'verkstad-run',
  props: { title: 'verkstad', isFocused: false, bodyColumns: 72, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

async function open($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ ...PANE, surface })
}

const text = async (ui: Awaited<ReturnType<typeof open>>, pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text

for (const surface of ['terminal', 'desktop'] as const) {
  test(`idle, the sidebar shows what needs the owner, what is next and past Runs, and Start launches a Run, on ${surface}`, async ($, on) => {
    const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect(await text(ui, /Idle/)).toBe('○ Idle')
    expect(await text(ui, /last Run/)).toBe('last Run finished 3h47 ago')
    expect((await ui.find({ type: 'Link', text: /^CI / }))?.props.href).toBe('https://github.com/owner/project/actions/runs/1')
    expect((await ui.find({ type: 'Link', text: /^CI / }))?.text).toBe('CI failure on main at 07abb4a (CI)')
    expect(await text(ui, /Is tiering needed/)).toBe('Is tiering needed?')
    expect(await text(ui, /to triage/)).toBe('1 to triage: #52')
    expect(await text(ui, /Next thing/)).toBe('Next thing')
    expect(await text(ui, /^WAITING ON A BLOCKER$/)).toBe('WAITING ON A BLOCKER')
    expect((await ui.find({ type: 'Markdown', text: /#50\]/ }))?.props.text).toBe('[#50](https://github.com/owner/project/issues/50)')
    expect(await text(ui, /After the next thing/)).toBe('After the next thing')
    expect(await text(ui, /^← /)).toBe('← #50')
    expect((await ui.find({ type: 'Button', text: /Oct 8/ }))?.text).toMatch(/^▸ Oct 8 \d\d:43$/)
    expect(await text(ui, /^\$9\.88$/)).toBe('$9.88')
    expect(await text(ui, /^29m$/)).toBe('29m')
    expect(await text(ui, /^✓1$/)).toBe('✓1')
    expect(await text(ui, /^⏸1$/)).toBe('⏸1')

    await ui.press({ key: 'start' })
    expect(w.ran).toContainEqual(['run', '--dry-run'])
    expect(w.launched).toEqual([['run']])
    expect(await text(ui, /^Starting:/)).toBe('Starting: #49, on the standard Tier (opus, medium effort, $25 budget)')
    expect(await text(ui, /Starting…/)).toBe('◌ Starting…')
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a live Run shows its Ticket, the stage and the last tool call, and Stop asks it to stop after the Ticket, on ${surface}`, async ($, on) => {
    const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST, 'run-2026-10-08T17-50-00-000Z.jsonl': LIVE })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect(await text(ui, /Running/)).toBe('● Running')
    expect(await text(ui, /The owner can stop a Run/)).toBe('The owner can stop a Run')
    expect(await text(ui, /^standard · /)).toBe('standard · implementing 9m')
    expect(await text(ui, /^✓ claim/)).toBe('✓ claim  ›  build  ›  verify  ›  land')
        expect(await text(ui, /tool calls/)).toBe('↳ 12 tool calls')
    expect(await text(ui, /^· Bash/)).toBe('· Bash: npm test')
    expect(await text(ui, /^Next thing$/)).toBe('Next thing')
    expect((await ui.find({ key: 'start' }))).toBeUndefined()
    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop after #49')

    await ui.press({ key: 'stop' })
    expect(w.ran).toContainEqual(['run', '--stop'])
    expect(await text(ui, /The Run stops after/)).toBe('The Run stops after #49.')
    await ui.unmount()
  })
}

test('Abort asks for a confirmation before it runs verkstad run --abort', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': LIVE })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  await ui.press({ key: 'abort' })
  expect(w.ran).not.toContainEqual(['run', '--abort'])
  expect(await text(ui, /^Abort discards/)).toBe("Abort discards #49's work; the next Run starts it afresh.")

  await ui.press({ key: 'abort-cancel' })
  expect(await text(ui, /^Abort discards/)).toBeUndefined()

  await ui.press({ key: 'abort' })
  await ui.press({ key: 'abort-confirm' })
  expect(w.ran).toContainEqual(['run', '--abort'])
  expect(await text(ui, /aborts #49/)).toBe('The Run aborts #49 and discards its work.')
})

test('a Run whose process is gone without an end line is not shown as running', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': LIVE }, { alive: false })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  expect(await text(ui, /Idle/)).toBe('○ Idle')
  expect(await text(ui, /last Run/)).toBe('last Run did not end (no event for 9m)')
  expect((await ui.find({ key: 'start' }))?.props.label).toBe('▶ Start')
})

test('a past Run opens to show its Tickets, and closes again', async ($, on) => {
  const file = 'run-2026-10-08T13-43-25-000Z.jsonl'
  const w = world(on, { [file]: PAST })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')
  const toggle = `h:${LOGS}/${file}`

  expect(await text(ui, /Landing refuses/)).toBeUndefined()
  await ui.press({ key: toggle })
  expect((await ui.find({ key: toggle }))?.text).toMatch(/^▾ Oct 8/)
  expect(await text(ui, /Landing refuses/)).toBe('Landing refuses a narrowed Surface')
  expect(await text(ui, /^parked:/)).toBe('parked: The owner must pick a layout.')
  expect(await text(ui, /^\$7\.49$/)).toBe('$7.49')

  await ui.press({ key: toggle })
  expect(await text(ui, /Landing refuses/)).toBeUndefined()
})

test('/verkstad:sidebar opens the pane and answers for itself, starting no turn', async ($, on) => {
  const w = world(on, {})
  on('command.run', () => {
    throw new Error('the command reached the engine, which would start a turn')
  })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.opened).toEqual(['verkstad-run'])

  const answer = await $.command.run({
    command: 'verkstad:sidebar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 160 },
  })
  expect(answer.text).toBe('verkstad sidebar opened.')
  expect(w.opened).toEqual(['verkstad-run', 'verkstad-run'])
})

// A log from before the Run logged its pid: whether it is going is asked of the processes, not guessed.
const OLD_LOG = LIVE.replace(',"pid":4242', '')
if (OLD_LOG.includes('pid')) throw new Error('OLD_LOG still names a pid')

test('a log without a pid and no verkstad run in the Project is not shown as running', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': OLD_LOG })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  expect(await text(ui, /Idle/)).toBe('○ Idle')
  expect(await text(ui, /last Run/)).toBe('last Run did not end (no event for 9m)')
  expect((await ui.find({ key: 'stop' }))).toBeUndefined()
})

test('a log without a pid whose verkstad run still works in the Project is shown as running', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': OLD_LOG }, { runProcess: true })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  expect(await text(ui, /Running/)).toBe('● Running')
  expect((await ui.find({ key: 'stop' }))?.text).toBe('■ Stop after #49')
})

test("Triage on an open issue's row offers its triage as a task chip that opens a session of its own", async ($, on) => {
  const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST }, { desktop: true })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  expect(await ui.find({ key: 'triage:w51' })).toBeUndefined() // #51 is not among the open issues the mock lists
  await ui.press({ key: 'triage:r50' })
  expect(w.spawned).toEqual([
    expect.objectContaining({
      tool: 'mcp__ccd_session__spawn_task',
      title: 'Triage #50',
      prompt: '/verkstad:triage owner/project#50',
    }),
  ])
  expect(await text(ui, /task chip/)).toBe('Triage of #50 is a task chip now: click it to open its session.')
})

test("without the desktop's task tool, Triage puts the command in the prompt", async ($, on) => {
  const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  await ui.press({ key: 'triage:n1' })
  expect(w.spawned).toEqual([])
  expect(w.filled).toEqual(['/verkstad:triage owner/project#39'])
  expect(await text(ui, /in the prompt/)).toBe('/verkstad:triage owner/project#39 is in the prompt: send it to start triage here.')
})
