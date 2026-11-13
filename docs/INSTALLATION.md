# Installation and rollback

## Install

Runes requires OpenCode V2 and Bun 1.4.2 or newer. Add the package to the `plugins` array in your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["hffmnnj.runes"]
}
```

OpenCode reloads the configuration on save. The plugin registers the `runes` Code Mode namespace with five tools: `list`, `inspect`, `save`, `run`, and `migrate`. Use `search` inside `execute` to discover the exact `tools.runes.*` paths.

For a local or development build, install dependencies and build the package:

```sh
bun install
bun run build
```

Point OpenCode at the built package through your normal plugin configuration. A manually copied plugin lives in the plugins directory used by your OpenCode V2 configuration, for example `${XDG_CONFIG_HOME:-$HOME/.config}/opencode-v2/plugins/opencode-runes/`. Keep the plugin entry file and its built bundle together. Pin a build with a hash query only when your setup requires immutable reloads.

## Verify installation

After installing or reloading:

1. Code Mode `search` lists the five `runes.*` tools.
2. `tools.runes.list({})` succeeds against the invoking project.
3. Rune storage resolves under that project's `.opencode/.runes/`, not a global location.

## Rollback

1. Remove `hffmnnj.runes` from the OpenCode `plugins` configuration, or move a manually installed plugin directory aside under an unused name. Do not delete converted project data.
2. If you replaced a previous plugin or a guidance section, restore only that piece from your backup. Do not overwrite unrelated newer configuration or guidance.
3. Confirm Code Mode discovery no longer exposes the `runes.*` tools, or exposes the intended replacement.
4. Converted `.opencode/.runes/` directories and original `.blocks/` files can coexist. Rollback does not require removing either.
5. If you installed by copying a build, keep the previous plugin directory and entry shim until rollback is verified.

A config or plugin-directory change normally does not require a shared-service restart; follow your OpenCode setup's reload behavior.

## Rolling back a legacy Blocks replacement

If a legacy Blocks adapter or command symlink was archived rather than deleted, restore it only when you intend to return to that plugin. Keep its backup and confirm destination paths are unoccupied before moving files back. Migration never modifies original `.blocks` scripts, so returning to the previous plugin does not require undoing project-local runes.

## Related documentation

- [FORMAT.md](FORMAT.md): rune layout, manifests, params, and migration mapping.
- [SECURITY.md](SECURITY.md): permissions, path confinement, execution bounds, and migration safety.
- [AGENTS-RUNES.md](AGENTS-RUNES.md): guidance for agents using runes.
