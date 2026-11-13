<p align="center">
  <img src="https://unpkg.com/hffmnnj.runes/assets/banner.png" alt="Runes: project-local scripts as OpenCode Code Mode tools" width="100%">
</p>

# Runes

Project-local reusable scripts for OpenCode V2. Runes turns the small scripts a
project keeps under `.opencode/.runes/` into typed Code Mode tools, so an agent
can discover and run them by name instead of rebuilding the same one-off
command.

Storage and path params are scoped to the invoking project, and every operation
is permission-gated. There is no CLI, no shell interception, and no global
registry.

## Install

Requires OpenCode V2 and Bun 1.4.2 or newer. Add the package to your OpenCode
config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["hffmnnj.runes"]
}
```

The npm package and the plugin id are both `hffmnnj.runes`. OpenCode reloads the
config on save.

Runes registers one Code Mode namespace, `runes`, with five tools. They are
reached through `execute` (use `search` inside Code Mode to discover the exact
`tools.runes.*` paths), not through a shell command.

## Quick start

Save a rune once, then call it by name with typed params:

```ts
await tools.runes.save({
  manifest: {
    version: 1,
    name: "text-preview",
    description: "Length and first 500 characters of a project text file.",
    language: "typescript",
    interface: "native",
    entry: "main.ts",
    params: { path: { type: "path", required: true } },
    effects: "Reads one project file.",
  },
  source: `export default async function (params: { path: string }) {
  const text = await Bun.file(params.path).text();
  return { characters: text.length, preview: text.slice(0, 500) };
}`,
});

return await tools.runes.run({
  name: "text-preview",
  params: { path: "README.md" },
});
```

`run` returns `{ name, value, durationMs }`, where `value` is the JSON value the
rune produced. Params are validated before execution, and `path` params must
stay inside the project.

## Rune format

Each rune lives at:

```
.opencode/.runes/<name>/rune.json
.opencode/.runes/<name>/main.js | main.ts | main.py
```

`rune.json` is a version 1 manifest with an exact key set:

```json
{
  "version": 1,
  "name": "json-peek",
  "description": "Shape of a JSON file: keys, row count, one sample.",
  "language": "python",
  "interface": "native",
  "entry": "main.py",
  "params": {
    "path": { "type": "path", "required": true },
    "depth": { "type": "integer", "default": 2, "min": 1, "max": 5 }
  },
  "effects": "Reads one project file.",
  "timeoutMs": 30000
}
```

- `name` matches `[a-z][a-z0-9-]{0,63}`. The entry filename must match the
  language: `javascript` → `main.js`, `typescript` → `main.ts`, `python` →
  `main.py`.
- Param types are `string`, `number`, `integer`, `boolean`, and `path`, with
  `required`, `default`, `enum`, and numeric or length `min`/`max` as
  applicable. Values are never coerced: a string `"2"` is not an integer `2`.
- `effects` is a short declaration (max 120 chars) shown at authorization
  time. It is not a sandbox.
- Size caps: manifest ≤ 32 KiB canonical JSON, source ≤ 256 KiB, valid UTF-8.

The full schema, parameter rules, and legacy `argv` encodings are documented in
[FORMAT.md](https://unpkg.com/hffmnnj.runes/docs/FORMAT.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `runes.list` | Bounded summaries (`name`, `description`, `language`, `effects`) with optional query/offset/limit. Reads manifests only; never loads or returns source. |
| `runes.inspect` | Manifest plus content hash. Returns source (up to the 256 KiB source bound) only with `includeSource: true`. |
| `runes.save` | Create-only. Input is `{ manifest, source }`. An existing name is never overwritten: a save with the same manifest and source reports `created: false`; anything else fails with `exists`. |
| `runes.run` | Input is `{ name, params }`. Validates params, executes in a separate child process, and returns the rune's single JSON value. |
| `runes.migrate` | Explicit conversion of legacy `.blocks` files. Defaults to `dryRun: true`; previews without writes or edit permission. |

Catalog limits: at most 1000 entries, list pages at most 50, `run`
stdout+stderr at most 64 KiB, default timeout 30 seconds, maximum 5 minutes.

There is no update path in this version. To change a rune, save it under a new
name or make a reviewed file edit.

## Writing a rune

Native JS/TS entries export one default function. It receives the validated
params object and returns a JSON value:

```ts
// main.ts
export default async function (params: { greeting: string; count: number }) {
  return { message: `${params.greeting} x${params.count}` };
}
```

Native Python entries read the params object from stdin and print exactly one
JSON value to stdout:

```python
# main.py
import json, sys

params = json.load(sys.stdin)
print(json.dumps({"message": f"hello {params['name']}"}))
```

Console output in JS/TS goes to stderr; only the returned value becomes the
result. A run succeeds only with exactly one valid UTF-8 JSON value. Invalid
JSON, non-UTF-8 output, or a nonzero exit fails clearly.

Native JS/TS source runs from an in-memory snapshot as a data module, so there
is no reliable relative file import and no meaningful `import.meta` filesystem
path. Use Node builtins and `path` params resolved against the project working
directory instead.

## Security

Runes is not a sandbox. Scripts run unsandboxed with the user's authority: they
inherit the host environment (no `.env` file is loaded automatically), can read
environment variables and arbitrary files the user can access, import arbitrary
modules, and start detached processes. Save and run only source you trust.
Arbitrary imports and transitive dependencies are user-authorized trust, not
hashed or pinned; only the manifest plus entry source are content-hashed.

Before execution, `run` requires both `bash` and `runes.run` permission, each
carrying the full execution identity (interpreter, project root, rune name,
content hash, declared effects, and actual params). Denial of either prevents
execution. `save` and applied migration require `edit` permission for the
destination paths before mutation; reading rune files requires `read`
permission for those exact files.

Rune storage cannot escape the invoking project: absolute paths, `..`
components, and symlinks beneath the root are rejected. Declared path params
receive the same confinement; outside-project values are rejected, not
authorized, and there is no external-directory permission. Cancellation is
best-effort: SIGTERM goes to the owned process group with SIGKILL escalation,
but scripts that deliberately escape the group (for example with `setsid`) are
not contained.

The full threat model and enforcement boundaries are in
[SECURITY.md](https://unpkg.com/hffmnnj.runes/docs/SECURITY.md).

## Migration from Caveman Blocks

Migration is additive and lazy. Originals under `.blocks/` are preserved
byte-for-byte, provenance (path, SHA-256, header metadata) is recorded under
`manifest.legacy`, existing rune names are never overwritten, and conflicts are
reported as `unsupported` rather than guessed. Lazy automatic migration may run
once per project on explicit `list`, `inspect`, or `run` use, permission-gated,
and never executes converted scripts.

Headered unambiguous Python converts automatically: a `# /// block` TOML header
with `str`, `int`, `float`, or `path` scalar params. Headerless files, JS/TS
files, and `bool` params need a reviewed override in
`.opencode/runes-migration.json` (version 1, exact `.blocks` path,
`{ sha256, manifest }`, never executed). Reviewed `legacy.argv` mappings handle
booleans as bare flags and string arrays as repeated `--key=value` pairs. An
optional reviewed `adapter: { source, sha256 }` can carry a bounded native
adaptation, such as a legacy server script converted to a loopback lease that
returns one JSON value instead of running forever.

Non-script files (INDEX, configs, lockfiles, fixtures, caches) are ignored, and
historical stamps or `allow_effects` are never carried over as verification or
authority. Dry-run `migrate` is the safe way to preview a project before
applying it.

## Limits and non-goals

- Bun ≥ 1.4.2 is required. Python runes need Python 3.11 or newer. Legacy
  JS/TS `argv` runes need Node ≥ 22.15 or 23.5 (tested on Node 26.9 only). The
  native `@opencode/plugin` API is the only runtime dependency.
- No CLI, no automatic verification stamps, and no global registry. Migration
  overrides are exact-path entries only; there is no whole-project source
  autoload.
- Native JS/TS runes execute from a snapshotted data module, so relative file
  imports and `import.meta` filesystem paths are not reliable. Legacy JS/TS
  `argv` runes are the exception: the exact entry snapshot runs under Node with
  its original URL, while dependencies resolve normally through the host.
- Execution is bounded by the 64 KiB run output cap and the timeout above.
  Process-group cleanup is best-effort; there is no absolute no-survivors
  guarantee.
