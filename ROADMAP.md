# Roadmap

Runes is implemented as a project-local script plugin for OpenCode V2. This page tracks current scope and follow-ups; environment-specific rollout and verification diaries are not published.

| Area | Status | Notes |
| --- | --- | --- |
| Contracts and storage | Implemented | Version 1 manifests, typed params, create-only save, project-scoped storage. |
| Execution | Implemented | Native JavaScript, TypeScript, and Python runes; legacy argv execution; bounded output, timeouts, cancellation, and process-group cleanup. |
| Permissions | Implemented | Dual `bash` and `runes.run` authorization; exact-file read/edit gates; denial propagation. |
| Migration | Implemented | Additive `.blocks` conversion with dry-run preview, provenance, hash-bound overrides/adapters, and idempotent repeat runs. |
| Integration | Implemented | Five Code Mode tools in the `runes` namespace. |
| Packaging and documentation | Implemented | npm package metadata plus format, security, installation, and rollback documentation. |

## Follow-ups

- Convert remaining legacy scripts only in projects that want migration; no global sweep or registry is required.
- Format and parameter details live in [docs/FORMAT.md](docs/FORMAT.md); security boundaries live in [docs/SECURITY.md](docs/SECURITY.md).
- Installation, upgrade, and rollback procedures live in [docs/INSTALLATION.md](docs/INSTALLATION.md).
