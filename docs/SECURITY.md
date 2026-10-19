# Rune security

Threat model in one sentence: runes are the user's own scripts running with
the user's authority — the plugin confines rune storage and declared path
params to the project and gates operations on read/edit/run permissions,
but it is not an OS sandbox. Scripts run unsandboxed: they inherit the host
environment, can read environment variables and arbitrary files the user
can access, import arbitrary modules, or start detached sessions.

## Project confinement, not global install

Every operation resolves against the invoking session's current directory
(`projectRoot` + `safePath`), never the global plugin location. Rune storage
cannot escape that project: absolute paths, `..` components, and any symlink
beneath the root are rejected. Declared path params get the same treatment:
outside-project values are rejected, not authorized. There is no
external-directory authorization.

## Permissions are the enforcement point

- `run` requires **two** authorizations before spawning, both carrying the full
  execution identity (interpreter, project root, rune name, content SHA-256,
  declared effects, actual params): `bash` and `runes.run`. Denial of either
  prevents execution; denials propagate unwrapped.
- `save` and applied (non-dry-run) `migrate` require `edit` permission for the
  destination paths **before** mutation. Reading rune sources, manifests, or
  `.blocks` files requires `read` permission for those exact files; listing
  authorizes each manifest it reads. Dry-run `migrate` never asks for `edit`
  and never writes. Permission denials propagate unwrapped and prevent the
  operation.
- Save is create-only with exclusive creation: two simultaneous saves cannot
  overwrite each other, and an existing name fails with `exists` unless the
  content is byte-identical (reported `created: false`).

## Execution boundaries

- Scripts run in a child process (`python3 -I`, `bun`, or `node` for legacy
  JS/TS), never inside the OpenCode server process, never through a shell,
  from an approved in-memory source snapshot — not by re-reading mutable
  files after authorization. Legacy JS/TS replaces only the exact entry URL
  via Node `registerHooks` (Node >= 22.15 / 23.5); dependency specifiers and
  the transpiled-TS snapshot aside, imports resolve normally through the host
  and are not hashed or isolated.
- Bounds: `run` stdout+stderr ≤ 64 KiB (excess kills the run with `output_limit`),
  distinct from the ≤ 256 KiB source bound returned by `inspect` with
  `includeSource: true`; the user catalog (`list`) reads manifests only and
  never loads source bodies. Default timeout 30 s / max 5 min (`timeout`), and
  caller cancellation aborts via `AbortSignal`: best-effort SIGTERM to the
  owned process group with SIGKILL escalation. Scripts that deliberately
  escape the group (for example via `setsid`) are not contained, so there is
  no absolute guarantee of no surviving subprocesses. Nonzero exit, invalid
  JSON, oversized or non-UTF-8 output all fail without side effects beyond
  what the script already did while running.
- `effects` and manifest path checks are correctness declarations and audit
  aids, not isolation. Do not represent a rune as read-only or sandboxed.
- Child processes inherit the host environment; nothing loads a `.env` file
  automatically, and the environment is not a secret boundary — treat script
  content, params, and effects identity as user-authorized trust. Python/JS
  imports and transitive dependencies are not hashed or pinned: only the
  manifest plus entry source are content-hashed.

## Migration safety

Conversion parses `.blocks` headers with `Bun.TOML.parse` only — legacy source
is never evaluated during conversion, including override-listed originals and
adapter sources (adapter hash staleness is a refusal, not a fallback).
It is additive and idempotent:
originals preserved byte-for-byte, provenance recorded, existing rune names
never overwritten (identical provenance plus byte-identical source reports
`existing`, conflicts report `unsupported`), catalog and report sizes bounded. Reviewed overrides live only in `.opencode/runes-migration.json` (version 1, exact `.blocks` paths, `{ sha256, manifest, adapter? }` with strict schema/hash/size checks and `read`-permission-gated loads): raw original hash and adapter hash are both verified, language/entry must match the original, `native` interface only with an `adapter`, and no whole-project autoload occurs. Lazy auto-conversion runs at
most once per project and only on explicit `list`/`inspect`/`run` use, with
edit authorization, and never executes converted scripts by itself.
Unsupported inputs (unreviewed languages, ambiguous boolean encodings, unknown
schemas) are reported with reasons, and historical stamps / `allow_effects`
are never treated as trust.
