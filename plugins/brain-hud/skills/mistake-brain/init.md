# /brain-hud:mistake-brain init

Scaffolds per-project memory files in the current working directory. Idempotent — safe to re-run; it repairs what is missing and changes nothing else.

## When to use

Run once in **any repo** where you want mistake-brain memory. Files are created in that repo: the inbox, the shared PARA folders, one shared MEMORY.md index read by every harness, and the standing rules.

The **skill code** (`SKILL.md`, Python, hooks) is part of the brain-hud plugin; `<skill_root>` is this skill's folder, the "Base directory for this skill" shown when it loads. Init copies none of it into the project, and registers no hooks: the plugin's `hooks/hooks.json` runs them, in every project, and they stay silent in one without `MISTAKES.md` or `.agent-brain/`.

Whether memory files are gitignored is **that repo's** policy, not something the skill hardcodes by folder name.

## Steps

From the **project root** (cwd = that repo), run the script with **no flags**. `--project-dir` defaults to cwd; `--skill-dir` defaults to the skill folder that contains the script.

```bash
python "<skill_root>/scripts/init_project.py"
```

(`python3` where `python` isn't Python 3.)

Read the output:
   - **"Already initialized … Nothing changed"** — the project is up to date.
   - **"repaired"** lines — what was missing and is now in place.
   - **"ACTION REQUIRED"** lines — what init won't do by itself: a tracked settings file that still registers hooks from an older install, or an older global copy of the skill in `~/.claude/skills/mistake-brain`. Tell the user each one.

## What it creates or changes

| Path | Purpose |
|---|---|
| `MISTAKES.md` | Append-only event inbox |
| `.agent-brain/shared/{Projects,Areas,Resources,Archives}/` | PARA folders, one store for Claude Code and Cursor |
| `.agent-brain/shared/MEMORY.md` | The one session index every harness reads and writes (always-on, ~200-line cap). Merges in any pre-existing per-harness `MEMORY.md` files; its lesson counts and dates come from `scripts/rebuild_index.py`. |
| `.cursor/rules/mistake-brain.mdc` | Cursor standing rule. Reads the shared index. |
| `.claude/rules/mistake-brain.md` | Standing log + retrieval instruction |
| `CLAUDE.md` | The standing-instruction section, only when git doesn't track `CLAUDE.md`; a tracked one is left byte-identical and the section goes into `.claude/rules/mistake-brain.md` |
| `.claude/settings.local.json` / `.claude/settings.json` | Only to **remove** mistake-brain hooks an older install registered (a tracked file is reported instead) |
| `.git/info/exclude` | Lists the hooks' runtime files, `.claude/mb-head-state.txt` and `.claude/mb-pending-candidates.json` |

It also removes `.agent-brain/claude/` and `.agent-brain/cursor/` when a migration left them empty.

## After init

- After the first fix: `/brain-hud:mistake-brain log <description>`
- At the end of the first task: `/brain-hud:mistake-brain route`
