import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { RuneError, validateManifest, validateName } from "./contracts.ts";
import { migrateBlocks } from "./migrate.ts";
import { projectRoot } from "./paths.ts";
import { runRune } from "./runtime.ts";
import { RuneStore } from "./store.ts";

type CallContext = ToolContext;

type Authorize = (request: {
  action: string;
  resources: string[];
  metadata?: Record<string, unknown>;
}) => Promise<void>;

// Bounded error envelope. Only RuneError becomes tool output; every other
// rejection (permission denials, cancellation, host failures) propagates to
// the caller untouched. Never includes rune source.
function runeErrorResult(err: RuneError): {
  output: { error: { code: string; message: string } };
  content: Array<{ type: "text"; text: string }>;
} {
  const output = {
    error: { code: err.code, message: err.message.slice(0, 2000) },
  };
  return { output, content: [{ type: "text" as const, text: JSON.stringify(output) }] };
}

function okResult(output: Record<string, unknown>): {
  output: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
} {
  return { output, content: [{ type: "text" as const, text: JSON.stringify(output) }] };
}

// Resolve the invoking session's project root for EVERY invocation from the
// native session record. Never falls back to the plugin's own location.
async function resolveRoot(ctx: Plugin.Context, sessionID: CallContext["sessionID"]): Promise<string> {
  const session = await ctx.session.get({ sessionID });
  return projectRoot(session.location.directory);
}

function authorizerFor(ctx: Plugin.Context, context: CallContext): Authorize {
  return (request) =>
    ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      action: request.action,
      resources: request.resources,
      // The native codec accepts omission, but rejects a present undefined key.
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      source: { type: "tool", messageID: context.messageID, id: context.id },
    });
}

async function assertRead(ctx: Plugin.Context, context: CallContext, resources: string[]): Promise<void> {
  await authorizerFor(ctx, context)({ action: "read", resources });
}

type MigrationReport = Awaited<ReturnType<typeof migrateBlocks>>;

function withMigration(output: Record<string, unknown>, migration: MigrationReport | undefined): void {
  if (migration && (migration.converted.length > 0 || migration.unsupported.length > 0)) {
    output.migration = {
      converted: migration.converted,
      existing: migration.existing,
      unsupported: migration.unsupported,
      dryRun: migration.dryRun,
    };
  }
}

const RUNES_NAMESPACE = { name: "runes", description: "Project-local reusable scripts (runes)" } as const;
const TOOL_OPTIONS = { namespace: "runes", codemode: true } as const;

const LIST_INPUT = {
  type: "object",
  properties: {
    query: { type: "string" },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

const INSPECT_INPUT = {
  type: "object",
  properties: {
    name: { type: "string" },
    includeSource: { type: "boolean" },
  },
  required: ["name"],
  additionalProperties: false,
};

const SAVE_INPUT = {
  type: "object",
  properties: {
    manifest: {
      type: "object",
      properties: {
        version: { type: "integer", const: 1 },
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
        description: { type: "string", maxLength: 1000 },
        language: { type: "string", enum: ["javascript", "typescript", "python"] },
        interface: { type: "string", enum: ["native", "argv"] },
        entry: { type: "string", enum: ["main.js", "main.ts", "main.py"] },
        params: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["string", "number", "integer", "boolean", "path"] },
              required: { type: "boolean" },
              default: { type: ["string", "number", "boolean"] },
              enum: { type: "array", items: { type: ["string", "number", "boolean"] } },
              min: { type: "number" }, max: { type: "number" }, description: { type: "string" },
            },
            required: ["type"], additionalProperties: false,
          },
        },
        effects: { type: "string", maxLength: 120 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
        legacy: { type: "object" },
      },
      required: ["version", "name", "description", "language", "interface", "entry", "params", "effects"],
      additionalProperties: false,
    },
    source: { type: "string" },
  },
  required: ["manifest", "source"],
  additionalProperties: false,
};

const RUN_INPUT = {
  type: "object",
  properties: {
    name: { type: "string" },
    params: { type: "object" },
  },
  required: ["name"],
  additionalProperties: false,
};

const MIGRATE_INPUT = {
  type: "object",
  properties: {
    dryRun: { type: "boolean" },
  },
  additionalProperties: false,
};

const OBJECT_OUTPUT = { type: "object" };

export async function registerTools(ctx: Plugin.Context): Promise<void> {
  // Lazy automatic migration runs once per project root per plugin lifetime,
  // only from explicit list/inspect/run tool use. Never in setup or hooks.
  const migratedRoots = new Set<string>();

  async function ensureLazyMigrated(context: CallContext, root: string): Promise<MigrationReport | undefined> {
    if (migratedRoots.has(root)) return undefined;
    await assertRead(ctx, context, [`${root}/.blocks`]);
    const report = await migrateBlocks(root, {
      dryRun: false, authorize: authorizerFor(ctx, context),
      authorizeRead: resource => assertRead(ctx, context, [resource]),
    });
    migratedRoots.add(root);
    return report;
  }

  async function listExecute(input: unknown, context: CallContext) {
    try {
      const args = (input ?? {}) as { query?: string; offset?: number; limit?: number };
      const root = await resolveRoot(ctx, context.sessionID);
      await assertRead(ctx, context, [`${root}/.opencode/.runes`, `${root}/.blocks`]);
      const migration = await ensureLazyMigrated(context, root);
      const result = await new RuneStore(root, resource => assertRead(ctx, context, [resource])).list({ query: args.query, offset: args.offset, limit: args.limit });
      const output: Record<string, unknown> = { runes: result.runes, invalid: result.invalid };
      if (result.nextOffset !== undefined) output.nextOffset = result.nextOffset;
      withMigration(output, migration);
      return okResult(output);
    } catch (err) {
      if (err instanceof RuneError) return runeErrorResult(err);
      throw err;
    }
  }

  async function inspectExecute(input: unknown, context: CallContext) {
    try {
      const args = input as { name: string; includeSource?: boolean };
      validateName(args?.name);
      const root = await resolveRoot(ctx, context.sessionID);
      await assertRead(ctx, context, [`${root}/.opencode/.runes/${args?.name}/*`]);
      const migration = await ensureLazyMigrated(context, root);
      const loaded = await new RuneStore(root, resource => assertRead(ctx, context, [resource])).load(args?.name);
      const output: Record<string, unknown> = { manifest: loaded.manifest, hash: loaded.hash };
      if (args?.includeSource === true) output.source = loaded.source;
      withMigration(output, migration);
      return okResult(output);
    } catch (err) {
      if (err instanceof RuneError) return runeErrorResult(err);
      throw err;
    }
  }

  async function saveExecute(input: unknown, context: CallContext) {
    try {
      const args = input as { manifest: unknown; source: string };
      const manifest = validateManifest(args?.manifest);
      const root = await resolveRoot(ctx, context.sessionID);
      await authorizerFor(ctx, context)({
        action: "edit",
        resources: [`${root}/.opencode/.runes/${manifest.name}/rune.json`, `${root}/.opencode/.runes/${manifest.name}/${manifest.entry}`],
        metadata: { root, name: manifest.name },
      });
      const result = await new RuneStore(root, resource => assertRead(ctx, context, [resource])).save(manifest, args?.source);
      return okResult({ name: result.name, created: result.created, hash: result.hash });
    } catch (err) {
      if (err instanceof RuneError) return runeErrorResult(err);
      throw err;
    }
  }

  async function runExecute(input: unknown, context: CallContext) {
    try {
      const args = input as { name: string; params?: unknown };
      validateName(args?.name);
      const root = await resolveRoot(ctx, context.sessionID);
      await assertRead(ctx, context, [`${root}/.opencode/.runes/${args?.name}/*`]);
      const migration = await ensureLazyMigrated(context, root);
      const loaded = await new RuneStore(root, resource => assertRead(ctx, context, [resource])).load(args?.name);
      const result = await runRune(root, loaded, args?.params ?? {}, {
        signal: context.signal,
        authorize: authorizerFor(ctx, context),
      });
      const output: Record<string, unknown> = {
        name: result.name,
        value: result.value,
        durationMs: result.durationMs,
      };
      withMigration(output, migration);
      return okResult(output);
    } catch (err) {
      if (err instanceof RuneError) return runeErrorResult(err);
      throw err;
    }
  }

  async function migrateExecute(input: unknown, context: CallContext) {
    try {
      const args = (input ?? {}) as { dryRun?: boolean };
      const dryRun = args.dryRun ?? true;
      const root = await resolveRoot(ctx, context.sessionID);
      await assertRead(ctx, context, [`${root}/.blocks`, `${root}/.opencode/.runes`]);
      const report = await migrateBlocks(root, {
        dryRun, authorize: authorizerFor(ctx, context),
        authorizeRead: resource => assertRead(ctx, context, [resource]),
      });
      return okResult({
        converted: report.converted,
        existing: report.existing,
        unsupported: report.unsupported,
        dryRun: report.dryRun,
      });
    } catch (err) {
      if (err instanceof RuneError) return runeErrorResult(err);
      throw err;
    }
  }

  await ctx.tool.transform((editor) => {
    editor.namespace({ ...RUNES_NAMESPACE });
    editor.add({
      name: "list",
      description: "List runes in the invoking session's project (bounded summaries, no source)",
      input: LIST_INPUT,
      output: OBJECT_OUTPUT,
      options: { ...TOOL_OPTIONS },
      execute: listExecute,
    });
    editor.add({
      name: "inspect",
      description: "Show a rune manifest and hash; include source only with includeSource:true",
      input: INSPECT_INPUT,
      output: OBJECT_OUTPUT,
      options: { ...TOOL_OPTIONS },
      execute: inspectExecute,
    });
    editor.add({
      name: "save",
      description: "Save a new rune (create-only). Native JS/TS export default(params) returning JSON; Python reads JSON stdin and prints JSON. Entry must match language.",
      input: SAVE_INPUT,
      output: OBJECT_OUTPUT,
      options: { ...TOOL_OPTIONS },
      execute: saveExecute,
    });
    editor.add({
      name: "run",
      description: "Execute a rune with typed params in a separate, unsandboxed child process",
      input: RUN_INPUT,
      output: OBJECT_OUTPUT,
      options: { ...TOOL_OPTIONS },
      execute: runExecute,
    });
    editor.add({
      name: "migrate",
      description: "Convert legacy .blocks scripts to runes (dry-run by default, additive only)",
      input: MIGRATE_INPUT,
      output: OBJECT_OUTPUT,
      options: { ...TOOL_OPTIONS },
      execute: migrateExecute,
    });
  });
}
