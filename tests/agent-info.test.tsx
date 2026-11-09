import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-info',
  component: 'Pane',
  requestId: 'agent-info',
  props: {
    title: 'Agent info',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('tracks task progress and cost for a running turn', async ($, on) => {
  let usd = 0.1
  let n = 0
  on('command.register', () => ({ value: { command: 'agent-info' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd } } }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: `t${++n}`, subject: 's' } } } : { result: {} },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't1', status: 'completed' })
  usd = 0.35
  await $.session.measure({ context: {}, rateLimits: [], cost: { usd }, changed: ['cost'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /tasks/ }))?.text).toBe('1/2 tasks')
  expect((await ui.find({ type: 'Text', text: /Cost so far/ }))?.text).toContain('$0.25')
  expect((await ui.find({ type: 'Text', text: /Cost so far/ }))?.text).toContain('~$0.50')
  await ui.unmount()
})

test('an empty pane before any task', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('No task yet')
  await ui.unmount()
})
