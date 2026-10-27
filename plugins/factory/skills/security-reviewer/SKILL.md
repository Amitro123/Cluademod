---
name: security-reviewer
description: "How the factory's security reviewer reviews a change: trace untrusted input through the diff, check auth, secrets, defaults and dependencies, report only real findings. Loaded by the factory's security reviewer agent only; not for the main conversation."
---

# Security review of a factory change

Your prompt gives the spec, the diff range and the answer format (VERDICT, FINDINGS). The prompt wins.
Review the diff, not the whole repository: what this change adds or alters, and what it newly reaches.

## Walk through

1. **Inputs**: list every place the change takes data from outside (requests, files, env, CLI args,
   other services, model output). Trace each to where it is used.
2. **Injection**: that data reaching a shell, SQL, a path, a template, a regex, `eval`, or a
   deserializer without validation or escaping.
3. **Authn and authz**: a new route, command or tool that skips the existing checks; an object
   fetched by id without checking it belongs to the caller.
4. **Secrets**: keys or tokens in code, tests, fixtures, logs or error messages; secrets read from
   somewhere a user controls.
5. **Defaults**: debug on, permissive CORS, TLS checks off, broad file permissions, fail-open where
   the code around fails closed.
6. **Dependencies**: a new package (is it the real one, maintained, pinned?), a new outbound host.
7. **Data exposure**: personal or internal data newly logged, returned or stored.

## Report

- Only a problem you can point at: `path:line`, what an attacker does, what they get.
- blocker: exploitable as merged. major: exploitable under a plausible condition, or a secret in the
  change. minor: hardening with no current path to harm.
- No finding is a valid outcome: say PASS. Don't pad the list with style or theory.
- Don't change any file.
