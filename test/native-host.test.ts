import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This opt-in test owns a private database/server and never touches the shared service.
const binary = process.env.RUNES_NATIVE_BINARY;
test.skipIf(!binary)("built plugin registers exactly five Code Mode tools in native OpenCode 2.0.32", async () => {
  const root = await mkdtemp("/var/tmp/example/opencode/runes-native-");
  const repo = path.resolve(import.meta.dir, "..");
  for (const name of ["home", "config", "data", "cache", "state", "workspace", "probe"]) {
    await mkdir(path.join(root, name));
  }
  await symlink(path.join(repo, "node_modules"), path.join(root, "probe", "node_modules"));
  const marker = path.join(root, "registered.json");
  await writeFile(path.join(root, "probe", "package.json"), JSON.stringify({ name: "runes-native-probe", type: "module" }));
  await writeFile(path.join(root, "probe", "index.ts"), `
import { Plugin } from "@opencode/plugin";
import { writeFile } from "node:fs/promises";
import runes from ${JSON.stringify(pathToFileURL(path.join(repo, "dist", "index.js")).href)};
export default Plugin.define({ id: "runes-native-probe", async setup(ctx) {
  await runes.setup(ctx);
  const tools = (await ctx.tool.list()).filter(t => t.options?.namespace === "runes");
  await writeFile(${JSON.stringify(marker)}, JSON.stringify(tools.map(t => ({name:t.name,id:t.id,options:t.options,input:t.input}))));
}});
`);
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
    cwd: path.join(root, "workspace"), env, stdio: ["ignore", "pipe", "pipe"],
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
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(path.join(root, "workspace")),
      "content-type": "application/json",
    };
    const request = async (route: string, body?: unknown): Promise<any> => {
      const response = await fetch(url + route, {
        method: body === undefined ? "GET" : "POST", headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Private native API ${route} returned ${response.status}`);
      return response.json();
    };
    const info = await request("/api/info");
    expect(info.version).toBe("2.0.32");
    expect(info.pid).toBe(child.pid);
    const session = await request("/api/session", { title: "Isolated Runes registration test", agent: "build" });
    const sessionID = (session.data ?? session).id;
    // Admission initializes plugins; the deliberately absent provider cannot execute a model.
    await request(`/api/session/${sessionID}/prompt`, { text: "Initialize isolated registration probe only." });
    const catalog = await request("/api/plugin");
    const probe = catalog.data.filter((item: any) => item.id === "runes-native-probe");
    expect(probe).toHaveLength(1);
    expect(probe[0].state.status).toBe("active");
    const tools = JSON.parse(await readFile(marker, "utf8"));
    expect(tools.map((tool: any) => tool.name).sort()).toEqual(["inspect", "list", "migrate", "run", "save"]);
    for (const tool of tools) {
      expect(tool.options).toMatchObject({ namespace: "runes", codemode: true });
      expect(tool.input.type).toBe("object");
    }
    expect((await request("/api/info")).pid).toBe(child.pid);
  } finally {
    child.kill("SIGTERM");
    const escalator = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(escalator);
  }
}, 65000);
