# Rune format

Project-local layout: `.opencode/.runes/<name>/` containing `rune.json` plus
exactly one entry file: `main.js`, `main.ts`, or `main.py`. Entry filename must
match language (`javascript` → `main.js`, `typescript` → `main.ts`,
`python` → `main.py`). Publication writes the entry first and the manifest
last; a rune whose manifest is present and valid is complete.

## Manifest (`rune.json`)

Version 1 object with exactly these keys (unknown keys rejected):

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

- `name`: `[a-z][a-z0-9-]{0,63}`. Param names: `[a-zA-Z][a-zA-Z0-9_-]{0,63}`,
  max 64 params. No `__proto__`/`constructor`/`prototype` keys anywhere.
- Param types: `string`, `number`, `integer`, `boolean`, `path`. Each supports
  `required`, `default`, `enum`; numerics and string/path lengths support
  `min`/`max` (not booleans). Defaults and enum values must match the declared
  type and bounds.
- `description` ≤ 1000 chars, `effects` ≤ 120 chars. `effects` is a short human
  declaration shown at authorization time, not an enforcement mechanism.
- `timeoutMs` optional (default 30000, max 300000). `legacy` is set only by
  migration: `{ path, sha256, format: "caveman-blocks", example?, metadata? }`.
- Size caps: manifest ≤ 32 KiB canonical JSON, source ≤ 256 KiB, valid UTF-8.

## Parameters

`run` input is `{ name, params }`. Validation applies defaults, rejects
unknown or missing-required params, checks types/bounds/enums, and never
coerces (a string `"2"` is not an integer `2`). Path params are confined to
the invoking session's project: absolute/traversal/symlink escapes are
rejected, not authorized (there is no external-directory permission), and
missing output paths are allowed only when every existing ancestor is safe.

## Native interfaces

JS/TS: default-exported function receiving the params object; its return value
is serialized as the single JSON result. `console.*` output goes to stderr and
is not part of the result.

```ts
// main.ts
export default async function (params: { path: string; depth: number }) {
  return { path: params.path, depth: params.depth };
}
```

Python: read params from stdin, print one JSON value to stdout.

```python
# main.py
import json
import sys

params = json.load(sys.stdin)
print(json.dumps({"path": params["path"]}))
```

Result contract for both: exactly one valid UTF-8 JSON value on stdout within
the 64 KiB run output bound (stdout+stderr); invalid JSON, oversized output,
or nonzero exit fails
clearly. Finite JSON only (no `NaN`/`Infinity`). This run output bound is
separate from the ≤ 256 KiB source bound, which is what `inspect` with
`includeSource: true` may return. Scripts run unsandboxed with the user's
authority: arbitrary imports and transitive dependencies are user-authorized
trust and are not hashed or pinned — only the manifest plus entry source are
content-hashed.

### JS/TS module caveat

Native JS/TS source runs from an in-memory snapshot imported as a data module,
not from its file on disk. There is therefore no reliable relative file import
and no meaningful `import.meta` filesystem path. Do not rely on
`./sibling.ts`, `import.meta.url`/`dirname`, or reading files relative to the
rune directory. Recommended: node builtins plus `path`-typed params resolved
against the project working directory (`cwd` is the project root), passed in by
the caller.

## Legacy (`argv`) interface

Python and JS/TS `argv` runes keep their original command-line interface:
validated params are encoded as `--key=value` pairs by default. The runtime
executes the approved source snapshot, never the mutable original bytes.

- Python: the snapshot compiles with the original project-relative filename
  and original `__file__`, so root/sibling data dependencies keep working.
- JS/TS: the exact-entry source snapshot runs under Node via `registerHooks`
  (requires Node >= 22.15 / 23.5; tested on 26.9 only). `.cjs` entries load as
  CommonJS; `.js`/`.mjs`/`.ts` entries load as ESM (`.ts` is transpiled with
  Bun targeting Node). The original entry URL and `process.argv`
  (`[execPath, filename, ...argv]`) are preserved; dependencies resolve
  normally through the host. They are user-authorized trust, not hashed,
  pinned, or sandboxed. Native JS/TS runes keep the unchanged data-module
  semantics described above.

Reviewed `legacy.argv` encodings change the default per param (validated by
contracts.ts; boolean params without a `flag` mapping are rejected as
ambiguous):

```json
"legacy": {
  "path": ".blocks/greet.py",
  "sha256": "<sha256 of the original source>",
  "format": "caveman-blocks",
  "argv": {
    "verbose": { "mode": "flag" },
    "quiet": { "mode": "flag", "when": false },
    "tag": { "mode": "repeat-json" }
  }
}
```

- `flag`: boolean param emitted as a bare `--key` only when the value matches
  `when ?? true` (so `{ "mode": "flag", "when": false }` emits `--quiet` only
  when `quiet` is `false`; otherwise nothing is emitted).
- `repeat-json`: string param holding a JSON array of strings, emitted as one
  repeated `--key=value` per element (for example `"[\"a\",\"b\"]"` becomes
  `--tag=a --tag=b`). Non-array or non-string content fails at run time.
- Any other scalar keeps the default `--key=value` encoding.

## Migration mapping (`.blocks` → rune)

Only immediate `.blocks/` files with script extensions are candidates; INDEX,
configs, lockfiles, fixtures, and caches are ignored. Headered unambiguous
Python converts automatically: a `# /// block` … `# ///` TOML comment header
maps `str` → `string`, `int` → `integer`, `float` → `number`, `path` → `path`,
with `min`/`max`/`default`/`required` preserved and `help` becoming the param
`description`. `example` is preserved as an argv string array. `stamp` and
`allow_effects` are dropped — never migrated as verification or authority.
Automatic conversion refuses `bool` params as ambiguous; anything else it
cannot represent (unsupported script language without override, schema, field,
oversize header) is reported in `unsupported[]`, never guessed.
Originals are never modified; provenance goes in `manifest.legacy`.

Headerless files, JS/TS files, and ambiguous booleans need a reviewed
override in `.opencode/runes-migration.json` (version 1; exact
`.blocks/<name>.(py|js|ts|mjs|cjs)` keys; never executed as code). Each entry
is `{ sha256, manifest, adapter? }`: `sha256` must equal the current original
source hash, `manifest` language/entry must match the source extension, and
`interface` must be `argv` — or `native` only when an `adapter` is supplied.
The override file itself is read under `read` permission with strict
schema/hash/size bounds; stale hashes are refused. There is no CLI for this
file, no new dependency, and no whole-project source autoload: only the exact
listed `.blocks` path converts.

```json
{
  "version": 1,
  "entries": {
    ".blocks/greet.py": {
      "sha256": "<sha256 of .blocks/greet.py>",
      "manifest": {
        "version": 1, "name": "greet", "description": "...",
        "language": "python", "interface": "argv", "entry": "main.py",
        "params": { "verbose": { "type": "boolean" } },
        "effects": "Prints a greeting.",
        "legacy": { "argv": { "verbose": { "mode": "flag" } } }
      }
    }
  }
}
```

Optional `adapter: { source, sha256 }` carries a reviewed native bounded
adaptation for sources that cannot run as-is under `argv` (language and entry
still match the original; raw original hash and adapter hash are both
checked; reruns compare the exact stored source, so edited runes report a
conflict instead of overwriting). The serve-static pattern is the model: a
legacy script that would listen forever is instead adapted to a bounded
loopback lease — bind `127.0.0.1` (or `localhost`) for a bounded duration,
close the listener, then return one JSON value containing `root`, `host`,
`port`, `durationMs`, and `closed: true`. Port `0` requests an ephemeral port;
callers may choose a known loopback port when composing concurrent probes.
The returned port is no longer listening. It is still an unsandboxed native
rune under the normal timeout/output bounds, not a persistent server.
