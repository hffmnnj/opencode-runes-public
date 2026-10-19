import { spawn } from "node:child_process";
import path from "node:path";
import { LIMITS, RuneError, validateParams } from "./contracts.ts";
import { safePath } from "./paths.ts";
import type { LoadedRune } from "./store.ts";

export type Authorization = {
  action: string;
  resources: string[];
  metadata?: Record<string, unknown>;
};

const pythonWorker = `import io,json,sys
e=json.load(sys.stdin)
sys.argv=[e["filename"]]+e["argv"]
sys.stdin=io.StringIO(json.dumps(e["params"]))
if e["legacy"]:
    import os
    sys.path.insert(0,os.path.dirname(e["filename"]))
g={"__name__":"__main__","__file__":e["filename"],"__package__":None}
exec(compile(e["source"],e["filename"],"exec"),g,g)
`;

const javascriptWorker = `
const envelope = await Bun.stdin.json();
const log = (...args) => console.error(...args);
console.log = log;
console.info = log;
console.debug = log;
const source = envelope.language === "typescript"
  ? new Bun.Transpiler({loader:"ts"}).transformSync(envelope.source)
  : envelope.source;
const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
if (typeof module.default !== "function") throw new Error("Rune must export a default function");
const value = await module.default(envelope.params);
const json = JSON.stringify(value);
if (json === undefined) throw new Error("Rune returned no JSON value");
process.stdout.write(json);
`;

// Only the exact entry URL is replaced. Dependencies retain normal Node loading
// and are trusted host code, not part of the approved entry snapshot.
const legacyJavascriptWorker = `
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const envelope = JSON.parse(text);
if (typeof nodeModule.registerHooks !== "function") throw new Error("Legacy JavaScript requires Node registerHooks (Node >=22.15)");
const entry = pathToFileURL(envelope.filename).href;
process.argv = [process.execPath, envelope.filename, ...envelope.argv];
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === entry) return { url: entry, format: envelope.format, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === entry) return { format: envelope.format, source: envelope.source, shortCircuit: true };
    return nextLoad(url, context);
  }
});
await import(entry);
`;

function encodeArgv(manifest: LoadedRune["manifest"], params: Record<string, string | number | boolean>): string[] {
  if (manifest.interface !== "argv") return [];
  const argv: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const encoding = manifest.legacy?.argv?.[key];
    if (encoding?.mode === "flag") {
      if (value === (encoding.when ?? true)) argv.push(`--${key}`);
    } else if (encoding?.mode === "repeat-json") {
      let values: unknown;
      try { values = JSON.parse(value as string); }
      catch { throw new RuneError("invalid_params", `param ${key}: expected JSON string array`); }
      if (!Array.isArray(values) || !values.every(v => typeof v === "string")) {
        throw new RuneError("invalid_params", `param ${key}: expected JSON string array`);
      }
      argv.push(...values.map(v => `--${key}=${v}`));
    } else {
      if (typeof value === "boolean") throw new RuneError("invalid_params", `param ${key}: ambiguous boolean argv encoding`);
      argv.push(`--${key}=${String(value)}`);
    }
  }
  return argv;
}

function abortError(): RuneError { return new RuneError("cancelled", "Rune execution was cancelled"); }

export async function runRune(
  root: string,
  rune: LoadedRune,
  input: unknown,
  options: { signal?: AbortSignal; authorize: (request: Authorization) => Promise<void> },
): Promise<{ name: string; value: unknown; durationMs: number }> {
  const started = performance.now();
  const { manifest, source, hash } = rune;
  const params = validateParams(manifest, input ?? {});
  for (const [name, spec] of Object.entries(manifest.params)) {
    if (spec.type !== "path" || params[name] === undefined) continue;
    const value = params[name] as string;
    const relative = path.isAbsolute(value) ? path.relative(root, value) || "." : value;
    // Missing output paths are allowed only when every existing ancestor is safe.
    params[name] = await safePath(root, relative, { missing: true, any: true });
  }
  if (options.signal?.aborted) throw abortError();
  const argv = encodeArgv(manifest, params);
  const legacyJavascript = manifest.interface === "argv" && manifest.language !== "python";
  if (legacyJavascript && !manifest.legacy) throw new RuneError("unsupported", "Legacy JavaScript requires original path provenance");
  const executable = Bun.which(manifest.language === "python" ? "python3" : legacyJavascript ? "node" : "bun");
  if (!executable) throw new RuneError("runtime", "Required script interpreter is unavailable");
  const filename = manifest.legacy
    ? await safePath(root, manifest.legacy.path, { missing: true })
    : path.join(root, ".opencode", ".runes", manifest.name, manifest.entry);
  // .cjs is explicitly CommonJS; .js/.mjs/.ts legacy entries are ESM.
  // Do not guess a format from source patterns or read mutable entry bytes.
  const format = filename.endsWith(".cjs") ? "commonjs" : "module";
  const snapshot = legacyJavascript && manifest.language === "typescript"
    ? new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(source) : source;
  const args = manifest.language === "python"
    ? ["-I", "-c", pythonWorker]
    : legacyJavascript ? ["--input-type=module", "--eval", legacyJavascriptWorker]
    : ["--config=/dev/null", "--no-env-file", "--no-macros", "--eval", javascriptWorker];
  const identity = JSON.stringify({ executable, project: root, name: manifest.name, sha256: hash, effects: manifest.effects, params });
  const metadata = { name: manifest.name, sha256: hash, effects: manifest.effects, params, executable, args, project: root };
  await options.authorize({ action: "bash", resources: [identity], metadata });
  await options.authorize({ action: "runes.run", resources: [identity], metadata });
  if (options.signal?.aborted) throw abortError();
  const envelope = JSON.stringify({ source: snapshot, params, filename, argv, format, language: manifest.language, legacy: !!manifest.legacy });

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: RuneError | undefined;
    let escalator: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
    };
    const stop = (error: RuneError) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      escalator = setTimeout(() => kill("SIGKILL"), 200);
    };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(new RuneError("timeout", "Rune exceeded its execution timeout")), manifest.timeoutMs ?? LIMITS.defaultTimeoutMs);
    const receive = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > LIMITS.outputBytes) { stop(new RuneError("output_limit", "Rune output exceeded its byte limit")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.stdin.on("error", () => { /* Early child exit is handled by its exit status. */ });
    child.on("error", () => { failure ??= new RuneError("runtime", "Failed to start script interpreter"); });
    // A rune must not leave background descendants behind after its interpreter exits.
    child.on("exit", () => kill("SIGKILL"));
    child.on("close", code => {
      clearTimeout(timer);
      if (escalator) clearTimeout(escalator);
      options.signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new RuneError("exit", `Rune exited with status ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        const value: unknown = JSON.parse(text);
        resolve({ name: manifest.name, value, durationMs: Math.round(performance.now() - started) });
      } catch { reject(new RuneError("output", "Rune must emit exactly one valid UTF-8 JSON value")); }
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(envelope);
  });
}
