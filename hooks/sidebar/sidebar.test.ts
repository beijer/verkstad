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
const transcriptDir = (n: number) => `${HOME}/.claude/projects/-home-owner-code-project--claude-worktrees-issue-${n}`
const tail = (name: string, input: object) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
/** Each Ticket's session: how many tool calls its transcript holds, and its tail. */
const SESSIONS: Record<string, [number, string]> = {
  [transcriptDir(49)]: [12, tail('Bash', { command: 'npm test' })],
  [transcriptDir(50)]: [3, tail('Read', { file_path: '/home/owner/code/project/src/plan.ts' })],
  [transcriptDir(51)]: [1, tail('Skill', { skill: 'verkstad:tdd' })],
}

/** A verkstad Project on disk and on GitHub, in memory; `verkstad` records what the controls ran. */
function world(
  on: On,
  logs: Record<string, string>,
  options: {
    alive?: boolean
    runProcess?: boolean
    desktop?: boolean
    brokenCli?: boolean
    contract?: string
    claimed?: number
    /** Whether the pane the session opens unasked is placed, as on a terminal wide enough; true unless said. */
    placed?: boolean
    frontier?: string
    /** What `verkstad frontier` fails with, as when GitHub's allowance runs out. */
    frontierFails?: string
  } = {},
) {
  const ran: string[][] = []
  /** Every read of GitHub: a `gh` call, or `verkstad frontier`, which reads it. */
  const github: string[][] = []
  const launched: string[][] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const value = <T>(v: T) => ({ value: v })
  const ok = (stdout: string, exitCode = 0, stderr = '') => value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  const files: Record<string, string> = { [`${MAIN}/.claude/harness.json`]: options.contract ?? '{"baseBranch":"main"}' }
  for (const [name, text] of Object.entries(logs)) files[`${LOGS}/${name}`] = text
  /** The Run writing more of its event log. */
  const append = (name: string, text: string) => {
    logs[name] = (logs[name] ?? '') + text
    files[`${LOGS}/${name}`] = logs[name]!
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const [cmd, ...rest] = e.argv
    if (cmd === 'git') return ok(`${MAIN}/.git\n`)
    if (cmd === 'kill') return ok('', options.alive === false ? 1 : 0)
    if (cmd === 'gh' || (cmd?.endsWith('/bin/verkstad') && rest[0] === 'frontier')) github.push(e.argv)
    if (cmd === 'gh' && rest[0] === 'repo') return ok('{"nameWithOwner":"owner/project"}')
    if (cmd === 'gh' && rest[0] === 'issue') return ok(ISSUES)
    if (cmd === 'gh' && rest[0] === 'pr') return ok('[]')
    if (cmd === 'gh' && rest[0] === 'run') return ok(CI)
    const script = rest[1] ?? ''
    if (cmd === 'sh' && script.includes('setsid')) {
      launched.push(e.argv.slice(6))
      return ok('')
    }
    if (cmd === 'sh' && script.includes('grep -c')) {
      const [calls, last] = SESSIONS[String(e.argv.at(-1)).replace(/\/[^/]*$/, '')] ?? [0, '']
      return ok(`${calls}\n${last}`)
    }
    if (cmd === 'sh' && script.includes('pgrep')) {
      expect(e.argv.at(-1)).toBe(MAIN)
      // As on the machine: a pattern written plainly in the script matches the shell running it, in the main checkout.
      const self = script.includes('src/cli.ts run') ? '999\n' : ''
      return ok(self + (options.runProcess ? '777\n' : ''))
    }
    if (cmd?.endsWith('/bin/verkstad')) {
      const args = rest
      ran.push(args)
      if (args[0] === 'frontier' && options.frontierFails) return ok('', 1, options.frontierFails)
      if (args[0] === 'frontier') return ok(options.frontier ?? FRONTIER)
      if (args.join(' ') === 'run --dry-run') return ok('Ready: #49 …, #50 ….\nNext: #49, on the standard Tier (opus, medium effort, $25 budget).\n')
      if (args.join(' ') === 'run --dry-run --parallel 1') return ok('Ready: #49 …, #50 ….\nNext: #49, on the standard Tier (opus, medium effort, $25 budget).\n')
      if (args.join(' ') === 'run --dry-run --parallel 2')
        return ok('Ready: #49 …, #50 ….\nNext: #49, on the standard Tier (opus, medium effort, $25 budget); #50, on the light Tier (sonnet, low effort, $10 budget).\n')
      if (args.join(' ') === `run --dry-run --ticket ${options.claimed}`) return ok('', 1, `verkstad run: #${options.claimed} is already claimed by @owner\n`)
      if (args.join(' ') === 'run --dry-run --ticket 50')
        return ok('Ticket: #50 Next thing (light).\nNext: #50, on the light Tier (sonnet, low effort, $10 budget).\n')
      if (args.join(' ') === 'run --stop' && options.brokenCli) return { deny: 'could not start: permission denied' }
      if (args.join(' ') === 'run --stop') return ok('The Run stops after #49.\n')
      if (args.join(' ') === 'run --abort') return ok('The Run aborts #49 and discards its work.\n')
    }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('fs.exists', (_$, e) => value(e.path in files || e.path === LOGS || e.path in SESSIONS))
  on('fs.list', (_$, e) =>
    value(
      e.path in SESSIONS
        ? [{ name: 's1.jsonl', kind: 'file' as const, size: 10, mtimeMs: NOW - 1000, isLink: false }]
        : Object.keys(logs).map(name => ({ name, kind: 'file' as const, size: logs[name]!.length, mtimeMs: 0, isLink: false })),
    ),
  )
  on('fs.read', (_$, e) => value(files[e.path] ?? ''))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return value(undefined)
  })
  const opened: string[] = []
  /** The session's panes, as the surface holds them: the first open is unasked, from session.start. */
  const panes = new Map<string, { isShown: boolean; isPlaced: boolean }>()
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
    const isPlaced = opened.length > 0 || options.placed !== false
    opened.push(e.id)
    panes.set(e.id, { isShown: isPlaced, isPlaced })
    return value(isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is 100 columns wide; an unasked pane needs 144' })
  })
  on('ui.panes', () => value([...panes].map(([id, pane]) => ({ id, title: 'verkstad', isFocused: false, ...pane }))))
  /** The person closing the pane. */
  const close = (id = 'verkstad-run') => panes.delete(id)
  return { clock, ran, launched, opened, spawned, filled, append, github, files, close }
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
    expect(await text(ui, /A new idea/)).toBe('A new idea')
    const order = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(order.indexOf('UP NEXT')).toBeLessThan(order.indexOf('NEEDS YOU'))
    expect(order.indexOf('NEEDS YOU')).toBeLessThan(order.indexOf('WAITING ON A BLOCKER'))
    expect(order.indexOf('WAITING ON A BLOCKER')).toBeLessThan(order.indexOf('HISTORY'))
    expect((await ui.find({ key: 'triage:52' }))?.text).toBe('Triage ›')
    expect(await ui.find({ key: 'triage:50' })).toBeUndefined()
    expect(await ui.find({ key: 'triage:39' })).toBeUndefined()
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

test('Triage on an issue that needs it offers its triage as a task chip whose session reads the user-only triage skill, and only there, saying so for five seconds', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST }, { desktop: true })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  await ui.press({ key: 'triage:52' })
  expect(w.spawned).toEqual([
    expect.objectContaining({
      tool: 'mcp__ccd_session__spawn_task',
      title: 'Triage #52',
      prompt: expect.stringMatching(
        /^Triage owner\/project#52 with verkstad's triage skill\. It is user-only, so the Skill tool cannot invoke it: read \/.+\/skills\/triage\/SKILL\.md and follow it for this one issue\.$/,
      ),
    }),
  ])
  expect(await text(ui, /task chip/)).toBe('Triage of #52 is a task chip now: click it to open its session.')

  await w.clock.advance(6000)
  expect(await text(ui, /task chip/)).toBeUndefined()
})

test("without the desktop's task tool, Triage puts the command in the prompt", async ($, on) => {
  const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  await ui.press({ key: 'triage:52' })
  expect(w.spawned).toEqual([])
  expect(w.filled).toEqual(['/verkstad:triage owner/project#52'])
  expect(await text(ui, /in the prompt/)).toBe('/verkstad:triage owner/project#52 is in the prompt: send it to start triage here.')
})

test('a Stop whose command cannot run says so, in place of nothing, for longer than a notice stays', async ($, on) => {
  const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': LIVE }, { brokenCli: true })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  await ui.press({ key: 'stop' })
  expect(await text(ui, /failed/)).toBe('verkstad run --stop failed: verkstad: $.process.run: could not start: permission denied')

  await w.clock.advance(6000)
  expect(await text(ui, /failed/)).toBeDefined()
  await w.clock.advance(10_000)
  expect(await text(ui, /failed/)).toBeUndefined()
})

const TWO = 'run-2026-10-08T17-50-00-000Z.jsonl'
const TWO_LIVE =
  line({ at: '2026-10-08T17:50:00.000Z', run: 'started', ready: [49, 50, 51], pid: 4242 }) +
  line({ at: '2026-10-08T17:50:01.000Z', ticket: 49, claimed: 'The owner can stop a Run', tier: 'standard' }) +
  line({ at: '2026-10-08T17:50:01.500Z', ticket: 50, claimed: 'Next thing', tier: 'light' }) +
  line({ at: '2026-10-08T17:50:02.000Z', ticket: 49, say: 'implementing in .claude/worktrees/issue-49.' }) +
  line({ at: '2026-10-08T17:50:03.000Z', ticket: 50, say: 'implementing in .claude/worktrees/issue-50.' }) +
  line({ at: '2026-10-08T17:56:00.000Z', ticket: 50, say: 'touches ui; the Verifier Walks it.' })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Run with two Tickets in flight shows each with its stage and last tool call, and the next one claimed when one lands, on ${surface}`, async ($, on) => {
    const w = world(on, { [TWO]: TWO_LIVE })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect(await text(ui, /Running/)).toBe('● Running')
    expect(await text(ui, /The owner can stop a Run/)).toBe('The owner can stop a Run')
    expect(await text(ui, /^standard · /)).toBe('standard · implementing 9m')
    expect(await text(ui, /^Next thing$/)).toBe('Next thing')
    expect(await text(ui, /^light · /)).toBe('light · verifying 4m')
    const stages = (await ui.findAll({ type: 'Text', text: /claim .* land$/ })).map(t => t.text)
    expect(stages).toEqual(['✓ claim  ›  build  ›  verify  ›  land', '✓ claim  ›  ✓ build  ›  verify  ›  land'])
    const calls = (await ui.findAll({ type: 'Text', text: /tool calls$/ })).map(t => t.text)
    expect(calls).toEqual(['↳ 12 tool calls', '↳ 3 tool calls'])
    expect(await text(ui, /^· Bash/)).toBe('· Bash: npm test')
    expect(await text(ui, /^· Read/)).toBe('· Read: plan.ts')
    // Neither Ticket in flight is up next, nor claimed with no Run working it.
    expect(await ui.find({ key: 'r49' })).toBeUndefined()
    expect(await ui.find({ key: 'r50' })).toBeUndefined()

    w.append(
      TWO,
      line({ at: '2026-10-08T17:59:00.000Z', ticket: 49, landed: 'landed on main in a1b2c3d', commit: 'a1b2c3d' }) +
        line({ at: '2026-10-08T17:59:01.000Z', ticket: 51, claimed: 'After the next thing', tier: 'standard' }) +
        line({ at: '2026-10-08T17:59:02.000Z', ticket: 51, say: 'implementing in .claude/worktrees/issue-51.' }),
    )
    await w.clock.advance(6000)
    expect((await ui.findAll({ type: 'Text', text: /tool calls$/ })).map(t => t.text)).toEqual(['↳ 3 tool calls', '↳ 1 tool calls'])
    expect(await text(ui, /^· Skill/)).toBe('· Skill: verkstad:tdd')
    expect(await text(ui, /^· Bash/)).toBeUndefined()
    expect(await text(ui, /^THIS RUN$/)).toBe('THIS RUN')
    expect(await text(ui, /^standard · implementing/)).toBe('standard · implementing 1m')
    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop after #50 and #51')
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Stop and Abort run verkstad run --stop and --abort once each, with two Tickets in flight, on ${surface}`, async ($, on) => {
    const w = world(on, { [TWO]: TWO_LIVE })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)
    const runs = (flag: string) => w.ran.filter(args => args.join(' ') === `run ${flag}`).length

    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop after #49 and #50')
    await ui.press({ key: 'stop' })
    expect(runs('--stop')).toBe(1)

    await ui.press({ key: 'abort' })
    expect(await text(ui, /^Abort discards/)).toBe('Abort discards the work of #49 and #50; the next Run starts them afresh.')
    expect((await ui.find({ key: 'abort-confirm' }))?.props.label).toBe('✕ Abort #49 and #50')
    await ui.press({ key: 'abort-confirm' })
    expect(runs('--abort')).toBe(1)
    expect(runs('--stop')).toBe(1)
  })
}

test('a Ticket whose failure stops the Run is no longer in flight while the other finishes', async ($, on) => {
  const w = world(on, { [TWO]: TWO_LIVE + line({ at: '2026-10-08T17:58:00.000Z', ticket: 49, failed: 'git push failed: remote hung up' }) })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  expect((await ui.findAll({ type: 'Text', text: /tool calls$/ })).map(t => t.text)).toEqual(['↳ 3 tool calls'])
  expect(await text(ui, /^standard · /)).toBeUndefined()
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop after #50')
  expect(await text(ui, /^failed:/)).toBe('failed: git push failed: remote hung up')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start runs verkstad run with no count, and a count runs it with --parallel, up to two without a cap, on ${surface}`, async ($, on) => {
    const w = world(on, {})
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect((await ui.find({ key: 'start' }))?.props.label).toBe('▶ Start')
    expect((await ui.find({ key: 'start-one' }))?.props.label).toBe('▶ One Ticket')
    expect((await ui.find({ key: 'parallel:1' }))?.props.label).toBe('1 at a time')
    expect((await ui.find({ key: 'parallel:2' }))?.props.label).toBe('2 at a time')
    expect(await ui.find({ key: 'parallel:3' })).toBeUndefined()

    await ui.press({ key: 'parallel:2' })
    expect(w.ran).toContainEqual(['run', '--dry-run', '--parallel', '2'])
    expect(w.launched).toEqual([['run', '--parallel', '2']])
    expect(await text(ui, /^Starting:/)).toBe(
      'Starting: #49, on the standard Tier (opus, medium effort, $25 budget); #50, on the light Tier (sonnet, low effort, $10 budget)',
    )
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Project whose Contract caps a Run at one Ticket is offered no count above 1, on ${surface}`, async ($, on) => {
    const w = world(on, {}, { contract: '{"baseBranch":"main","parallel":1}' })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect((await ui.find({ key: 'parallel:1' }))?.props.label).toBe('1 at a time')
    expect(await ui.find({ key: 'parallel:2' })).toBeUndefined()
    await ui.press({ key: 'parallel:1' })
    expect(w.launched).toEqual([['run', '--parallel', '1']])
    expect(await text(ui, /^Starting:/)).toBe('Starting: #49, on the standard Tier (opus, medium effort, $25 budget)')
  })
}

test('a Project whose Contract caps a Run above two is offered each count up to its cap', async ($, on) => {
  const w = world(on, {}, { contract: '{"baseBranch":"main","parallel":3}' })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  expect((await ui.find({ key: 'parallel:3' }))?.props.label).toBe('3 at a time')
  expect(await ui.find({ key: 'parallel:4' })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start › on a Ticket up next runs verkstad run --ticket with it, out of the Frontier's order, on ${surface}`, async ($, on) => {
    const w = world(on, {})
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect((await ui.find({ key: 'start:49' }))?.props.label).toBe('Start ›')
    expect((await ui.find({ key: 'start:50' }))?.props.label).toBe('Start ›')
    expect(await ui.find({ key: 'start:51' })).toBeUndefined()

    await ui.press({ key: 'start:50' })
    expect(w.ran).toContainEqual(['run', '--dry-run', '--ticket', '50'])
    expect(w.launched).toEqual([['run', '--ticket', '50']])
    expect(await text(ui, /^Starting:/)).toBe('Starting: #50, on the light Tier (sonnet, low effort, $10 budget)')
    expect(await text(ui, /Starting…/)).toBe('◌ Starting…')
    expect(await ui.find({ key: 'start:49' })).toBeUndefined()
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start › on a Ticket the CLI refuses shows its message and starts nothing, on ${surface}`, async ($, on) => {
    const w = world(on, {}, { claimed: 49 })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    await ui.press({ key: 'start:49' })
    expect(w.ran).toContainEqual(['run', '--dry-run', '--ticket', '49'])
    expect(w.launched).toEqual([])
    expect(await text(ui, /claimed/)).toBe('verkstad run: #49 is already claimed by @owner')
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`while a Run is going, the Tickets up next have no Start › button, on ${surface}`, async ($, on) => {
    const w = world(on, { 'run-2026-10-08T17-50-00-000Z.jsonl': LIVE })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect(await text(ui, /Running/)).toBe('● Running')
    expect(await text(ui, /^Next thing$/)).toBe('Next thing')
    expect(await ui.find({ key: 'start:50' })).toBeUndefined()
    await ui.unmount()
  })
}

const CACHE = `${LOGS}/sidebar-github.json`
/** A Frontier no `verkstad frontier` in these tests prints: only a read of the cache shows it. */
const OTHERS_FRONTIER = JSON.stringify({
  ready: [{ number: 60, title: 'Read by another session', labels: ['ready-for-agent'], assignees: [], open_blockers: [] }],
  in_progress: [],
  waiting: [],
  specs_labelled: [],
})
/** The Project's GitHub read as another session's sidebar left it in the log directory. */
const othersRead = (at: number, readingSince?: number) =>
  JSON.stringify({
    at,
    ...(readingSince ? { readingSince } : {}),
    repo: 'owner/project',
    frontier: OTHERS_FRONTIER,
    frontierError: '',
    issues: JSON.parse(ISSUES),
    pulls: [],
    ci: JSON.parse(CI),
    ownerError: '',
  })
/** What one read of GitHub runs: the Frontier, the repo's name, the open issues and pull requests, and CI. */
const ONE_READ = ['frontier', 'gh repo', 'gh issue', 'gh pr', 'gh run']
/** A read once the repo's name is known, from an earlier read, this session's or another's. */
const NEXT_READ = ['frontier', 'gh issue', 'gh pr', 'gh run']
const reads = (w: ReturnType<typeof world>) => w.github.map(argv => (argv[0] === 'gh' ? `gh ${argv[1]}` : argv[1]!))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a session whose pane is not shown reads nothing from GitHub, and reads it once the owner opens the pane, on ${surface}`, async ($, on) => {
    const w = world(on, { 'run-2026-10-08T13-43-25-000Z.jsonl': PAST }, { placed: false })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    await w.clock.advance(10 * 60_000)
    expect(w.opened).toEqual(['verkstad-run'])
    expect(w.github).toEqual([])

    await $.command.run({ command: 'verkstad:sidebar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await w.clock.advance(2000)
    expect(reads(w)).toEqual(ONE_READ)
    const ui = await open($, surface)
    expect(await text(ui, /Next thing/)).toBe('Next thing')
    await ui.unmount()
  })
}

test('a session whose pane the owner closed reads GitHub no more', async ($, on) => {
  const w = world(on, {})
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(reads(w)).toEqual(ONE_READ)

  w.close()
  await w.clock.advance(10 * 60_000)
  expect(reads(w)).toEqual(ONE_READ)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a session shows the read another session left under two minutes ago without reading GitHub, and reads it once when that read is two minutes old, on ${surface}`, async ($, on) => {
    const w = world(on, { 'sidebar-github.json': othersRead(NOW - 60_000) })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)

    expect(w.github).toEqual([])
    expect(await text(ui, /Read by another session/)).toBe('Read by another session')
    expect(await text(ui, /A new idea/)).toBe('A new idea')
    expect((await ui.find({ type: 'Markdown', text: /#60\]/ }))?.props.text).toBe('[#60](https://github.com/owner/project/issues/60)')

    await w.clock.advance(58_000)
    expect(w.github).toEqual([])
    await w.clock.advance(4000)
    expect(reads(w)).toEqual(NEXT_READ)
    expect(await text(ui, /Read by another session/)).toBeUndefined()
    expect(await text(ui, /^Next thing$/)).toBe('Next thing')
    const written = JSON.parse(w.files[CACHE]!)
    expect(written.at).toBeGreaterThan(NOW)
    expect(written.repo).toBe('owner/project')
    expect(JSON.parse(written.frontier).ready.map((t: { number: number }) => t.number)).toEqual([49, 50])
    expect(written.issues).toEqual(JSON.parse(ISSUES))

    await w.clock.advance(2 * 60_000)
    expect(reads(w)).toEqual([...NEXT_READ, ...NEXT_READ])
    await ui.unmount()
  })
}

test('two minutes of polls in two sessions over one log directory read GitHub once between them', async ($, on) => {
  // The kit runs one session per test, so the second is played here by the cache it shares: while this
  // session reads, the other finds the claim; once it has read, the other finds a read under two minutes old.
  const w = world(on, {})
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(reads(w)).toEqual(ONE_READ)
  const first = JSON.parse(w.files[CACHE]!)
  expect(first.at).toBe(NOW)
  expect(first.readingSince).toBeUndefined()

  // The other session's refresh button reads GitHub a minute later, and this one finds that read when its own ages.
  await w.clock.advance(60_000)
  w.files[CACHE] = othersRead(NOW + 60_000)
  await w.clock.advance(60_000 + 4000)
  expect(reads(w)).toEqual(ONE_READ)
  const ui = await open($, 'desktop')
  expect(await text(ui, /Read by another session/)).toBe('Read by another session')
})

test('while another session is reading GitHub for the Project, this one waits for its read, up to three minutes', async ($, on) => {
  const w = world(on, { 'sidebar-github.json': othersRead(NOW - 5 * 60_000, NOW - 5000) })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')
  expect(w.github).toEqual([])
  expect(await text(ui, /Read by another session/)).toBe('Read by another session')

  await w.clock.advance(170_000)
  expect(w.github).toEqual([])
  await w.clock.advance(10_000)
  expect(reads(w)).toEqual(NEXT_READ)
  expect(await text(ui, /^Next thing$/)).toBe('Next thing')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the refresh button reads GitHub at once, though another session read it a minute ago, and leaves its read for the others, on ${surface}`, async ($, on) => {
    const w = world(on, { 'sidebar-github.json': othersRead(NOW - 60_000) })
    await $.session.start({ cwd: MAIN, surface, isInteractive: true })
    await w.clock.settle()
    const ui = await open($, surface)
    expect(w.github).toEqual([])

    await ui.press({ key: 'refresh' })
    expect(reads(w)).toEqual(NEXT_READ)
    expect(await text(ui, /^Next thing$/)).toBe('Next thing')
    const written = JSON.parse(w.files[CACHE]!)
    expect(written.at).toBe(NOW)
    expect(JSON.parse(written.frontier).ready.map((t: { number: number }) => t.number)).toEqual([49, 50])
    await ui.unmount()
  })
}

test('a Ticket landing after the last read of GitHub has it read again, though that read is under two minutes old', async ($, on) => {
  const w = world(on, { [TWO]: TWO_LIVE })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(reads(w)).toEqual(ONE_READ)

  await w.clock.advance(30_000)
  w.append(TWO, line({ at: new Date(NOW + 30_000).toISOString(), ticket: 49, landed: 'landed on main in a1b2c3d', commit: 'a1b2c3d' }))
  await w.clock.advance(2000)
  expect(reads(w)).toEqual([...ONE_READ, ...NEXT_READ])
  await w.clock.advance(60_000)
  expect(reads(w)).toEqual([...ONE_READ, ...NEXT_READ])
})

test("while another session makes the Project's first read of GitHub, this one waits for it and reads nothing", async ($, on) => {
  const claim = JSON.stringify({ at: 0, readingSince: NOW - 1000, repo: '', frontier: '', frontierError: '', issues: [], pulls: [], ci: [], ownerError: '' })
  const w = world(on, { 'sidebar-github.json': claim })
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'desktop')

  expect(w.github).toEqual([])
  expect(await text(ui, /Reading the Frontier/)).toBe('Reading the Frontier…')
  w.files[CACHE] = othersRead(NOW + 5000)
  await w.clock.advance(6000)
  expect(w.github).toEqual([])
  expect(await text(ui, /Read by another session/)).toBe('Read by another session')
})

test('a read of GitHub that fails keeps the last read for every session, beside why it failed', async ($, on) => {
  const limit = 'verkstad frontier: gh api graphql failed: GraphQL: API rate limit already exceeded'
  const w = world(on, { 'sidebar-github.json': othersRead(NOW - 3 * 60_000) }, { frontierFails: `${limit}\n` })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const ui = await open($, 'terminal')

  expect(reads(w)).toEqual(NEXT_READ)
  expect(await text(ui, /Read by another session/)).toBe('Read by another session')
  expect(await text(ui, /rate limit/)).toBe(`verkstad frontier: ${limit}`)
  const written = JSON.parse(w.files[CACHE]!)
  expect(written.at).toBe(NOW)
  expect(written.readingSince).toBeUndefined()
  expect(written.frontier).toBe(OTHERS_FRONTIER)
  expect(written.frontierError).toBe(limit)
})
