# Complete migration roadmap

This page records the topic-level path for the legacy Blocks → Runes migration. Historical project inventories, environment-specific rollout records, pull-request links, machine paths, and process identifiers were removed for public release.

| Workstream | Outcome |
| --- | --- |
| Inventory and legacy semantics | Legacy `.blocks` formats, headers, argv shapes, and path dependencies were classified; unsupported and excluded inputs are reported rather than guessed. |
| Automatic conversions | Headered unambiguous Python scripts convert as byte-preserved source copies with manifests and provenance. |
| Reviewed compatibility | Explicit boolean/repeat argv encodings, hash-bound overrides, exact-entry snapshots for legacy JS/TS, and a bounded loopback server adapter. |
| Guidance and documentation | Migration behavior, security boundaries, and rollback are documented in [FORMAT.md](FORMAT.md), [SECURITY.md](SECURITY.md), and [INSTALLATION.md](INSTALLATION.md). |
| Validation | Behavior is covered by the repository's focused migration, runtime, and contract tests. |

The migration remains additive and project-local. Converting a project's remaining legacy scripts is optional; there is no global sweep or registry.
