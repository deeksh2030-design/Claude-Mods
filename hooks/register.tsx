import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, TaskStatus } from '../types'

const PANE = 'agent-info'
const TITLE = 'Agent info'
const BAR_MAX = 40

// Bump the shape tag when Run's fields change, so an older stored value is dropped.
const runAtom = atom({ plugin: 'agent-info', key: 'run' } as const, null, {
  shape: 'run-1',
})
const historyAtom = atom({ plugin: 'agent-info', key: 'history' } as const, [], {
  shape: 'history-1',
})

type Progress = { ratio: number; basis: 'tasks' | 'steps' | 'done'; label: string }

const progressOf = (run: Run, history: readonly number[]): Progress => {
  if (!run.isRunning) return { ratio: 1, basis: 'done', label: run.isAborted ? 'stopped' : 'done' }
  const items = Object.values(run.tasks)
  if (items.length > 0) {
    const done = items.filter(s => s === 'completed').length
    const active = items.filter(s => s === 'in_progress').length
    // An in-progress item counts as half done so the bar moves inside a step.
    const ratio = Math.min(0.99, (done + active * 0.5) / items.length)
    return { ratio, basis: 'tasks', label: `${done}/${items.length} tasks` }
  }
  // No task list: compare model steps with the average of earlier runs.
  const recent = history.slice(-10)
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 8
  const expected = Math.max(avg, run.steps + 1)
  return {
    ratio: Math.min(0.95, run.steps / expected),
    basis: 'steps',
    label: `step ${run.steps} of ~${Math.round(expected)}`,
  }
}

const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
const clockText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const estimate = (run: Run, p: Progress) => {
  const spent = Math.max(0, run.costNow - run.costStart)
  const elapsed = run.now - run.startedAt
  // Project only once there is enough signal to avoid wild numbers.
  const canProject = run.isRunning && p.ratio >= 0.1
  return {
    spent,
    elapsed,
    total: canProject ? spent / p.ratio : undefined,
    remainingMs: canProject ? (elapsed / p.ratio) * (1 - p.ratio) : undefined,
  }
}

const bar = (ratio: number, width: number) => {
  const filled = Math.round(ratio * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

let ticker: { cancel: () => void } | undefined

function startTicker($: EngineInterface) {
  ticker?.cancel()
  ticker = $.clock.every(1000, () => {
    void $.clock.now().then(now =>
      update($, runAtom, run => (run && run.isRunning ? { ...run, now } : run)),
    )
  })
}

async function readCost($: EngineInterface) {
  return (await $.session.usage()).cost?.usd ?? 0
}

async function pushStatus($: EngineInterface) {
  const run = await read($, runAtom)
  if (!run || !run.isRunning) return $.ui.status(undefined)
  const p = progressOf(run, await read($, historyAtom))
  const est = estimate(run, p)
  $.ui.status(
    `${Math.round(p.ratio * 100)}% · ${usd(est.spent)}${est.total ? ` → ~${usd(est.total)}` : ''}`,
  )
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-info',
      description: 'Show a live progress bar and estimated cost for the running task',
    })
    const run = await read($, runAtom)
    if (run?.isRunning) startTicker($)
    return next(e)
  })

  on('command.run', { command: 'agent-info' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    const where = isPlaced
      ? 'Agent info pane opened.'
      : `This app (${(await $.session.surfaces()).join(', ') || 'none'}) did not place the pane; progress shows in the band above the prompt and the status line instead.`
    const run = await read($, runAtom)
    if (!run) return { text: `${where} It fills in when the next task starts.` }
    const p = progressOf(run, await read($, historyAtom))
    const est = estimate(run, p)
    return {
      text: `${where} ${run.isRunning ? 'Running' : 'Last task'}: ${Math.round(
        p.ratio * 100,
      )}% (${p.label}), ${usd(est.spent)} spent${est.total ? `, ~${usd(est.total)} estimated total` : ''}.`,
    }
  })

  // A new main-loop turn starts a new run.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const cost = await readCost($)
    const now = await $.clock.now()
    await update($, runAtom, () => ({
      isRunning: true,
      turnId: e.turnId,
      prompt: e.text.slice(0, 200),
      startedAt: now,
      now,
      steps: 0,
      tools: 0,
      tasks: {},
      costStart: cost,
      costNow: cost,
      outTokens: 0,
      isAborted: false,
    }))
    startTicker($)
    void pushStatus($)
    return next(e)
  })

  // Each model request (main loop or subagent) is a step; refresh the cost after it.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const cost = await readCost($)
    const out = res.usage?.output_tokens ?? 0
    const now = await $.clock.now()
    await update($, runAtom, run =>
      run && run.isRunning
        ? {
            ...run,
            steps: e.agentId === undefined ? run.steps + 1 : run.steps,
            costNow: Math.max(run.costNow, cost),
            outTokens: run.outTokens + out,
            now,
          }
        : run,
    )
    void pushStatus($)
    return res
  })

  on('session.measure', async ($, e, next) => {
    const cost = e.cost?.usd
    if (cost !== undefined) {
      await update($, runAtom, run =>
        run && run.isRunning ? { ...run, costNow: Math.max(run.costNow, cost) } : run,
      )
    }
    return next(e)
  })

  // Task-list tools give a real progress measure when Claude uses them.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const setTasks = (fn: (t: Record<string, TaskStatus>) => Record<string, TaskStatus>) =>
      update($, runAtom, run =>
        run && run.isRunning ? { ...run, tools: run.tools + 1, tasks: fn(run.tasks) } : run,
      )

    if (e.tool === 'TaskCreate') {
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      await setTasks(t => (id ? { ...t, [id]: 'pending' } : t))
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status } = e as unknown as { taskId: string; status?: string }
      await setTasks(t => {
        if (status === 'deleted') {
          const { [taskId]: _gone, ...rest } = t
          return rest
        }
        if (status === 'pending' || status === 'in_progress' || status === 'completed')
          return { ...t, [taskId]: status }
        return t
      })
    } else if (e.tool === 'TodoWrite') {
      const { todos } = e as unknown as { todos: { status: TaskStatus }[] }
      await setTasks(() => Object.fromEntries(todos.map((td, i) => [`todo-${i}`, td.status])))
    } else {
      await setTasks(t => t)
    }
    void pushStatus($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    ticker?.cancel()
    ticker = undefined
    const cost = await readCost($)
    let steps = 0
    await update($, runAtom, run => {
      if (!run || run.turnId !== e.turnId) return run
      steps = run.steps
      return {
        ...run,
        isRunning: false,
        isAborted: e.isAborted,
        now: run.startedAt + e.durationMs,
        costNow: Math.max(run.costNow, cost),
      }
    })
    if (steps > 0 && !e.isAborted) await update($, historyAtom, h => [...h, steps].slice(-20))
    $.ui.status(undefined)
    return next(e)
  })

  // Fallback that every surface draws: a one-line bar above the prompt while a task runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, runAtom)
    if (e.props.hasSurvey || !run || !run.isRunning) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const p = progressOf(run, await read($, historyAtom))
    const est = estimate(run, p)
    const width = Math.max(8, Math.min(24, (e.props.bodyColumns ?? 60) - 40))
    return (
      <Box>
        <Text>
          <Text color="claude">{bar(p.ratio, width)}</Text> {Math.round(p.ratio * 100)}% · {clockText(est.elapsed)} ·{' '}
          {usd(est.spent)}
          {est.total !== undefined ? ` → ~${usd(est.total)}` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No task yet. Send a prompt and this pane tracks it live.</Text>
        </Box>
      )
    }
    const p = progressOf(run, await read($, historyAtom))
    const est = estimate(run, p)
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 40
    const width = Math.max(10, Math.min(BAR_MAX, cols - 8))
    const pct = `${Math.round(p.ratio * 100)}%`.padStart(4)
    const state = run.isRunning ? 'Running' : run.isAborted ? 'Stopped' : 'Finished'

    return (
      <Box flexDirection="column">
        <Text bold>{state}</Text>
        {run.prompt !== '' && <Text dimColor>{run.prompt.slice(0, Math.max(20, cols * 2))}</Text>}
        <Text> </Text>
        <Text>
          <Text color={run.isRunning ? 'claude' : run.isAborted ? 'warning' : 'success'}>
            {bar(p.ratio, width)}
          </Text>
          {pct}
        </Text>
        <Text dimColor>
          {p.label}
          {p.basis === 'steps' ? ' (estimated from earlier tasks)' : ''}
        </Text>
        <Text> </Text>
        <Text>
          Elapsed {clockText(est.elapsed)}
          {est.remainingMs !== undefined ? `  ·  ~${clockText(est.remainingMs)} left` : ''}
        </Text>
        <Text>
          Cost so far <Text bold>{usd(est.spent)}</Text>
          {est.total !== undefined ? (
            <Text>
              {'  ·  est. total '}
              <Text bold>~{usd(est.total)}</Text>
            </Text>
          ) : run.isRunning ? (
            <Text dimColor>{'  ·  estimating…'}</Text>
          ) : null}
        </Text>
        <Text dimColor>
          {run.steps} model steps · {run.tools} tool calls · {run.outTokens.toLocaleString()} output tokens
        </Text>
        <Text> </Text>
        <Text dimColor>Cost uses the session's /cost ledger (API list prices); a subscription is not billed per token.</Text>
      </Box>
    )
  })
}
