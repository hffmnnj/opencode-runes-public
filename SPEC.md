# opencode-runes

## Goal

Replace Caveman Blocks with a compact, project-local reusable-script plugin, accessed through native OpenCode V2 Code Mode tools rather than a CLI. Reuse scripts without repeatedly emitting their source or loading a complete catalog into context.

## Scope and architecture

- Store each rune in `.opencode/.runes/<name>/` with a small `rune.json` manifest and a JavaScript, TypeScript, or Python entry file. No generated index, stamp, registry, telemetry, shell interception, or CLI.
- Expose the `runes` Code Mode namespace: `list`, `inspect`, `save`, `run`, and `migrate`. Discovery returns bounded summaries, not source. Inspection loads source only on request.
- Native JavaScript and TypeScript entries export a default function receiving a JSON params object; Python entries read that object from stdin and print one JSON value. Legacy converted scripts retain their argv interface. Execute scripts in a child process, never inside the OpenCode server.
- Use typed, validated scalar parameters (string, number, integer, boolean, path), required/default/enum metadata, strict unknown-parameter rejection, timeouts, and hard source/output/catalog limits.
- Resolve each operation against the invoking session's current directory, not the global plugin location. Rune storage cannot escape that project through path traversal or symlinks.
- Run requires OpenCode permission checks with the interpreter/worker identity, parameters, source identity, and declared effects. Save/migration require exact-file edit permission; native reads require exact-file read permission. External path parameters are rejected. Permission errors propagate. Cancellation terminates the owned child process group; deliberately detached/escaped processes are outside this boundary. Manifest effects and path checks are correctness safeguards, not an OS sandbox. Scripts run with the user's authority and must not be represented as read-only isolation.
- Caveman migration is additive and idempotent. Parse supported real `.blocks` formats without executing them, preserve originals byte-for-byte, retain provenance, never grant permissions or overwrite existing runes, report unsupported formats and dependencies. Automatic conversion is lazy on first explicit tool use, permission-gated, and never runs converted scripts. Explicit `migrate` supports a dry-run preview.
- Replace the global auto-discovered Caveman adapter only after tests and independent acceptance/security review. Archive rather than delete it and the command symlink, back up AGENTS/config, install Runes without restarting shared services, and document rollback.

## Acceptance checks

1. Save, discover, inspect, and execute all three languages with defaults and non-default typed inputs; subsequent calls do not resupply source.
2. Invalid names/params, unknown params, symlink escapes, malformed manifests, oversized output, invalid JSON, nonzero exit, timeout, and cancellation fail clearly without unintended writes or surviving owned subprocesses.
3. Denied run/edit permissions prevent execution/mutation; permission identity includes script contents and params. Session location overrides global plugin location correctly.
4. Convert fixtures copied from example-project-a, example-project-b, and global Blocks; verify idempotence, no overwrite, byte-preserved originals, meaningful supported executions, and explicit unsupported reports.
5. Plugin typechecks/builds and registers through the installed OpenCode V2 API. Check actual installation loading and Code Mode discovery without interrupting unrelated sessions.
6. Global guidance describes Runes tools and security accurately, contains no active Caveman managed section, and rollback artifacts are verified.

## Delivery

Private repository: `hffmnnj/opencode-runes`. Topic branch: `feat/code-mode-runes`. Verified logical checkpoints will be recorded separately. No direct push to a protected/default branch and no merge without authorization.
