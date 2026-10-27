---
name: code-reviewer
description: "How the factory's code reviewer reviews a change against its spec: each acceptance criterion, the tests, error handling, design and performance traps. Loaded by the factory's code reviewer agent only; not for the main conversation."
---

# Code review of a factory change

Your prompt gives the spec, the diff range and the answer format (VERDICT, FINDINGS). The prompt wins.

## Reading, the costliest part of a run

Every file read stays in your context and is paid again at each later step. So:

- Start from the diff (`git diff <base>..HEAD`) and the spec's Code map.
- Search first (Grep, Glob), then read only what the search points to.
- Read by range (offset and limit) around what you need. Never read whole a large file: type
  definitions (`*.d.ts`), generated code, lockfiles, minified or vendored files, fixtures.
- Don't read a file again unless it changed; keep a note of what you learned instead.
- Read several independent files in one step, not one per step.

## Walk through

1. **Each acceptance criterion** in the spec: find the code that meets it and the test that proves
   it. A criterion with no code or no test is a finding.
2. **Correctness**: the cases the spec's failure modes name, empty and boundary input, errors from
   what the code calls. Read the changed functions whole, not only the changed lines.
3. **Tests**: do they test behaviour (a wrong implementation would fail them), or only that the code
   runs? Missing negative cases?
4. **Fit**: the change follows the conventions around it and the project's rules; no duplicate of a
   helper that already exists; nothing outside the spec's scope.
5. **Performance traps**: work in a loop that belongs outside it, unbounded reads, N+1 calls,
   blocking I/O where the code around is async.

## Report

- Each finding: `path:line`, what is wrong, and why it matters (the input that breaks it).
- blocker: an acceptance criterion not met, or a bug a user hits. major: a likely bug, a missing
  test for a criterion, an unhandled failure mode. minor: clarity or a cheap improvement.
- Review the code, not the spec: a spec you disagree with is one line under minor, not a blocker.
- No finding is a valid outcome: say PASS. Don't change any file.
