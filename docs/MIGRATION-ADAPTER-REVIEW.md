# Migration-adapter review

Topic note: this file originally recorded review of the optional native-adapter path used by legacy Blocks migration. Current adapter requirements are:

- an adapter is reviewed and optional; the original source and adapter source are both hash-bound;
- the adapter declares the `native` interface and matches the original language and entry filename;
- override metadata is read under `read` permission with strict schema, hash, and size validation;
- migration remains additive and create-only: conflicts are reported, never overwritten;
- legacy and adapter source are never executed during conversion.

The bounded server pattern is documented in [FORMAT.md](FORMAT.md): a legacy helper that would listen indefinitely can instead bind loopback for a bounded duration, close the listener before returning, and return one JSON value containing `root`, `host`, `port`, `durationMs`, and `closed: true`. It remains an unsandboxed native rune under the normal permission, output, and timeout bounds, not a persistent server.

Environment-specific checksums, project paths, test counts, and draft review records were removed for public release. See [SECURITY.md](SECURITY.md) for execution and migration boundaries.
