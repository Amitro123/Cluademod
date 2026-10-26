# /brain-hud:mistake-brain update

The skill and its hooks are the brain-hud plugin's, so they update with the plugin: `/plugin update brain-hud@claudemod`, then a new session. There is no separate copy to refresh.

`update` brings a project up to date with the installed version: run init again. It is idempotent, so on an up-to-date project it changes nothing.

```bash
python "<skill_root>/scripts/init_project.py"
```

On an older project it:
- merges legacy per-harness `MEMORY.md` files into `.agent-brain/shared/MEMORY.md` and moves legacy lesson trees into `.agent-brain/shared/`;
- removes the hook entries an older install registered in `.claude/settings.local.json` (or reports them in a tracked `.claude/settings.json`), so no hook fires twice;
- reports an older global copy in `~/.claude/skills/mistake-brain`, which would load as a second, older `mistake-brain` skill;
- writes the standing instructions that are missing, and refreshes the index's counts and dates.

Report the script's "repaired" and "ACTION REQUIRED" lines to the user.
