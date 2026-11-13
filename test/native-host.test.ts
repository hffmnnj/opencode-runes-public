import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// This opt-in test owns a private database/server and never touches the shared service.
// It drives the real registered runes tools through a private-only probe RPC that
// invokes tool.execute with the real private session/context (real ctx.session.get
// and real ctx.permission.assert). No fake authorization, no model calls: the
// configured provider is intentionally missing and no prompt is ever sent.
const binary = process.env.RUNES_NATIVE_BINARY;

// Minimal legacy fixture mirrored from tools.test.ts (kept visible per DAMP).
const BLOCKS_SOURCE = `#!/usr/bin/env python3\n# /// block\n# name = "scalar-probe"\n# summary = "Scalar probe"\n# effects = "write-workspace"\n# example = ["--count", "8"]\n# [params]\n# count = { type = "int", default = 7, min = 1, max = 10, help = "Count items" }\n# ///\nraise RuntimeError("MIGRATION MUST NOT EXECUTE THIS")\n`;

const JS_MANIFEST = {
  version: 1,
  name: "echo-js",
  description: "Echo rune echo-js",
  language: "javascript",
  interface: "native",
  entry: "main.js",
  params: {
    who: { type: "string", default: "world" },
    count: { type: "integer", default: 1, min: 1, max: 10 },
  },
  effects: "test-only",
};

const JS_SOURCE = `export default async function (params) {\n  return { echo: params };\n}\n`;

const TS_MANIFEST = {
  version: 1,
  name: "echo-ts",
  description: "Echo rune echo-ts",
  language: "typescript",
  interface: "native",
  entry: "main.ts",
  params: {
    label: { type: "string", default: "plain" },
    flag: { type: "boolean", default: false },
  },
  effects: "test-only",
};

const TS_SOURCE = `export default async function (params: any): Promise<unknown> {\n  return { echo: params };\n}\n`;

const PY_MANIFEST = {
  version: 1,
  name: "echo-py",
  description: "Echo rune echo-py",
  language: "python",
  interface: "native",
  entry: "main.py",
  params: {
    who: { type: "string", default: "world" },
    n: { type: "integer", default: 2, min: 1, max: 10 },
  },
  effects: "test-only",
};

const PY_SOURCE = `import json, sys\nprint(json.dumps({"echo": json.load(sys.stdin)}))\n`;

test.skipIf(!binary)("built plugin serves runes tools end to end through a private probe RPC", async () => {
  if (!Bun.which("python3")) throw new Error("python3 is required for this test");
  const root = await mkdtemp(path.join(tmpdir(), "runes-native-"));
  const repo = path.resolve(import.meta.dir, "..");
  const workspace = path.join(root, "workspace");
  const workspaceB = path.join(root, "workspace-b");
  for (const name of ["home", "config", "data", "cache", "state", "workspace", "workspace-b", "probe"]) {
    await mkdir(path.join(root, name), { recursive: true });
  }
  await symlink(path.join(repo, "node_modules"), path.join(root, "probe", "node_modules"));
  await symlink(path.join(repo, "dist"), path.join(root, "probe", "dist"));
  const marker = path.join(root, "registered.json");
  // Relative import into the symlinked built artifact: the native plugin
  // loader rejects absolute dist internals (observed on the goals plugin).
  await writeFile(path.join(root, "probe", "package.json"), JSON.stringify({ name: "runes-native-probe", type: "module" }));
  // The probe registers tools via the built artifact, records the setup-time
  // catalog, then exposes a private-only RPC that executes those tools with a
  // real session/context. Tool invocation never happens inside setup, so no
  // setup deadlock is possible; every call below goes through the RPC.
  await writeFile(
    path.join(root, "probe", "index.ts"),
    "import { Plugin } from \"@opencode/plugin\";\n" +
      "import { Rpc } from \"@opencode/plugin/rpc\";\n" +
      "import { writeFile } from \"node:fs/promises\";\n" +
      "import runes from \"./dist/index.js\";\n" +
      "const ProbeRPC = Rpc.define({\n" +
      "  id: \"runes-native-probe\",\n" +
      "  methods: {\n" +
      "    invoke: { input: { type: \"object\" }, output: { type: \"object\" } },\n" +
      "    describe: { input: { type: \"object\" }, output: { type: \"object\" } },\n" +
      "  },\n" +
      "  events: {},\n" +
      "});\n" +
      "let seq = 0;\n" +
      "export default Plugin.define({ id: \"runes-native-probe\", async setup(ctx) {\n" +
      "  await runes.setup(ctx);\n" +
      "  const tools = (await ctx.tool.list()).filter((t) => t.options && t.options.namespace === \"runes\");\n" +
      "  await writeFile(" + JSON.stringify(marker) + ", JSON.stringify(tools.map((t) => ({name:t.name,id:t.id,options:t.options,input:t.input}))));\n" +
      "  await ctx.rpc.register(ProbeRPC, {\n" +
      "    describe: async () => {\n" +
      "      const current = (await ctx.tool.list()).filter((t) => t.options && t.options.namespace === \"runes\");\n" +
      "      return { names: current.map((t) => t.name).sort() };\n" +
      "    },\n" +
      "    invoke: async (input, context) => {\n" +
      "      const sessionID = input.sessionID;\n" +
      "      const name = input.tool;\n" +
      "      const toolInput = input.toolInput !== undefined ? input.toolInput : {};\n" +
      "      const current = await ctx.tool.list();\n" +
      "      const target = current.find((t) => t.name === name && t.options && t.options.namespace === \"runes\");\n" +
      "      if (!target) return { ok: false, error: \"tool-not-found: \" + name };\n" +
      "      seq += 1;\n" +
      "      try {\n" +
      "        const result = await target.execute(toolInput, {\n" +
      "          sessionID: sessionID,\n" +
      "          agent: \"build\",\n" +
      "          messageID: \"msg-probe-\" + seq,\n" +
      "          id: \"call-probe-\" + seq,\n" +
      "          signal: context.signal,\n" +
      "          progress: async () => {},\n" +
      "        });\n" +
      "        return { ok: true, output: result.output === undefined ? null : result.output };\n" +
      "      } catch (err) {\n" +
      "        return { ok: false, error: String((err && err.message) || err) };\n" +
      "      }\n" +
      "    },\n" +
      "  });\n" +
      "}});\n",
  );
  await writeFile(path.join(root, "config", "opencode.json"), JSON.stringify({
    warming: false, update: "disable", model: "runes-private-missing/no-model",
    plugins: [path.join(root, "probe")],
  }));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCODE|XDG_)/i.test(key) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|AUTH|PROXY/i.test(key)) continue;
    env[key] = value;
  }
  const password = crypto.randomUUID();
  Object.assign(env, {
    HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"), OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_DB: path.join(root, "data", "probe.db"), OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  });
  const child = spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  let logs = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Private native server startup timed out: ${logs.slice(-2000)}`)), 30000);
      const receive = (data: Buffer) => {
        logs = (logs + data.toString()).slice(-65536);
        const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); reject(new Error(`Private native server exited ${code}: ${logs.slice(-2000)}`)); });
    });
    const headersFor = (directory: string) => ({
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(directory),
      "content-type": "application/json",
    });
    const request = async (route: string, body: unknown, directory: string = workspace): Promise<any> => {
      const response = await fetch(url + route, {
        method: "POST", headers: headersFor(directory),
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`Private native API ${route} returned ${response.status}: ${(await response.text()).slice(-2000)}`);
      return response.json();
    };
    const rpc = async (method: string, input: unknown, directory: string = workspace): Promise<any> => {
      const parsed = await request(`/api/rpc/runes-native-probe/${method}`, { input }, directory);
      return parsed.output !== undefined ? parsed.output : parsed;
    };
    const invoke = async (sessionID: string, tool: string, toolInput: unknown, directory: string = workspace): Promise<any> => {
      const envelope = await rpc("invoke", { sessionID, tool, toolInput }, directory);
      if (typeof envelope?.error === "string" && /metadata|Expected object/i.test(envelope.error)) {
        throw new Error(`Native permission shape fault during ${tool}: ${envelope.error}`);
      }
      return envelope;
    };
    const info = await (async () => {
      const response = await fetch(url + "/api/info", { headers: headersFor(workspace), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Private native API /api/info returned ${response.status}`);
      return response.json();
    })();
    expect(info.version).toBe("2.0.32");
    expect(info.pid).toBe(child.pid);
    const session = await request("/api/session", { title: "Isolated Runes probe A", agent: "build" });
    const sessionID = (session.data ?? session).id as string;
    // No prompt is ever sent: the provider is intentionally missing and every
    // behavior below is driven through the private probe RPC instead.
    const catalog = await (async () => {
      // Plugin loading is asynchronous after "server listening": poll until
      // the probe is registered and active instead of asserting immediately.
      const deadline = Date.now() + 30000;
      let last: any = undefined;
      for (;;) {
        const response = await fetch(url + "/api/plugin", { headers: headersFor(workspace), signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Private native API /api/plugin returned ${response.status}`);
        last = await response.json();
        const found = (last.data ?? []).filter((item: any) => item.id === "runes-native-probe");
        if (found.length === 1 && found[0].state?.status === "active") return last;
        if (Date.now() > deadline) return last;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    })();
    const probe = catalog.data.filter((item: any) => item.id === "runes-native-probe");
    expect(probe).toHaveLength(1);
    expect(probe[0].state.status).toBe("active");
    const tools = JSON.parse(await readFile(marker, "utf8"));
    expect(tools.map((tool: any) => tool.name).sort()).toEqual(["inspect", "list", "migrate", "run", "save"]);
    for (const tool of tools) {
      expect(tool.options).toMatchObject({ namespace: "runes", codemode: true });
      expect(tool.input.type).toBe("object");
    }
    const described = await rpc("describe", {});
    expect(described.names).toEqual(["inspect", "list", "migrate", "run", "save"]);

    // Explicit migrate: dry-run previews without mutation or rune creation.
    await mkdir(path.join(workspace, ".blocks"), { recursive: true });
    await writeFile(path.join(workspace, ".blocks", "probe.py"), BLOCKS_SOURCE, "utf8");
    const preview = await invoke(sessionID, "migrate", {});
    expect(preview.ok).toBe(true);
    expect(preview.output.converted).toEqual(["scalar-probe"]);
    expect(preview.output.dryRun).toBe(true);
    expect(await Bun.file(path.join(workspace, ".opencode", ".runes", "scalar-probe", "rune.json")).exists()).toBe(false);
    expect(await readFile(path.join(workspace, ".blocks", "probe.py"), "utf8")).toBe(BLOCKS_SOURCE);
    const applied = await invoke(sessionID, "migrate", { dryRun: false });
    expect(applied.ok).toBe(true);
    expect(applied.output.converted).toEqual(["scalar-probe"]);
    expect(applied.output.dryRun).toBe(false);

    // Trilingual save/list/inspect/run with non-default typed params.
    for (const [manifest, source] of [[JS_MANIFEST, JS_SOURCE], [TS_MANIFEST, TS_SOURCE], [PY_MANIFEST, PY_SOURCE]] as const) {
      const saved = await invoke(sessionID, "save", { manifest, source });
      expect(saved.ok).toBe(true);
      expect(saved.output).toMatchObject({ name: (manifest as { name: string }).name, created: true });
      expect(typeof saved.output.hash).toBe("string");
    }
    const listed = await invoke(sessionID, "list", {});
    expect(listed.ok).toBe(true);
    const names = (listed.output.runes as Array<{ name: string }>).map(rune => rune.name);
    for (const name of ["echo-js", "echo-ts", "echo-py", "scalar-probe"]) expect(names).toContain(name);
    for (const [name, source] of [["echo-js", JS_SOURCE], ["echo-ts", TS_SOURCE], ["echo-py", PY_SOURCE]] as const) {
      const inspected = await invoke(sessionID, "inspect", { name });
      expect(inspected.ok).toBe(true);
      expect(inspected.output).not.toHaveProperty("source");
      expect((inspected.output.manifest as { name: string }).name).toBe(name);
      const withSource = await invoke(sessionID, "inspect", { name, includeSource: true });
      expect(withSource.ok).toBe(true);
      expect(withSource.output.source).toBe(source);
    }
    const jsRun = await invoke(sessionID, "run", { name: "echo-js", params: { who: "ada", count: 7 } });
    expect(jsRun.ok).toBe(true);
    expect(jsRun.output.value).toEqual({ echo: { who: "ada", count: 7 } });
    const jsDefaulted = await invoke(sessionID, "run", { name: "echo-js", params: {} });
    expect(jsDefaulted.ok).toBe(true);
    expect(jsDefaulted.output.value).toEqual({ echo: { who: "world", count: 1 } });
    const tsRun = await invoke(sessionID, "run", { name: "echo-ts", params: { label: "wet", flag: true } });
    expect(tsRun.ok).toBe(true);
    expect(tsRun.output.value).toEqual({ echo: { label: "wet", flag: true } });
    const pyRun = await invoke(sessionID, "run", { name: "echo-py", params: { who: "snek", n: 5 } });
    expect(pyRun.ok).toBe(true);
    expect(pyRun.output.value).toEqual({ echo: { who: "snek", n: 5 } });

    // Inspect root isolation: a second session in another directory sees
    // neither the runes nor their sources.
    // The create header alone does not pin the session directory (the server
    // defaults to its cwd), so session B carries an explicit location.
    const sessionB = await request("/api/session", { title: "Isolated Runes probe B", agent: "build", location: { directory: workspaceB } }, workspaceB);
    const sessionBID = (sessionB.data ?? sessionB).id as string;
    const listedB = await invoke(sessionBID, "list", {}, workspaceB);
    expect(listedB.ok).toBe(true);
    expect(listedB.output.runes).toEqual([]);
    const missingB = await invoke(sessionBID, "run", { name: "echo-js", params: {} }, workspaceB);
    expect(missingB.ok).toBe(true);
    expect(missingB.output).toMatchObject({ error: { code: "not-found" } });
    const savedB = await invoke(sessionBID, "save", {
      manifest: { ...JS_MANIFEST, name: "b-only", description: "Session B rune" },
      source: JS_SOURCE,
    }, workspaceB);
    expect(savedB.ok).toBe(true);
    const relisted = await invoke(sessionID, "list", {});
    expect((relisted.output.runes as Array<{ name: string }>).map(rune => rune.name)).not.toContain("b-only");

    expect((await (async () => {
      const response = await fetch(url + "/api/info", { headers: headersFor(workspace), signal: AbortSignal.timeout(20000) });
      return response.json();
    })()).pid).toBe(child.pid);
  } finally {
    child.kill("SIGTERM");
    const escalator = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(escalator);
  }
}, 120000);
