# Complete legacy Blocks migration

## Goal and scope

Provide an additive migration path from legacy `.blocks` scripts to project-local Runes without changing original bytes or executing legacy helpers during conversion. Migration covers headered unambiguous Python scripts automatically and supports reviewed, hash-bound overrides for supported non-automatic shapes. A reviewed native adapter may provide a bounded adaptation when the original script cannot run as-is.

Inventory reports classify every discovered active legacy script as converted, existing, or explicitly unsupported with a reason. Archives, recovery snapshots, dependency trees, generated fixtures, caches, and inaccessible storage are out of scope; worktree coverage must be checked separately before claiming exhaustive completion.

## Compatibility decisions

Legacy argv has explicit `legacy.argv` encodings: boolean bare flags with an optional triggering value, and scalar JSON-string-array input for repeated arguments. Ambiguous encodings remain fail-closed. `.opencode/runes-migration.json` is a strict, reviewed metadata sidecar bound to the exact original-source hash. Optional native adapters additionally bind the exact adapter source hash and must preserve the original source language and entry type. Both original and adapter are data during migration, never executed. Ordinary conversions remain verbatim source copies.

Legacy JS/TS execution uses child Node `registerHooks` to substitute only the approved entry snapshot at its original URL/argv identity; sibling dependencies use normal trusted host loading. `.cjs` is CommonJS, `.js`/`.mjs`/`.ts` are ESM; TS snapshots are transpiled by Bun. Native runtimes remain unchanged. A long-lived server helper may be adapted to a bounded loopback lease that closes before returning, instead of a persistent background server.

## Invariants

- Originals, sibling data, source-root identity, current Git branches, and unrelated dirty work remain intact.
- Migration is additive and create-only; identical repeat migration reports existing, and conflicting content is never overwritten.
- Migration parses metadata only. It never imports or runs legacy code.
- Reviewed metadata overrides must be bound to the exact source hash. Ambiguous flags and headerless schemas are never guessed silently.
- Execution uses the approved source snapshot, not a later read of the original script. Existing permission assertions, path confinement, bounded output, cancellation, timeouts, and process-group cleanup remain in force.
- Native JS/TS/Python behavior remains backwards compatible. Legacy execution may retain original origin for imports, argv, and file identity; dependencies remain trusted mutable host dependencies, not a sandbox.
- Long-lived server helpers require an explicit bounded lifecycle adaptation, not detached orphan processes or a false one-shot success claim.
- Guidance changes replace only legacy Blocks/Caveman-specific guidance and preserve all unrelated product/deployment rules.

## Acceptance

1. Migration reports every discovered active legacy script as converted, existing, or explicitly unsupported with a reason.
2. All five Code Mode tools are callable, with safe native JavaScript, TypeScript, and Python runtime evidence against the installed artifact.
3. Inventory accounts for active source scripts and explicitly reports exclusions and discovery limits.
4. Every active script has a valid runnable Rune or an explicit reviewed bounded adaptation; no unsupported active scripts remain.
5. Before/after source and sidecar checksums match, source provenance and manifest schemas validate, and a repeat migration is idempotent.
6. Focused compatibility tests and regression acceptance pass. No production-effect helper is executed merely to establish migration coverage.
7. Usage, storage, token savings, migration results, and safety boundaries are documented.
