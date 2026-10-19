# Legacy Runtime Review — contracts.ts / runtime.ts (+ legacy-compatibility, runtime, contracts tests)

Scope: read-only verification of ONLY `src/contracts.ts`, `src/runtime.ts`,
`test/legacy-compatibility.test.ts`, `test/runtime.test.ts`, `test/contracts.test.ts`.
`src/migrate.ts` adapters are owned by another worker and are out of scope.
No production/test files edited. No commits/pushes.

Skills loaded: `testing-on-the-toilet`, `verification-before-completion`.

## Verdict per criterion

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Legacy JS/TS/CJS executes approved source snapshot, not mutable original | **PASS** | `src/runtime.ts:118-119` builds `snapshot` from in-memory `source` (TS via `Bun.Transpiler` target node, else verbatim); envelope sends `source: snapshot` (`:129`); worker `load` hook returns `envelope.source` for entry URL only (`:57-60`). Test mutates the original file inside `authorize` to `MUTABLE ORIGINAL EXECUTED` and still gets snapshot output, for all of `mjs/js/ts/cjs` (`test/legacy-compatibility.test.ts:134-152`). Native snapshot analogue in `test/runtime.test.ts:501-515`. |
| 2 | Exact origin / argv / sibling-dependency semantics preserved | **PASS** | Worker sets `entry = pathToFileURL(envelope.filename).href` and `process.argv = [execPath, filename, ...argv]` (`src/runtime.ts:50-51`); only the exact entry URL is intercepted, deps use normal Node loading (`:41-42,52-61`). Tests assert `argv == [original, '--label=bound']`, `file == original` (CJS `__filename`) or file-URL href (ESM), and `sibling.cjs` import/require resolves (`legacy-compatibility:139-150`). Python sibling/file-identity analogue passes (`runtime.test.ts:224-237`). Format rule is extension-only: `.cjs` → `commonjs`, else `module`; no source-sniffing or mutable-byte reads (`runtime.ts:115-117`). |
| 3 | Inherited trust boundaries stated in code | **PASS** | `runtime.ts:41-42` states deps "retain normal Node loading and are trusted host code, not part of the approved entry snapshot"; `:115-116` states format rule and forbids guessing from source/mutable bytes. Tests corroborate the boundary (snapshot wins for entry; sibling file content is read from the original directory). |
| 4 | Explicit boolean bare-flag / repeat-json strictness, before authorize/spawn | **PASS** | `contracts.ts:339-356` accepts only `flag` on boolean params (optional boolean `when`, no extra keys) and `repeat-json` on string params (exactly one key); `:432-438` rejects any argv-interface boolean lacking an explicit flag encoding. `runtime.ts:65-86` (`encodeArgv`) runs before auth/spawn: flag emitted only on `value === (when ?? true)`; `repeat-json` requires a JSON string array of strings, else `invalid_params`; bare boolean without encoding throws `ambiguous`. Ordering: `validateParams(:98)` → path checks → `encodeArgv(:107)` → legacy-provenance check (`:109`) → dual `authorize(:126-127)` → `spawn(:131+)`. Tests: flag `enable`/`disable(when:false)` + `repeat-json` with `a=b`/`--quoted value` values, and strict rejection of `not json/{}/[1]/null/true` with `calls===0` (no authorize) (`legacy-compatibility:34-52`); JS-without-legacy-provenance rejected `unsupported` with `calls===0` and no side-effect file (`runtime.test.ts:239-267`); unknown/missing/wrong-type params rejected with `calls===0` (`runtime.test.ts:280-333`). Throwaway probe (no spawn, contracts only, 6/6 pass): flag-on-string, repeat-json-on-integer, flag-extra-key, repeat-json-extra-key, argv-boolean-without-flag all rejected `invalid_manifest`; valid flag accepted. |
| 5 | Dual permissions / path confinement / combined output / timeouts / cancel / process cleanup remain | **PASS** | Dual `bash` then `runes.run` with content-hash/params/effects identity before spawn (`runtime.ts:124-129`); denied-bash unwrapped with 1 call and no side effect, denied-runes.run after `["bash","runes.run"]` with no side effect, identity/metadata shape asserted (`runtime.test.ts:335-412`). Path params via `safePath(missing:any)` and legacy filename via `safePath` (`runtime.ts:99-114`); traversal/absolute-escape/symlink/file-ancestor rejected, dir + missing-output-with-safe-ancestors allowed (`runtime.test.ts:415-499`). Combined stdout+stderr byte budget (`:135-157`); legacy 70k output → `output_limit`, 150 ms legacy → `timeout`, abort-during-run → `cancelled` (`legacy-compatibility:154-187`); native output-limit, SIGTERM-ignoring tree killed via SIGKILL escalation <10 s with `/proc` marker reaped, ready-file-synced cancel, pre-abort with zero authorize calls, post-success descendant reaped (`runtime.test.ts:517-616`). |
| 6 | Node version handling / ESM-CJS limitations inspected | **PASS with noted untested path** | Worker throws `Legacy JavaScript requires Node registerHooks (Node >=22.15)` when unavailable (`runtime.ts:49`). Environment here is Node `v26.9.0`, so the hook path is what ran. The old-Node error branch has **no test**. ESM-CJS rule (`.cjs`→commonjs else module) is covered by the 4-extension loop (CJS entry uses `require`, ESM entries use `import`); a legacy `.js` file containing CJS (`require`/`module.exports`) would load as ESM and fail — no test covers that shape (see limitations). |

## Checks run (fresh, this session)

- `bun test test/legacy-compatibility.test.ts test/runtime.test.ts test/contracts.test.ts` → **76 pass, 0 fail, 201 expect() calls** (2.12 s, bun v1.4.2, node v26.9.0).
- `git diff HEAD -- src/contracts.ts src/runtime.ts test/runtime.test.ts` inspected: contracts diff adds `LegacyArgvEncoding` + `legacy.argv` validation + argv-boolean explicitness rule; runtime diff replaces the Python-only guard with the Node `registerHooks` snapshot worker + `encodeArgv` + provenance/format/snapshot wiring; runtime.test diff converts the old "non-python unsupported" test into the provenance-before-authorize test with sentinel assertion. `test/legacy-compatibility.test.ts` is new (untracked), as is `test/migration-adapter.test.ts` (out of scope).
- Throwaway contracts-only probe via `bun -e` (6 assertions, no child spawn, no files written): all 6 behaved as above.
- No scratch files written; no legacy execution beyond what the test suite itself performs; no service/config changes.

## Unsafe edge cases (report, not patch — source owners coordinate)

1. **Sibling dependencies are mutable and unpinned.** Only the entry URL is snapshot-pinned; `sibling.cjs`, `seed.txt`, or any transitive dep is read live from disk and is explicitly "trusted host code." A post-approval write to a sibling changes behavior. Stated in code, but callers should treat sibling writes as trusted.
2. **No OS sandbox.** Confinement is `safePath` + argv shaping + authorize callbacks + output/timeout/kill. A runnable rune still runs as the user with full FS/network reach its process has; `effects` is advisory identity, not enforcement.
3. **Legacy `.js`-as-CJS gap.** Extension-only format means CJS content in a `.js` legacy entry is attempted as ESM. Only `.cjs` gets `commonjs`. If the corpus contains CJS-in-`.js`, expect load-time failure.
4. **argv value ambiguity is downstream's.** `--item=a=b` and `--item=--quoted value` are passed as single argv elements (no shell, so no injection), but a naive legacy parser splitting on `=`/prefix could misparse; the tests pin the byte-preserving transport, not the legacy parser.
5. **TS transpile is `target: node`, format `module`.** TS features beyond that target, or TS-as-CJS expectations, are untested.

## Test limitations

- Node `<22.15` (missing `registerHooks`) error branch: **untested** (this env is Node v26.9.0).
- Dependencies-mutable and no-OS-sandbox properties above are **documented by code comment, not bounded by test**.
- `test/contracts.test.ts` has **no direct unit tests** for `legacy.argv` shapes (flag vs repeat-json strictness); that logic is covered indirectly via `legacy-compatibility.test.ts` + the probe above, not at the contracts unit layer.
- `test/legacy-compatibility.test.ts` also contains `migrateBlocks`/override adapter cases (concurrent adapter back-compatible source) owned by the other worker: **observed, not verdicted** here.
- Fault-injection (red) cycle not performed on production code per read-only assignment; green evidence is the suite run above plus the suite's own precondition+mutation patterns (e.g., authorize-time file mutation, `MIGRATION EXECUTED SOURCE` throw-strings that would fail if executed).

## Files changed by this verifier

- `docs/LEGACY-RUNTIME-REVIEW.md` (this report) — only file written. No production/test edits, no commits, no pushes.
- This report itself is **not independently verified**; the green claims rest on the cited command outputs and code excerpts above.
