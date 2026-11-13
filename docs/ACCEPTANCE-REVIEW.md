# Pre-install acceptance / security review

Topic note: this file originally recorded an independent pre-install review of Runes. Its scope included:

- save, list, inspect, and run roundtrips for JavaScript, TypeScript, and Python runes;
- strict name, parameter, path, manifest, output, timeout, and cancellation handling;
- exact-file read/edit authorization and permission-denial propagation;
- migration safety: no execution during conversion, byte-preserved originals, create-only writes, and idempotent repeat runs;
- project path confinement and no-shell child-process execution;
- typecheck, build, and native Code Mode registration.

Environment-specific commands, scratch paths, test counts, project fixtures, revisions, and installation-state records were removed for public release. See [SECURITY.md](SECURITY.md) for the current threat model and [FORMAT.md](FORMAT.md) for the rune format.
