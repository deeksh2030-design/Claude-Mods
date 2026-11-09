export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Run = {
  isRunning: boolean
  turnId: string
  prompt: string
  startedAt: number
  now: number
  steps: number
  tools: number
  /** Task-list items seen this run, by id, from TaskCreate/TaskUpdate/TodoWrite. */
  tasks: Record<string, TaskStatus>
  /** Session cost (USD) when the run started, and the latest reading. */
  costStart: number
  costNow: number
  /** Output tokens of the run so far. */
  outTokens: number
  isAborted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-info': {
      run: Shaped<Run | null>
      /** Step counts of finished runs, newest last; drives the step-based ETA. */
      history: Shaped<number[]>
    }
  }
}
