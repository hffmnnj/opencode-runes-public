# opencode-runes

Code Mode-only replacement for Caveman Blocks: small, project-local reusable
scripts ("runes") executed through OpenCode V2 Code Mode tools. No CLI, no shell
interception, no global registry.

## Layout

Each rune lives in the invoking project at:

```
.opencode/.runes/<name>/rune.json
.opencode/.runes/<name>/main.js | main.ts | main.py
```

`rune.json` is a validated manifest (version 1, name, description, language,
`native` or `argv` interface, entry filename, typed params, effects string).
See [docs/FORMAT.md](docs/FORMAT.md). Security boundaries are in
[docs/SECURITY.md](docs/SECURITY.md).

## Tools

Five tools in the `runes` Code Mode namespace: `list`, `inspect`, `save`, `run`,
`migrate`. They are Code Mode tools, so agents reach them through `execute`
(using `search` inside Code Mode to discover the exact `runes.*` paths), not
through a shell command.

- `list` — bounded summaries (`name`, `description`, `language`, `effects`),
  with optional query/offset/limit. Reads manifests only; never loads or
  returns source.
- `inspect` — manifest plus content hash. Returns source (up to the 256 KiB
  source bound) only when called with
  `includeSource: true`.
- `save` — create-only. Input is `{ manifest, source }`. An existing name is
  never overwritten: an identical save reports `created: false`, anything else
  fails with `exists`. **v0.1 has no update path:** to change a rune, save
  under a new name or make a manual, reviewed file edit.
- `run` — input is `{ name, params }`. Params are validated, defaults applied,
  unknown params rejected, outside-project path params rejected (no
  external-directory permission), no type coercion. Keep params small and
  results small: manifests ≤ 32 KiB, sources ≤ 256 KiB, `run` stdout+stderr ≤
  64 KiB (separate from the `inspect includeSource` source bound),
  catalog ≤ 1000 entries, list pages ≤ 50.
- `migrate` — explicit conversion of legacy `.blocks` files. Defaults to
  `dryRun: true` (preview, no writes, no edit permission). Lazy automatic
  migration may run once per project on explicit `list`/`inspect`/`run` use
  only, permission-gated, and never executes converted scripts.

## Writing a rune

Native JS/TS entries export one default function that receives the validated
params object and returns a JSON value:

```ts
// main.ts
export default async function (params: { greeting: string; count: number }) {
  return { message: `${params.greeting} x${params.count}` };
}
```

Native Python entries read the same params object from stdin and print exactly
one JSON value to stdout:

```python
# main.py
import json, sys

params = json.load(sys.stdin)
print(json.dumps({"message": f"hello {params['name']}"}))
```

Console/log output in JS/TS goes to stderr; only the returned value becomes
stdout. Legacy `argv` Python runes keep their original `--key=value` interface
plus the original project-relative `__file__` (see FORMAT.md).

Limits that shape rune design: execution must emit exactly one valid UTF-8 JSON
value, default timeout 30 s (max 5 min), cancellation best-effort terminates
the owned process group (scripts that deliberately escape the group, for
example via `setsid`, are not contained — no absolute no-survivors claim).
`effects` (max 120 chars) is a declaration shown at authorization time,
not a sandbox — scripts run unsandboxed with the user's authority: they
inherit the host environment (no automatic `.env` loading; the environment
is not a secret boundary) and arbitrary imports/dependencies are
user-authorized trust, not hashed or pinned.

## Migration from Caveman Blocks

Additive and lazy: originals under `.blocks/` are preserved byte-for-byte,
provenance (path, SHA-256, header metadata) is recorded under
`manifest.legacy`, existing rune names are never overwritten, and conflicts are
reported as `unsupported` rather than guessed. Supported: Python `argv` scripts
with a `# /// block` TOML header (str/int/float/path scalar params; `bool`
params need manual `argv` review and are reported unsupported, not converted).
Recognized script extensions with unsupported formats are reported, not
converted: non-Python scripts (JS/TS location semantics cannot be
preserved), boolean `argv` encodings, unknown schemas/fields, and oversized
headers. Non-script files (INDEX, configs, lockfiles, fixtures, caches) are
ignored, never reported as unsupported. Stamps and `allow_effects` are never carried over
as verification or authority.

## Dependencies and non-goals

- Requires Bun ≥ 1.4.2, Python 3.11+ for Python runes, and the native
  `@opencode/plugin` API (no other runtime dependencies).
- There is no CLI. There are no automatic verification stamps.
- Native JS/TS runes execute from snapshotted source loaded as a data module,
  so there is no reliable relative file import or `import.meta` filesystem
  path; use node builtins and project `cwd` params instead (see FORMAT.md).

## Installation and rollback (procedure)

Installation and rollback are performed by the coordinator. Actual rollout
state and backups are recorded in [docs/INSTALLATION.md](docs/INSTALLATION.md);
primary implementation, integration, Caveman retirement, and independent
post-install verification are complete.

1. Install this plugin through the OpenCode V2 plugin API and verify Code Mode
   discovery of the `runes` namespace without interrupting unrelated sessions.
2. Before replacing anything: archive (do not delete) the global Caveman
   adapter and command symlink, and back up AGENTS/config guidance.
3. Only after tests plus independent acceptance/security review pass, remove the
   active Caveman managed section from global guidance and describe the Runes
   tools accurately.
4. Rollback: restore the archived adapter/symlink, restore the backed-up
   guidance, and remove or disable this plugin. Rune directories already
   created under project `.opencode/.runes/` are inert data and can be kept or
   moved aside reversibly per project (never bulk- or recursively deleted).
