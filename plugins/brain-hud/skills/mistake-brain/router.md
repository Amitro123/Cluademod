# router.md — classify MISTAKES.md entries into PARA

Invoked by `/brain-hud:mistake-brain route`. Goal: take every entry in `MISTAKES.md` still marked `Status: unrouted` and give it a permanent home in `.agent-brain/shared/`, so the raw log can stay a fast inbox instead of the thing anyone has to actually search.

Applies uniformly to all four `Type`s (`mistake`, `success`, `decision`, `handoff`) — the PARA decision tree below doesn't branch on `Type` at all. A `handoff` entry gets exactly the same routing treatment as a `mistake` entry; there's no separate lifecycle or destination for it (see `SKILL.md`'s Concurrency section for why a special handoff status was rejected).

## Procedure

MISTAKES.md is append-only — routed and promoted entries stay in it, they just get their `Status` flipped in place. Left unchecked that means both the file and the cost of reading it grow forever, even though only a shrinking fraction of it (the still-unrouted entries) is ever relevant to a route pass. Two independent fixes, run in order:

1. Run `python <skill_root>/scripts/compose_mistakes.py MISTAKES.md` first. This is a mechanical, no-judgment-required step — the script itself decides whether the file is even over its line threshold (default 400 lines) and, if so, moves the oldest already-`routed`/`promoted` entries (never `unrouted` ones — those have no other copy yet) into a single `MISTAKES-archive.md`. Below threshold, it's a no-op. This keeps the active file bounded by size, not by an agent tracking dates or deciding what still "matters" — that judgment call is exactly the kind of thing worth keeping out of a routine pass, since it just adds cost without a payoff (see `promote.md` for the one tradeoff this creates).
2. `Grep` `MISTAKES.md` for the pattern `^- \*\*Status:\*\*\s*unrouted\s*$` (matching the actual rendered field text from `format-spec.md`, bold markers included, anchored to the whole line) with 5 lines of context before each match (`-B 5`, content mode). The line anchors matter: an unanchored substring match will also fire inside a free-text field that happens to quote the field format as an example (this has already happened once — see MISTAKES.md), pulling back a bogus "entry" that doesn't parse. Each real match's context block is a complete entry — header, all fields, through the `Status` line — so this pulls back exactly the entries that need routing and nothing else. If there are no matches, say so, emit `ROUTING_JSON:` followed on the next line by `{"routed_count":0,"routed_entries":[]}`, and stop — nothing else to do.
3. For each unrouted entry, in oldest-to-newest order (so earlier context isn't lost if two entries are related), apply the decision tree below to pick exactly one PARA category and destination file. Do this classification for *all* pending entries before writing anything.
4. Group the classified entries by destination file. For each destination file touched by one or more entries (create it if it doesn't exist yet, using the lesson-block format below — PARA folders do not have per-folder README.md files, this is the only format to follow): read it once, then write all of that file's new lesson blocks in a single edit — not a separate read-then-edit per entry. If three entries all land in `Areas/ci.md`, that's one read and one edit of `Areas/ci.md`, not three. Each lesson block:
   ```md
   ## [YYYY-MM-DD] <short title, can reuse the MISTAKES.md title>
   - Added: YYYY-MM-DD HH:MM
   <the actionable takeaway, rewritten as an imperative instruction, 1-2 sentences>
   Source: mistake log entry [YYYY-MM-DD HH:MM] <title>
   ```
   The one-line takeaway comes from whichever field carries it for that entry's `Type` (see `references/format-spec.md`): `Prevention rule` for `mistake`, `Repeat guidance` for `success`, `Rationale` for `decision`, `Next steps` for `handoff`. Insert newest-first within that file too. Cite the entry by date and title, not by file path — `compose_mistakes.py` may later move the entry itself from `MISTAKES.md` into `MISTAKES-archive.md`, and the citation should stay meaningful either way.

   The `Added` field is what lets `dream.md` assess an individual entry's freshness — independent of `MEMORY.md`'s own per-file "last updated" date, which only tells you when a file was *last touched at all*, not how old any given entry inside it is. A PARA file can look "recently updated" in `MEMORY.md` because of one new entry while everything else in it is stale; `Added` is the signal that catches that.
5. Go back to `MISTAKES.md` and update each routed entry's two fields in place (nothing else in the entry changes) — targeted, not a rewrite of the file, so this stays cheap regardless of how large MISTAKES.md has grown:
   ```md
   - **PARA route:** <Project|Area|Resource|Archive>: <file path>
   - **Status:** routed
   ```
   When more than one entry is being routed in this pass, make these edits in a single `MultiEdit` call against `MISTAKES.md` (one edit operation per entry) instead of a separate `Edit` call per entry — same principle as step 4's "one read, one edit" for the destination file, applied to the source file. Each operation is still a targeted diff; batching them into one tool call just avoids N-1 avoidable round trips for an N-entry pass.
6. After all entries are processed, update the shared `.agent-brain/shared/MEMORY.md` — the one session index every harness reads. Your part is the **summary**: for each **Project / Area / Resource** file you touched, make sure its line in the right section reads `- [Area] Areas/<file>.md — <one-line summary of what the file covers>`, adding the line for a new file and rewording the summary when the file's scope changed. Then run, as the last step:

   ```bash
   python "<skill_root>/scripts/rebuild_index.py" --project-dir .
   ```

   It writes every line's `(N lessons, last updated YYYY-MM-DD)` from the lesson headings on disk, adds a line (with the file's first paragraph as its summary) for any lesson file the index lacks, and sets the `Archives: N files (not loaded at session start)` count. Never type a count or a date yourself — those are facts on disk, and a hand-written one is how the index went stale before. **Archives stay off the hot index**: don't add Archive destinations to the Projects/Areas/Resources sections. Keep MEMORY.md under 200 lines (see `references/dream.md`). The plugin's hooks also run the script after any lesson file is written and at session start, so the counts stay right even if this step is missed — but the summaries are only as good as you write them.

   Index gate, off unless the project sets `MISTAKE_BRAIN_INDEX_GATE=1`. When that variable is unset or any value other than `1`, do step 6 exactly as written above. When it is `1`, still write the shared lesson file and still set `Status: routed`, and do not add the MEMORY.md line in this pass (`rebuild_index.py` honours the gate: it refreshes the counts of lines already there and adds none). Tell the user the lesson is written and waiting for approval. On approval, run `python <skill_root>/scripts/index_admission.py --project-dir <project> --line "<the same bullet>"`. That writes the bullet into the shared `.agent-brain/shared/MEMORY.md`. Do not enable the gate from `init`. An unapproved lesson stays in `.agent-brain/shared/` and stays out of the session index.
7. Report a short summary to the user: how many entries were routed and where (and, if step 1 archived anything, mention that too). Don't ask for confirmation for this pass — routing into `.agent-brain/` is knowledge classification, not a change to agent behavior, so it's low-stakes and easily corrected on the next `dream` pass (see SKILL.md's "Safety" section for the full route-vs-promote asymmetry — the confirmation gate is only for `promote`, which changes behavior going forward).
8. After the prose summary, emit exactly one machine-readable routing summary. Write the exact marker `ROUTING_JSON:` on its own line, followed by one valid JSON object on the next line with exactly two top-level fields: `routed_count` and `routed_entries`. `routed_count` must equal the number of objects in `routed_entries`; emit one object per routed entry, in the same oldest-to-newest order used for classification. Each entry object must contain:
   - `source_entry`: the source entry's `[YYYY-MM-DD HH:MM] <title>` identifier.
   - `destination_file`: the repo-relative `.agent-brain/shared/...` file path written in step 4.
   - `para_bucket`: exactly one of `Project`, `Area`, `Resource`, or `Archive`, matching the existing `PARA route` vocabulary.
   - `priority`: `null`. This router has no priority scale; do not invent one or import another router's scale.
   - `promotion`: `false`. Routing never promotes; promotion remains the separate, approval-gated procedure in `promote.md`.
   - `conflict`: `null`. This routing pass has no conflict-detection step; do not add a conflict scan while producing instrumentation.
   - `reasoning`: one sentence explaining why the existing decision tree selected this PARA bucket and destination.

   Do not replace, wrap, or alter the prose summary from step 7. The JSON object is an additional final output. The HTML comments below only identify the contract examples for automated tests; do not emit them during a routing pass.

   Non-empty example (preceded by `ROUTING_JSON:` when emitted):

   <!-- ROUTING_JSON_NON_EMPTY_EXAMPLE -->
   ```json
   {
     "routed_count": 1,
     "routed_entries": [
       {
         "source_entry": "[2026-08-18 10:22] Test-first removal of dogfood hook duplication",
         "destination_file": ".agent-brain/shared/Areas/testing.md",
         "para_bucket": "Area",
         "priority": null,
         "promotion": false,
         "conflict": null,
         "reasoning": "This is recurring testing guidance that remains useful beyond one project."
       }
     ]
   }
   ```

   Empty example for the early exit in step 2 (also preceded by `ROUTING_JSON:` when emitted):

   <!-- ROUTING_JSON_EMPTY_EXAMPLE -->
   ```json
   {
     "routed_count": 0,
     "routed_entries": []
   }
   ```

## Decision tree

Ask these in order; stop at the first "yes."

1. **Is this tied to a specific piece of work that's still open right now** — the current task, an active branch, an open ticket, a feature not yet shipped? → **Project**. File: `.agent-brain/shared/Projects/<project-slug>.md`. Name the slug after whatever the project is actually called in this session (branch name, ticket ID, feature name) — don't invent a new name if one is already in use elsewhere in the codebase or conversation.

2. **Is this about a domain the agent will keep coming back to, independent of which project** — authentication, CI/CD, database migrations, a specific external service, testing conventions? → **Area**. File: `.agent-brain/shared/Areas/<area-slug>.md`. Reuse an existing Area file if one already covers this domain; check `MEMORY.md`'s Areas section before creating a new one, since fragmenting one domain across two files defeats the purpose.

3. **Is this a general principle that would still be true in a completely different codebase** — a security practice, an error-handling convention, a review habit? → **Resource**. File: `.agent-brain/shared/Resources/<topic-slug>.md`.

4. **Otherwise — is this closed and unlikely to recur** (a one-off incident, an external outage, a bug in a dependency that's since been patched, a project that no longer exists)? → **Archive**. File: `.agent-brain/shared/Archives/<year>/<slug>.md`.

If none of these feel right after honestly working through them in order, default to **Area** — an overly broad Area file is easy to split later during `/brain-hud:mistake-brain dream`, whereas a lesson stuck in Archive is effectively invisible to future work.

## Judgment calls worth pausing on

- **Project vs. Area**: if you're not sure whether the current work is really a one-off project or actually a recurring domain, ask: "will this lesson matter once this specific task is done?" If yes, it's an Area, not a Project.
- **Area vs. Resource**: an Area lesson mentions a specific system by name ("our auth service always returns 200 on failed login"). A Resource lesson would read the same with the specifics genericized ("don't trust HTTP status codes alone to detect failure — check the body").
- **Ambiguous entries**: if an entry genuinely spans two categories (e.g. a project-specific instance of a general principle), route it to the more specific one (Project or Area) and only promote it to a Resource later if `/brain-hud:mistake-brain promote` or `/brain-hud:mistake-brain dream` notices the same principle recurring across *different* projects/areas.
- Never invent a fifth category or a subfolder structure beyond `<year>/` under Archives. If the PARA files start feeling unwieldy, that's what `/brain-hud:mistake-brain dream` is for — don't solve it ad hoc during a routing pass.
