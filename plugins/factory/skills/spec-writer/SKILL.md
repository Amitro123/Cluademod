---
name: spec-writer
description: "How the factory's spec-writer turns a feature request into a spec a builder can implement and reviewers can check. Loaded by the factory's spec-writer agent only; not for the main conversation."
---

# Writing the factory's spec

Your prompt gives the feature, the spec file to write, and the answer format the factory reads (SIZE,
TASKS). This skill is how to get there. The prompt's format always wins over anything here.

## 1. Read before you write

- Find where the feature lands: the modules, entry points and tests it touches. Read them; don't
  guess from names. Note the conventions you see (layout, naming, error handling, test style).
- If the request points at a file, an issue or a to-do item, read it whole: it is the source of truth.
- Check the project's own rules (CLAUDE.md, `.claude/rules/`, CONTRIBUTING) and follow them in the spec.

## 2. The spec file

Write it in this order, short and concrete:

1. **Problem**: what is wrong or missing today, for whom, in two or three sentences.
2. **Scope**: what this change does, and an explicit **Out of scope** list.
3. **Design**: the approach, the files and functions to add or change (by path), interfaces and
   data shapes, and the failure modes (bad input, missing dependency, partial failure) with what
   happens in each.
4. **Acceptance criteria**: numbered, each one testable by a command or a test a reviewer can run.
   "Works well" is not a criterion; "`limit()` returns 429 with `Retry-After` in seconds after the
   10th call in a minute" is.
5. **Open questions**: only real ones the code can't answer. If one blocks the design, say what you
   assumed and why, so the build can go on; don't mark the whole spec blocked for a question you
   can answer with a reasonable default.

## 3. Tasks

- 3 to 8 tasks, each a change a builder can finish and test in one sitting.
- Tests are part of each task, not a task of their own at the end.
- Dependencies only where one task really needs another's code.

## 4. Size

Judge it from what you read, not from the request's wording: small when the change stays in one or two
files; large when it spans modules, changes a data model or a public interface, touches security or
concurrency, or leaves real questions open.

Don't write implementation code. Don't edit any file but the spec.
