# claudemod: mods for Claude Code

Five mods, each installed on its own:

| Mod | What it does |
|---|---|
| [clawd-hud](#clawd-hud-a-pixel-spark) | A pixel spark above the prompt, usage batteries, a prompt-cache timer and a context meter |
| [task-hud](#task-hud-to-dos-and-sub-agents) | A to-do progress bar, and a pane with a pixel creature for each sub-agent |
| [followups](#followups-dont-lose-what-claude-notices) | Claude flags what it notices, asks whether to track it, and keeps a to-do you can export |
| [rtl-toggle](#rtl-toggle-hebrew-and-english-on-one-line) | Fixes the reading order of lines that mix English and Hebrew |
| [goal-run](#goal-run-a-goal-for-the-session) | Asks for a goal when a session starts, has Claude plan it, and runs a pixel Claude to 100% as the tasks get done |

Add the marketplace once, then install the ones you want:

```text
/plugin marketplace add Amitro123/claudemod
/plugin install <mod>@claudemod
```

If you added this marketplace before it was renamed from `clawd-hud`, remove it with `/plugin marketplace remove clawd-hud`, add it again, and reinstall your mods as `<mod>@claudemod`.

## clawd-hud: a pixel spark

![clawd-hud demo](assets/clawd-hud.gif)

A Claude Code plugin that puts a little animated spark above the prompt, with a pixel battery for each of your usage limits, and adds a prompt-cache timer and a context meter beside the model picker. It works on personal plans and on enterprise seats.

### What it shows

**Above the prompt (the `AbovePrompt` band)**
- **The spark** on the left. What it does follows what Claude is doing:

| Mood | When | Scenes |
|---|---|---|
| `idle` | waiting for you | drifting with a firefly, juggling, watering a sprout |
| `working` | a turn is running | at the terminal, stacking blocks, pondering, sending out sub-agents |
| `working` > 90s | a hard task | a smoke break on a crate joins the rotation |
| `loop` | the same tool with the same input 3× in one turn | riding a coaster loop it can't get out of |
| `done` | the turn answered | fireworks and a hop (a lightbulb if the task was hard) |
| `relax` | 4 min after `done` | stargazing on a hill, a pool float, cocoa by a snowy window |
| `error` | API error or refusal | goes gray under a little storm cloud, then idle |

- **A battery per usage window**, showing what is **left**: green above 30%, amber above 10%, red below. Each has a "resets in …" countdown.

| | Personal (Pro / Max) | Enterprise |
|---|---|---|
| Batteries | `5h` window, `7d` weekly | `7d` weekly, `mo` monthly spend cap ("over by …" past 100%) |
| Cost | not shown | `$` spent this session |
| "resets in" | the API's reset time | the API's reset time; for the spend cap without one, the 1st of next month |
| Cache timer (`auto`) | 1 hour | 5 minutes |

**Beside the model picker (the `SessionMode` slot)**
- **Cache bolt**: counts down the prompt-cache TTL from the last response. Green while warm, amber in the last minute, gray once cold.
- **Context capsule**: how full the context window is, e.g. `ctx 34% · 68k/200k`.

In a terminal (which can't draw SVG) the same readings show up as a text spark `✦(•_•)` and `▰▰▰▱▱` batteries. A one-line summary also goes to the status bar.

### Install

```text
/plugin install clawd-hud@claudemod
```

### Options

Set with `claude plugin configure clawd-hud@claudemod`, or in the plugin settings:

| Option | Values | Default | What it does |
|---|---|---|---|
| `plan` | `auto`, `personal`, `enterprise` | `auto` | Which limits to show. `auto` switches to enterprise as soon as the account reports a monthly spend limit (`spend_limit`). |
| `cacheTtl` | `auto`, `5m`, `1h` | `auto` | The cache timer's length. `auto` is 1h on personal plans and 5m on enterprise. |

### How it works

- `hooks/register.tsx` hooks `session.start`, `session.measure`, `turn.start`, `tool.call`, `turn.complete` and `ui.render`, keeps its state in atoms, and redraws the spark 8 times a second.
- `hooks/scene.ts` paints one frame of a mood on an 88×20 pixel stage. Every motion is a plain function of the time since the mood began, so a redraw lands on the same frame and never restarts an animation.
- `hooks/gauges.ts` draws the batteries, the bolt and the capsule as plain SVG, so the demo renderer uses the exact same art.
- `tests/plan.test.tsx` checks the personal and enterprise views, the spend-cap overflow and both cache timers. Run it with `claude plugin test plugins/clawd-hud`.

### Changelog

**0.6.0**: a new look. The spark mascot, its scenes, the stage and the batteries, bolt and capsule are all new, drawn by a new animation engine. Everything else carries over: plans, timers, loop detection, the hard-task and eureka moments.

**0.5.0**: renamed from `pixel-buddy` to `clawd-hud` (install again; old settings don't carry over). Enterprise mode. The loop detector's `tool.call` hook got a registration `.catch`, so it can never block a tool call.

**0.4.1**: only a real answer celebrates (a refusal gets the error mood). The cache countdown flips to "cold" even after the machine slept. Timers no longer stack up when `session.start` fires again. No more "resets in NaNm".

**0.4.0**: the hard-task smoke break, the eureka lightbulb and the loop coaster. **0.3.0**: the error mood.

## task-hud: to-dos and sub-agents

![task-hud: the to-do bar above the prompt and the Sub-agents pane](assets/task-hud.png)

<sub>The creatures, the task bar and the progress lines are drawn by the mod's own `art.ts`; the window around them is a mock-up of the desktop app.</sub>

```text
/plugin install task-hud@claudemod
```

- **A progress bar above the prompt** once Claude writes a to-do list (`TodoWrite`, or `TaskCreate`/`TaskUpdate`): it's titled with the prompt that started the work, fills as each to-do gets ticked off (`Tasks 4/5 · 80%`), and shows the one in progress (`Now: Write the script`). When it shares the band with `clawd-hud`, it draws above the spark. A finished list clears on your next prompt.
- **A Sub-agents pane** that opens the first time Claude sends out a sub-agent, and reopens with `/task-hud`. Each agent gets a pixel creature in its own color that walks while it works. Its card shows the task's description, the agent type and model (`general-purpose · Opus 5.5`), its tokens and run time, the current step (`Step 3 · Reading pre-outline.md`), the steps before it and a progress line. Cards are grouped into **Running** and **Finished**. A finished agent closes its eyes and lists what it did (`Wrote script.md`). A failed one turns gray. **Clear** drops the finished cards.

Nobody knows ahead of time how many steps a sub-agent will take, so a running agent's line creeps toward 90% as it works and fills only when it finishes. The token count is the size of the agent's context on its latest request.

Tests: `claude plugin test plugins/task-hud`.

## followups: don't lose what Claude notices

![followups: Claude asks about a bug it noticed in the question dialog; the To-do pane shows open, in-progress and done items with Start, Done and Export to](assets/followups.png)

<sub>A mock-up of version 0.5.0, not a screenshot. The dialog is Claude Code's own question dialog, so it looks like the one in your app rather than exactly like this. The pane follows the mod's drawing: orange open, blue in progress, green done, 🐞 for a bug, and an item offered from a sub-agent's open questions. A dialog closed without an answer leaves the item in a band above the prompt (Add to to-do / Skip / Add all), which isn't shown here.</sub>

While Claude works, it often notices things outside the task: a flaky test, a stale doc, a bug in nearby code. Those get lost unless somebody writes them down. This mod writes them down.

```text
/plugin install followups@claudemod
```

- **Claude flags what it notices.** The mod gives Claude a `flag` tool and a short system-prompt section on when to use it: things outside the current task that need attention later. Claude doesn't fix them unless you ask.
- **A second look after each answer.** Claude doesn't always remember to flag. After each of its answers (in the main conversation, 200 characters or longer), a small model (haiku) reads the answer, together with the reports any sub-agents handed back since the last answer (where the work, and its loose ends, often is), for problems mentioned but left open: something flaky, unverified, skipped or put off, or an open question or decision that wasn't settled. If it can't run (haiku not allowed on the account, an API error), one line in the transcript says so instead of it failing quietly. Up to 3 of those wait in the band above the prompt. Anything already tracked, or that you said isn't needed (remembered per project, across sessions), isn't offered again. It costs one small call per answer and never delays the end of a turn. Turn it off with the `autoDetect` option (`claude plugin configure followups@claudemod`).
- **A sub-agent's open questions, read directly.** When a sub-agent's report has a section for what it left open (`Unsure-about`, `Open questions` or `Open items`, as the model router's `routed-worker` writes), each line in it is offered in the band as soon as the report comes back. This needs no model, so it works even where the after-answer look can't run. A section that says `none` offers nothing, and the turn's end-of-turn check doesn't stop Claude again for items already offered.
- **A check when the turn ends.** If Claude's final reply says something is unverified, untested or left open (a short English and Hebrew phrase list: `not verified`, `untested`, `known gap`, `open questions`, `לא נבדק`, `פער`, `שאלות פתוחות`, ...; `Open questions: none` doesn't count; not `follow-up`, this mod's own word) and it never called `flag` that turn, the turn is stopped once with a nudge to flag each item or say there are none. It reads the reply whatever its source, so findings relayed from a subagent's report count; phrases in code blocks and inline code don't. It stops at most once per turn, never when `flag` was called (even if you turned the item down), and only in interactive sessions (not `-p` or the SDK). Limits: it is a phrase match, so a reply that leaves something open in other words is missed (the second look above still reads it), and a phrase used in passing can stop a turn needlessly. Add phrases to `STOP_PHRASES` in `hooks/register.tsx`; turn it off with the `stopCheck` option.
- **Claude stops and asks you about each one** in the question dialog: *Claude noticed: "Fix the flaky upload test" (Fails 1 in 5 runs · tests/upload.test.ts:42). Add it to your follow-ups?* You answer **Add to to-do** or **Not needed**, or type your own wording, which is kept as the title. Claude gets your answer back and carries on. If you close the dialog without answering, the item waits in a band above the prompt with **Add to to-do** (`a`), **Skip** (`s`) and **Add all**, so it isn't lost.
- **A To-do pane** lists what you kept, colored by status: orange `○` open, blue `◐` in progress, green struck-through `✓` done. A red 🐞 marks bugs (Claude passes `kind: "bug"` to `flag` for broken behavior; `/followup` adds a plain task). **✓ Done** / **↺ Reopen** toggles an item, ✕ removes it, and `/followup <text>` adds one by hand. The header counts open, in progress and done. The list is saved per project and comes back in the next session (lists saved by older versions are migrated). When the project has open or in-progress items, the pane opens by itself as the session starts; the `openOnStart` option turns that off. The list is saved on the machine running Claude Code, so it carries over between local sessions but not between cloud sessions, whose container is gone when they end: use **Export to → Memory** for that.
- **▶ Start** (per open item, or **Start all open**) marks it in progress and submits a message to Claude with the item's id, title, detail and location, asking it to do the work. When it finishes, Claude calls the `done` tool with that id and the item turns green. `done` is idempotent, rejects unknown ids, and the prompt tells Claude not to use it for unrelated work.
- **Export to:**

| Button | Writes to | Why |
|---|---|---|
| Memory | `CLAUDE.md` | Claude reads it at the start of every session |
| Docs | `docs/FOLLOW-UPS.md` | a page of its own |
| README | `README.md`, under *Known issues & follow-ups* | visible to everyone |

The export is a markdown checklist (`[ ]` open, `[x]` done, in-progress items tagged `_(in progress)_`, bugs `_(bug)_`) between `<!-- followups:start -->` and `<!-- followups:end -->` markers. Exporting again replaces that section in place, and the rest of the file is left alone.

Tests: `claude plugin test plugins/followups`.

## rtl-toggle: Hebrew and English on one line

| Toggle off | Toggle on |
|---|---|
| ![Toggle off: embedded Hebrew renders out of order](assets/rtl-toggle-off.png) | ![Toggle on: embedded Hebrew renders in correct order](assets/rtl-toggle-on.png) |

A line that starts in English but is mostly Hebrew (or Arabic, or another right-to-left script) can render out of order, with the Hebrew words shifted. This mod fixes those lines in your messages and Claude's.

```text
/plugin install rtl-toggle@claudemod
```

- **A button above the prompt** (`עברית: פעיל` / `עברית: כבוי`) turns the fix on or off for the session. `/rtl` does the same on every surface, and `/rtl on`, `/rtl off` and `/rtl status` set or report it.
- **What it changes:** a line that starts with an English letter but has at least as many RTL words as LTR words gets one invisible leading RLM (U+200F). That gives the line a right-to-left base direction and right alignment, like a line that starts in Hebrew. Nothing else in the text changes.
- **What it leaves alone:** code blocks (fenced and indented), lines that already start in Hebrew, lines with no RTL text, and inline code, links and URLs, which aren't counted. Table rows are fixed cell by cell, except in the terminal.
- **Limits:** the mod API has no `dir` or alignment prop, so alignment comes only from the RLM. That works where the surface picks the direction per block (the desktop app). In a terminal it depends on the terminal's own bidi support. Messages already on screen keep their layout until they're drawn again.

It also lives in its own repo, [Amitro123/RTL-claude-mod](https://github.com/Amitro123/RTL-claude-mod), which has the full rules and the performance notes.

Tests: `claude plugin test plugins/rtl-toggle`.

## goal-run: a goal for the session

![goal-run: the question a session opens with, and the Goal pane with the runner at 40% and each task's tokens](assets/goal-run.png)

<sub>A mock-up, not a screenshot. The track and the runner are drawn by the mod's own `art.ts`; the band and the pane around them follow its layout.</sub>

```text
/plugin install goal-run@claudemod
```

- **The question.** When a session starts, a band above the prompt asks *Is there a goal you want to work on this session?*, with a field to type it. **No goal this time** dismisses it. If an earlier session in this project left a goal unfinished, the band offers **Continue**, **New goal** or **Not now** instead. `/session-goal <text>` sets a goal at any time, `/session-goal` shows it, and `/session-goal clear` drops it (Claude Code has its own `/goal`, so the mod's is named apart).
- **The plan.** Your goal goes to Claude, which breaks it into 3 to 8 tasks with the `plan` tool. You approve it in the question dialog, or say what to change (Claude revises and asks again). Nothing starts before you approve. A plan whose dialog you closed waits in the pane with **Approve plan**.
- **The run.** The Goal pane shows the goal, a track from 0 to 100%, and a pixel Claude in blue sneakers that stands still between tasks and runs while one is in progress. Claude marks each task in progress and done with the `update` tool, and the runner moves along the track as tasks are done. At 100% it cheers at the flag. Each of your prompts while the goal is open carries the plan's state, so Claude keeps track of where it is.
- **What each task cost.** Every model request, sub-agents' included, is counted against the task in progress, and the pane shows each task's tokens. Planning and work between tasks have a line of their own. The count is everything a request carries (input, output, cache reads and writes), not a price.
- **With followups' to-do list.** Pressing **▶ Start** on a to-do item while a goal is open is a side job. Claude gets no goal reminder with it, so the two don't compete, and its tokens show on a line of their own, *Outside the goal*. The band above the prompt asks whether to **Add to goal**, and shows what that does to the plan (*grows to 6 tasks: 40% → 33%*), or **Keep it separate**. Added, the item becomes a task in progress that carries the tokens it used so far, and it turns done when followups marks the item done. The goal's text stays the same, but the plan grows, so the percentage drops to match the work added. The side job ends when you send a prompt of your own.
- The goal is saved per project on the machine running Claude Code, like followups' list. Turn the question off with the `askOnStart` option.

Tests: `claude plugin test plugins/goal-run`.

## Developing

Each mod's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. Claude Code writes that folder (the API types for your build) the first time it loads the mod, so a fresh clone doesn't have it, and it's git-ignored. To type-check a mod:

```bash
claude --plugin-dir plugins/<mod>   # an interactive session; once the mod loads, .claude-plugin/types/ is there
tsc -p plugins/<mod>
```

Run each mod's tests with `claude plugin test plugins/<mod>`; they don't need the types folder.

## License

MIT, see [LICENSE](LICENSE).

## Regenerating the GIF

The GIF is rendered from the plugin's real `scene.ts` and `gauges.ts`, so it is not a mock-up:

```bash
cd demo
npm install
node render-frames.mjs   # needs Node ≥ 22.18 or ≥ 23.6 (runs the .ts files with built-in type stripping)
python make-gif.py       # needs Pillow
```
