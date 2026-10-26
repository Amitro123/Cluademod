# History

The mistake-brain skill started as a standalone skill, installed in `~/.claude/skills/mistake-brain` with its hooks registered in each project's settings. It now ships inside the brain-hud plugin, so the memory and the view of it install, update and work as one.

Changed when it moved:
- The hooks are the plugin's (`hooks/hooks.json`, through `hooks/run.sh`): `init` registers none, removes those an older install registered, and the hooks stay silent in a project without mistake-brain.
- `scripts/rebuild_index.py` writes the index's lesson counts and dates from the lesson files; route, dream, init and the hooks run it.
- `init` leaves a git-tracked `CLAUDE.md` alone and keeps the hooks' runtime files out of git.
- The Checker reports a missing `Status` and a timestamp in the future; `log` takes the time from the shell.
- The command is `/brain-hud:mistake-brain`; `install_global.py` and `update_hook.py` are gone (the plugin is the install, and `update` is `init` again).
