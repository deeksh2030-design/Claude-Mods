# agent-info

A Claude Code mod that shows a live progress bar, elapsed time and an estimated cost while Claude works on a task. Open it with `/agent-info`.

## What it shows

- **Progress bar.** When Claude keeps a task list (TaskCreate / TaskUpdate / TodoWrite), progress is done items plus half of in-progress items over the total. Without a task list, it compares model steps with the average of your last 10 tasks and stays at or below 95% until the task ends.
- **Elapsed and time left.** Time left = elapsed / progress × (1 − progress).
- **Cost so far and estimated total.** Cost so far is the change in the session's `/cost` total since the task began. Estimated total = cost so far / progress, shown once progress is at least 10%. On a subscription this is a token-equivalent figure, not a bill.
- A short summary in the status line while a task runs.

## Install

At the prompt of a terminal session:

```
/plugin install agent-info --marketplace deeksh2030-design/claude-mods
```

From a shell:

```bash
claude plugin install agent-info --marketplace deeksh2030-design/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every new session).

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `deeksh2030-design/claude-mods`, then Add plugin.

## Use

Type `/agent-info` to open the pane. It fills in when the next task starts.
