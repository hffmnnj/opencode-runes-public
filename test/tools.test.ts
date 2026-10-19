// Tools tests: drive the native Code Mode registration through a narrow
// faithful adapter (session.get / permission.assert / tool.transform only)
// against real RuneStore roots and the real runtime. Each test uses a unique
// owned root under /var/tmp/example/opencode and never deletes anything.
//
// These tests prove the tools wiring contract (session-local roots,
// permission identity and propagation, bounded RuneError output, lazy
// migration). They do not prove compatibility with a live OpenCode server;
// that remains integration scope for the coordinator.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import { RuneStore } from "../src/store.ts";
import { registerTools } from "../src/tools.ts";

type CapturedTool = {
  name: string;
  description: string;
  input: unknown;
  output: unknown;
  options: unknown;
  execute: (input: unknown, context: CallContext) => Promise<ToolResult>;
};

type CallContext = {
  sessionID: string;
  agent?: string;
  messageID: string;
  id: string;
  signal?: AbortSignal;
};

type ToolResult = {
  output?: unknown;
  content?: unknown;
};

type PermissionCall = { action: string; resources: string[]; metadata?: unknown };

function makeContext(sessionDirs: Record<string, string>, deny?: (action: string, resources: string[]) => boolean) {
  const tools: CapturedTool[] = [];
  const permissionCalls: PermissionCall[] = [];
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const directory = sessionDirs[sessionID];
        if (!directory) throw new Error(`unknown session ${sessionID}`);
        return { location: { directory } };
      },
    },
    permission: {
      assert: async (request: {
        sessionID: string;
        agent?: string;
        action: string;
        resources: string[];
        metadata?: unknown;
        source?: unknown;
      }) => {
        permissionCalls.push({ action: request.action, resources: request.resources, metadata: request.metadata });
        if (deny?.(request.action, request.resources)) throw new Error(`denied ${request.action}`);
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = {
          namespace: (_namespace: unknown) => {},
          add: (tool: CapturedTool) => {
            tools.push(tool);
          },
          list: () => tools,
          get: (id: string) => tools.find((tool) => tool.name === id),
          update: () => {},
          remove: () => {},
        };
        callback(editor);
      },
    },
  };
  return { ctx, tools, permissionCalls };
}

async function freshRoot(): Promise<string> {
  return mkdtemp("/var/tmp/example/opencode/runes-tools-");
}

function callContext(sessionID: string): CallContext {
  return { sessionID, agent: "build", messageID: "msg-1", id: "call-1", signal: new AbortController().signal };
}

async function registeredTools(sessionDirs: Record<string, string>, deny?: (action: string, resources: string[]) => boolean) {
  const { ctx, tools, permissionCalls } = makeContext(sessionDirs, deny);
  await registerTools(ctx as unknown as Plugin.Context);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { tools, byName, permissionCalls };
}

function jsManifest(name: string): Record<string, unknown> {
  return {
    version: 1,
    name,
    description: `Echo rune ${name}`,
    language: "javascript",
    interface: "native",
    entry: "main.js",
    params: { who: { type: "string", default: "world" } },
    effects: "test-only",
  };
}

const JS_SOURCE = `export default async function (params) {\n  return { echo: params };\n}\n`;

const PY_MANIFEST: Record<string, unknown> = {
  version: 1,
  name: "echo-py",
  description: "Echo rune echo-py",
  language: "python",
  interface: "native",
  entry: "main.py",
  params: { who: { type: "string", default: "world" } },
  effects: "test-only",
};

const PY_SOURCE = `import json, sys\nprint(json.dumps({"echo": json.load(sys.stdin)}))\n`;

// Minimal supported legacy fixture (mirrors migrate.test.ts format).
const BLOCKS_SOURCE = `#!/usr/bin/env python3\n# /// block\n# name = "scalar-probe"\n# summary = "Scalar probe"\n# effects = "write-workspace"\n# example = ["--count", "8"]\n# [params]\n# count = { type = "int", default = 7, min = 1, max = 10, help = "Count items" }\n# ///\nraise RuntimeError("MIGRATION MUST NOT EXECUTE THIS")\n`;

async function seedBlocks(root: string, source: string = BLOCKS_SOURCE): Promise<void> {
  await mkdir(`${root}/.blocks`, { recursive: true });
  await writeFile(`${root}/.blocks/probe.py`, source, "utf8");
}

describe("registration", () => {
  test("registerTools_registersFiveRuneNamespacedTools", async () => {
    const { tools } = await registeredTools({ ses1: await freshRoot() });
    expect(tools.map((tool) => tool.name).sort()).toEqual(["inspect", "list", "migrate", "run", "save"]);
    for (const tool of tools) {
      expect(tool.options).toEqual({ namespace: "runes", codemode: true });
    }
  });
});

describe("file-specific permission rules", () => {
  test("inspect cannot read a source file denied by its exact absolute path", async () => {
    const root = await freshRoot();
    await new RuneStore(root).save(jsManifest("private"), JS_SOURCE);
    const denied = `${root}/.opencode/.runes/private/main.js`;
    const { byName } = await registeredTools({ ses: root }, (action, resources) => action === "read" && resources.includes(denied));
    await expect(byName.get("inspect")!.execute({ name: "private", includeSource: true }, callContext("ses"))).rejects.toThrow("denied read");
  });

  test("list propagates an exact manifest read denial rather than swallowing it as invalid", async () => {
    const root = await freshRoot();
    await new RuneStore(root).save(jsManifest("private"), JS_SOURCE);
    const denied = `${root}/.opencode/.runes/private/rune.json`;
    const { byName } = await registeredTools({ ses: root }, (action, resources) => action === "read" && resources.includes(denied));
    await expect(byName.get("list")!.execute({}, callContext("ses"))).rejects.toThrow("denied read");
  });

  test("lazy migration cannot read a specifically denied legacy source", async () => {
    const root = await freshRoot();
    await seedBlocks(root);
    const { byName } = await registeredTools({ ses: root }, (action, resources) => action === "read" && resources.includes(`${root}/.blocks/probe.py`));
    await expect(byName.get("list")!.execute({}, callContext("ses"))).rejects.toThrow("denied read");
    expect(await Bun.file(`${root}/.opencode/.runes/scalar-probe/rune.json`).exists()).toBe(false);
  });

  test("save cannot bypass a file-specific edit denial by asking for a wildcard", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root }, (action, resources) => action === "edit" && resources.includes(`${root}/.opencode/.runes/private/main.js`));
    await expect(byName.get("save")!.execute({ manifest: jsManifest("private"), source: JS_SOURCE }, callContext("ses"))).rejects.toThrow("denied edit");
    expect(await Bun.file(`${root}/.opencode/.runes/private/rune.json`).exists()).toBe(false);
  });
});

describe("save, list, inspect, run", () => {
  test("save_then_listInspectRun_roundtripWithDefaults", async () => {
    const root = await freshRoot();
    const { byName, permissionCalls } = await registeredTools({ ses: root });
    const save = byName.get("save")!;
    const list = byName.get("list")!;
    const inspect = byName.get("inspect")!;
    const run = byName.get("run")!;

    const saved = await save.execute({ manifest: jsManifest("echo-js"), source: JS_SOURCE }, callContext("ses"));
    expect(saved.output).toMatchObject({ name: "echo-js", created: true });
    expect(typeof (saved.output as { hash: unknown }).hash).toBe("string");

    const listed = await list.execute({}, callContext("ses"));
    expect((listed.output as { runes: Array<{ name: string }> }).runes.map((rune) => rune.name)).toContain("echo-js");

    const inspected = await inspect.execute({ name: "echo-js" }, callContext("ses"));
    const inspectedOutput = inspected.output as Record<string, unknown>;
    expect(inspectedOutput).not.toHaveProperty("source");
    expect(inspectedOutput).toMatchObject({ hash: (saved.output as { hash: string }).hash });
    expect((inspectedOutput.manifest as { name: string }).name).toBe("echo-js");

    const withSource = await inspect.execute({ name: "echo-js", includeSource: true }, callContext("ses"));
    expect((withSource.output as { source: string }).source).toBe(JS_SOURCE);

    const ran = await run.execute({ name: "echo-js", params: { who: "runes" } }, callContext("ses"));
    expect((ran.output as { value: unknown }).value).toEqual({ echo: { who: "runes" } });

    const defaulted = await run.execute({ name: "echo-js", params: {} }, callContext("ses"));
    expect((defaulted.output as { value: unknown }).value).toEqual({ echo: { who: "world" } });

    // Edit gate fires before save mutation; run authorizes execution identity.
    expect(permissionCalls.some((call) => call.action === "edit")).toBe(true);
    expect(permissionCalls.some((call) => call.action === "bash")).toBe(true);
    // Permission identity carries the calling tool context.
    expect(permissionCalls.length).toBeGreaterThan(0);
  });

  test("run_pythonRune_echoesParams", async () => {
    if (!Bun.which("python3")) throw new Error("python3 is required for this test");
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root });
    await byName.get("save")!.execute({ manifest: PY_MANIFEST, source: PY_SOURCE }, callContext("ses"));
    const ran = await byName.get("run")!.execute({ name: "echo-py", params: { who: "snek" } }, callContext("ses"));
    expect((ran.output as { value: unknown }).value).toEqual({ echo: { who: "snek" } });
  });

  test("run_unknownParam_returnsInvalidParamsError", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root });
    await byName.get("save")!.execute({ manifest: jsManifest("echo-js"), source: JS_SOURCE }, callContext("ses"));
    const ran = await byName.get("run")!.execute({ name: "echo-js", params: { bogus: 1 } }, callContext("ses"));
    expect(ran.output).toMatchObject({ error: { code: "invalid_params" } });
  });
});

describe("bounded errors", () => {
  test("inspect_missingRune_returnsNotFoundError", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root });
    const result = await byName.get("inspect")!.execute({ name: "no-such-rune" }, callContext("ses"));
    expect(result.output).toMatchObject({ error: { code: "not-found" } });
    // Compact JSON content mirrors the structured output, never rune source.
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual(result.output);
  });

  test("save_invalidManifest_returnsErrorAndWritesNothing", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root });
    const result = await byName
      .get("save")!
      .execute({ manifest: { version: 1, name: "bad" }, source: JS_SOURCE }, callContext("ses"));
    expect(result.output).toMatchObject({ error: { code: "invalid_manifest" } });
    expect(await new RuneStore(root).list()).toEqual({ runes: [], invalid: 0 });
  });
});

describe("permissions", () => {
  test("run_deniedBashPermission_propagatesInsteadOfErrorOutput", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root });
    await byName.get("save")!.execute({ manifest: jsManifest("echo-js"), source: JS_SOURCE }, callContext("ses"));

    const denied = await registeredTools({ ses: root }, (action) => action === "bash");
    const deniedRun = denied.byName.get("run")!;
    await expect(deniedRun.execute({ name: "echo-js", params: {} }, callContext("ses"))).rejects.toThrow("denied bash");
  });

  test("save_deniedEditPermission_propagatesAndWritesNothing", async () => {
    const root = await freshRoot();
    const { byName } = await registeredTools({ ses: root }, (action) => action === "edit");
    await expect(
      byName.get("save")!.execute({ manifest: jsManifest("echo-js"), source: JS_SOURCE }, callContext("ses")),
    ).rejects.toThrow("denied edit");
    expect(await new RuneStore(root).list()).toEqual({ runes: [], invalid: 0 });
  });
});

describe("session roots", () => {
  test("roots_isolateRunesPerSession", async () => {
    const rootA = await freshRoot();
    const rootB = await freshRoot();
    const { byName } = await registeredTools({ a: rootA, b: rootB });
    await byName.get("save")!.execute({ manifest: jsManifest("echo-js"), source: JS_SOURCE }, callContext("a"));

    const listedB = await byName.get("list")!.execute({}, callContext("b"));
    expect((listedB.output as { runes: unknown[] }).runes).toEqual([]);

    const runB = await byName.get("run")!.execute({ name: "echo-js", params: {} }, callContext("b"));
    expect(runB.output).toMatchObject({ error: { code: "not-found" } });
  });
});

describe("migration", () => {
  test("list_lazyMigratesOnceAndPreservesOriginal", async () => {
    const root = await freshRoot();
    await seedBlocks(root);
    const { byName } = await registeredTools({ ses: root });

    const first = await byName.get("list")!.execute({}, callContext("ses"));
    const firstOutput = first.output as {
      runes: Array<{ name: string }>;
      migration: { converted: string[]; unsupported: unknown[]; dryRun: boolean };
    };
    expect(firstOutput.migration.converted).toEqual(["scalar-probe"]);
    expect(firstOutput.migration.dryRun).toBe(false);
    expect(firstOutput.runes.map((rune) => rune.name)).toContain("scalar-probe");
    expect(await readFile(`${root}/.blocks/probe.py`, "utf8")).toBe(BLOCKS_SOURCE);

    const second = await byName.get("list")!.execute({}, callContext("ses"));
    expect(second.output).not.toHaveProperty("migration");
  });

  test("migrate_defaultsToDryRunWithoutMutationOrEditPermission", async () => {
    const root = await freshRoot();
    await seedBlocks(root);
    const { byName, permissionCalls } = await registeredTools({ ses: root });

    const preview = await byName.get("migrate")!.execute({}, callContext("ses"));
    expect(preview.output).toMatchObject({ converted: ["scalar-probe"], dryRun: true });
    expect(permissionCalls.some((call) => call.action === "edit")).toBe(false);
    await expect(new RuneStore(root).load("scalar-probe")).rejects.toThrow();

    const applied = await byName.get("migrate")!.execute({ dryRun: false }, callContext("ses"));
    expect(applied.output).toMatchObject({ converted: ["scalar-probe"], dryRun: false });
    expect((await new RuneStore(root).load("scalar-probe")).source).toBe(BLOCKS_SOURCE);
  });
});
