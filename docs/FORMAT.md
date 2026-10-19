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

Only Python `argv` semantics are preserved, because the runtime compiles the
snapshot with the original project-relative filename and original `__file__`,
so root/sibling data dependencies keep working without executing the original
bytes. Invocation passes `--key=value` pairs. Non-Python `argv` scripts are
not executable and are reported unsupported at migration time.

## Migration mapping (`.blocks` → rune)

Only immediate `.blocks/` files with script extensions are candidates; INDEX,
configs, lockfiles, fixtures, and caches are ignored. Python files need a
`# /// block` … `# ///` TOML comment header; types map `str` → `string`,
`int` → `integer`, `float` → `number`, `bool` → `boolean`, `path` → `path`,
with `min`/`max`/`default`/`required` preserved and `help` becoming the param
`description`. `example` is preserved as an argv string array. `stamp` and
`allow_effects` are dropped — never migrated as verification or authority.
Anything else (unsupported extension, schema, field, boolean `argv` encoding
ambiguity, oversize header) is reported in `unsupported[]`, never guessed.
Originals are never modified; provenance goes in `manifest.legacy`.
