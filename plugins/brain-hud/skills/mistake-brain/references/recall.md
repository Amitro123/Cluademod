# /brain-hud:mistake-brain recall

Load at most two PARA lesson files that match the current task. Invoked by `/brain-hud:mistake-brain recall [optional query]`, and also when starting a task that might match a prior lesson, retrying a failed approach, or the user mentioning a recurring bug.

This is the **on-demand** half of retrieval. The always-on half is the SessionStart briefing (MEMORY.md, capped at 200 lines). Recall must not dump the inbox or the whole brain.

## Procedure

1. **Do not re-read MEMORY.md** if it is already in context (SessionStart `additionalContext`, a Cursor rules-driven read earlier this session, or a prior recall). If it is not in context, read the shared index once: `.agent-brain/shared/MEMORY.md` — the same file every harness reads and writes. Never the raw PARA folders first, never `MISTAKES.md`.

2. From the index (Projects, Areas, Resources only), pick **at most 2** files whose one-line summaries match the current task or the optional query. Archives are not in the hot index; open an Archives file only if the query is explicitly historical ("what did we do last time this incident happened?").

3. Read only those files. If two candidates are equally plausible, prefer the more specific one (Project over Area over Resource).

4. If nothing matches, say so in one line and continue the task. Do not search `MISTAKES.md`, do not grep `.agent-brain/`, and do not "load a few extra files just in case."

5. Apply any loaded lessons to the current work. Do not re-log them; logging is a separate `/brain-hud:mistake-brain log` if a *new* event happens.

## Hard rules

- Never read `MISTAKES.md` top-to-bottom for retrieval. The inbox is for `log`/`route`, not for briefing a session.
- Never load more than 2 PARA files in one recall pass.
- Never open Archives unless the query is explicitly historical.
- Cursor's briefing comes from `hooks/cursor_brief.py` when it is registered in `~/.cursor/hooks.json`, reading the same shared index Claude Code's `SessionStart` hook reads. If that briefing is not in context, step 1's single index read is the fallback — still do not dump PARA.
