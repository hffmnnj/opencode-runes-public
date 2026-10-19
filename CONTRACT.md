# Implementation interfaces

All modules use TypeScript ESM with explicit `.ts` imports. Bun 1.4.2 and Python 3.11+ are available. No runtime dependencies except the native `@opencode/plugin` API. Public operations throw `RuneError` for ordinary failures; plugin permission errors are never wrapped or swallowed.

## contracts.ts (pure validation)

Export `RuneError extends Error` with `code: string`, `LIMITS` (sourceBytes 262144, manifestBytes 32768, outputBytes 65536, catalogEntries 1000, listLimit 50, defaultTimeoutMs 30000, maxTimeoutMs 300000), `Language = 'javascript' | 'typescript' | 'python'`, `Param` (type: string/number/integer/boolean/path; required?, default?, enum?, min?, max?, description?), `Params = Record<string, string | number | boolean>`, and `RuneManifest`:

```
{ version: 1, name: string, description: string, language: Language,
  interface: 'native' | 'argv', entry: 'main.js' | 'main.ts' | 'main.py',
  params: Record<string, Param>, effects: string,
  timeoutMs?: number,
  legacy?: { path: string, sha256: string, format: 'caveman-blocks', example?: string[], metadata?: Record<string, unknown> } }
```

Names match `[a-z][a-z0-9-]{0,63}`. Param names match `[a-zA-Z][a-zA-Z0-9_-]{0,63}`. Default and enum values must match type and bounds. Manifest rejects unknown keys; metadata retained under legacy only. Description max 1000 chars; effects max 120 chars; max 64 parameters; no prototype keys. `validateManifest(input: unknown): RuneManifest`, `validateParams(manifest, input: unknown): Params`, `validateName(name: string): string`, `entryFor(language): entry`. Parameters apply defaults, reject unknowns and missing requireds, do not coerce types. All JSON must be finite.

## paths.ts (coordinator security boundary)

Export async `projectRoot(directory: string): Promise<string>` (canonical existing directory), `safePath(root: string, relative: string, options?: { directory?: boolean; missing?: boolean; any?: boolean }): Promise<string>` (reject absolute/traversal components, all symlinks beneath root; existing file must be regular, or a directory when any:true), `readBounded(root, relative, maxBytes): Promise<string>` (no-follow regular-file read, size bound, stable identity), and `ensureDirectory(root, relative): Promise<string>` (safe recursive component creation without symlink traversal).

## store.ts (storage)

Export `LoadedRune = { manifest: RuneManifest; source: string; hash: string }`, `RuneSummary = { name; description; language; effects }`, and `RuneStore` constructed with canonical root string, exposed readonly `root`. Methods: `load(name): Promise<LoadedRune>`, `list({query?: string, offset?: number, limit?: number} = {}): Promise<{runes: RuneSummary[]; nextOffset?: number; invalid: number}>`, `save(manifest: unknown, source: string): Promise<{name: string; created: boolean; hash: string}>`. Save is create-only, no overwrite. Hash is SHA-256 of canonical manifest JSON + newline + source. Reject invalid Unicode/source byte limits. Use paths.ts for every file access. Publication via exclusive `mkdir` for the name, exclusive no-follow file creation, manifest LAST; partially written owned directories are retained and reported, not recursively deleted. Two simultaneous saves cannot overwrite each other. Existing identical save returns created:false, otherwise error `exists`. Listing is bounded and skips invalid entries, returning count.

## runtime.ts (coordinator execution boundary)

Export `runRune(root: string, rune: LoadedRune, input: unknown, options: { signal?: AbortSignal; authorize: (request: { action: string; resources: string[]; metadata?: Record<string, unknown> }) => Promise<void> }): Promise<{name: string; value: unknown; durationMs: number}>`.

Validate params and project-confine path values before any spawn. Authorize both `bash` (execution identity includes root, rune content hash, effects, and actual params) and `runes.run` (same identity). Execute approved source snapshot, not re-read mutable source. Native Python reads JSON stdin and prints JSON stdout; native JS/TS default export receives params and returned JSON becomes stdout (console logs are stderr). Legacy Python snapshot compiles with original project-relative filename and original `__file__`, preserving root/sibling data dependencies without executing the original bytes. Legacy JS/TS argv scripts whose location semantics cannot be preserved are reported unsupported during migration. Runtime owns subprocess group, bounded stdout/stderr, timeout and cancellation. Effects are declarations, not isolation. Never use a shell.

## migrate.ts (additive conversion)

Export `migrateBlocks(root: string, options: { dryRun?: boolean; authorize: (request: { action: string; resources: string[]; metadata?: Record<string, unknown> }) => Promise<void> }): Promise<{converted: string[]; existing: string[]; unsupported: {path: string; reason: string}[]; dryRun: boolean}>`.

Only inspect immediate `.blocks` files under safe paths; no executing sources or recursively scanning project. TOML comment headers (`# /// block` … `# ///`) parsed via `Bun.TOML.parse`, types str/int/float/bool/path become string/integer/number/boolean/path. Preserve min/max/default/required/help as description. Use `RuneStore` for persistence and source snapshots. Effects copied verbatim. Preserve header data in legacy.metadata and original path + SHA256 + example. Python argv semantics and `__file__` root are supported by runtime, original .blocks data/fixtures remain in place. Existing rune names are NEVER overwritten; identical provenance reports existing; conflicts report unsupported. Unsupported extensions, schemas, or argv boolean encoding ambiguities are reported, not guessed. Bound reads/catalog/results. Unknown files such as INDEX/config/lock/fixtures and pycache are not migration candidates. Dry-run never creates anything or asks edit permission. Each applied conversion requires edit permission BEFORE mutation. Missing `.blocks` returns empty result. Do not carry over stamps as verified evidence or allow_effects as authorization.

## tools.ts and index.ts (native integration)

Export `registerTools(ctx: Plugin.Context): Promise<void>` and default `Plugin.define({id:'opencode-runes', setup:registerTools})`. Register namespace `runes` with list/inspect/save/run/migrate through `ctx.tool.transform`, `options:{namespace:'runes',codemode:true}` and JSON schemas (use actual installed API types). Return structured `output` plus compact JSON content. Resolve root from `await ctx.session.get({sessionID: context.sessionID})` for EACH invocation (verify exact session location field in installed schema). Never use global ctx.location as session root fallback. Set permission source and agent from context. Gate read access with `read` permission for relevant rune/Blocks paths; edit save paths before mutation. Run calls runtime with context.signal and authorizer backed by ctx.permission.assert. Lazy automatic migration once per root per plugin lifetime, on explicit list/inspect/run use only, with edit authorization (never setup or context hook); include bounded migration report in response when conversions or unsupported cases exist. No swallowing permission denials. `migrate` is explicit with dryRun default true. `inspect` returns manifest/hash, source only when includeSource:true. Save input `{manifest,source}`; run input `{name,params?:{...}}`; tool errors from RuneError yield `{error:{code,message}}`, never include full source or unbounded exceptions. No hooks, CLI, injected full catalog, dynamic per-rune tool schemas, or dependencies.

## Ownership

- Coordinator: package configuration, paths.ts, runtime.ts, integration tests, planning, installation.
- Minion A: contracts.ts and test/contracts.test.ts only.
- Minion B: store.ts and test/store.test.ts only.
- Minion C: tools.ts, index.ts, and test/tools.test.ts only.
- Engineer: migrate.ts and test/migrate.test.ts only (trigger: data migration + untrusted legacy parsing). No workers delegate, commit, publish, install globally, restart services, or modify source projects.
