import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuneError, validateManifest, type RuneManifest } from "../src/contracts.ts";
import { runRune } from "../src/runtime.ts";
import type { LoadedRune } from "../src/store.ts";

// Owned scratch fixtures only. Fixtures are retained after the run and never
// recursively deleted. Every execution below runs a real Bun/Python child
// process owned by the runtime under test.
const FIXTURE_BASE = "/var/tmp/example/opencode";

async function makeRoot(prefix: string): Promise<string> {
  await mkdir(FIXTURE_BASE, { recursive: true });
  return await mkdtemp(path.join(FIXTURE_BASE, `${prefix}-`));
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Bounded polling for event synchronization. Never a fixed sleep: the caller
// names the awaited condition and the test fails loudly on timeout.
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

let markerCounter = 0;
function nextMarker(): string {
  markerCounter += 1;
  return `runes-probe-${process.pid}-${markerCounter}`;
}

// Live /proc scan for descendants that escaped the owned process group.
async function processesMatching(marker: string): Promise<number[]> {
  const found: number[] = [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes(marker)) found.push(pid);
    } catch {
      // The process exited or is unreadable; ignore the race.
    }
  }
  return found;
}

function manifestFor(overrides: Record<string, unknown> = {}): RuneManifest {
  return validateManifest({
    version: 1,
    name: "probe",
    description: "test probe rune",
    language: "javascript",
    interface: "native",
    entry: "main.js",
    params: {},
    effects: "test-only",
    ...overrides,
  });
}

function runeFor(manifest: RuneManifest, source: string): LoadedRune {
  return { manifest, source, hash: "probe-hash" };
}

async function allow(): Promise<void> {}

describe("runtime_javascript_native", () => {
  it("executes_an_async_default_function_with_typed_params", async () => {
    const root = await makeRoot("runes-runtime-js");
    const manifest = manifestFor({
      params: {
        a: { type: "integer", required: true },
        b: { type: "integer", required: true },
      },
    });
    const rune = runeFor(manifest, "export default async (params) => ({ sum: params.a + params.b });");
    const result = await runRune(root, rune, { a: 2, b: 3 }, { authorize: allow });
    expect(result.name).toBe("probe");
    expect(result.value).toEqual({ sum: 5 });
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes_a_typescript_default_function_with_annotations", async () => {
    const root = await makeRoot("runes-runtime-ts");
    const manifest = manifestFor({
      language: "typescript",
      entry: "main.ts",
      params: { name: { type: "string", required: true } },
    });
    const source = "export default function greet(params: { name: string }): string { return `hi ${params.name}`; }";
    const result = await runRune(root, runeFor(manifest, source), { name: "ada" }, { authorize: allow });
    expect(result.value).toBe("hi ada");
  });

  it("routes_console_output_to_stderr_so_stdout_stays_pure_json", async () => {
    const root = await makeRoot("runes-runtime-console");
    const source = 'export default () => { console.log("noisy", { n: 1 }); console.info("also noisy"); return { ok: true }; };';
    const result = await runRune(root, runeFor(manifestFor(), source), {}, { authorize: allow });
    expect(result.value).toEqual({ ok: true });
  });

  it("rejects_a_module_without_a_default_function_export", async () => {
    const root = await makeRoot("runes-runtime-nodefault");
    try {
      await runRune(root, runeFor(manifestFor(), "export const value = 42;"), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("exit");
    }
  });

  it("rejects_a_default_function_returning_no_json_value", async () => {
    const root = await makeRoot("runes-runtime-noreturn");
    try {
      await runRune(root, runeFor(manifestFor(), "export default () => undefined;"), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("exit");
    }
  });
});

describe("runtime_python_native", () => {
  it("reads_params_from_stdin_and_prints_one_json_value", async () => {
    const root = await makeRoot("runes-runtime-py");
    const manifest = manifestFor({
      language: "python",
      entry: "main.py",
      params: { word: { type: "string", required: true } },
    });
    const source = 'import json,sys\nparams = json.load(sys.stdin)\nprint(json.dumps({"echo": params["word"]}))\n';
    const result = await runRune(root, runeFor(manifest, source), { word: "hello" }, { authorize: allow });
    expect(result.name).toBe("probe");
    expect(result.value).toEqual({ echo: "hello" });
  });

  it("rejects_stdout_that_is_not_valid_json", async () => {
    const root = await makeRoot("runes-runtime-pyjson");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    try {
      await runRune(root, runeFor(manifest, 'print("this is not json")\n'), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("output");
    }
  });

  it("reports_nonzero_exit_with_trailing_stderr_context", async () => {
    const root = await makeRoot("runes-runtime-pyexit");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = 'import sys\nprint("boom detail", file=sys.stderr)\nraise SystemExit(3)\n';
    try {
      await runRune(root, runeFor(manifest, source), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("exit");
      expect((error as RuneError).message).toContain("3");
      expect((error as RuneError).message).toContain("boom detail");
    }
  });
});

describe("runtime_legacy_python", () => {
  const sha = "a".repeat(64);

  function legacyManifest(overrides: Record<string, unknown> = {}): RuneManifest {
    return manifestFor({
      language: "python",
      entry: "main.py",
      interface: "argv",
      legacy: { path: "legacy/tool.py", sha256: sha, format: "caveman-blocks" },
      params: {
        word: { type: "string", required: true },
        count: { type: "integer", default: 2 },
      },
      ...overrides,
    });
  }

  const argvSource = [
    "import json,sys",
    "parsed = {}",
    "for arg in sys.argv[1:]:",
    '    name, _, val = arg.lstrip("-").partition("=")',
    "    parsed[name] = val",
    'print(json.dumps({"argv0": sys.argv[0], "file": __file__, "parsed": parsed}))',
    "",
  ].join("\n");

  it("preserves_argv_and_file_identity_for_legacy_scripts", async () => {
    const root = await makeRoot("runes-runtime-argv");
    const result = await runRune(root, runeFor(legacyManifest(), argvSource), { word: "hi", count: 3 }, { authorize: allow });
    const value = result.value as { argv0: string; file: string; parsed: Record<string, string> };
    expect(value.file).toBe(path.join(root, "legacy", "tool.py"));
    expect(value.argv0).toBe(value.file);
    expect(value.parsed).toEqual({ word: "hi", count: "3" });
  });

  it("reads_sibling_data_through_file_identity_without_original_bytes", async () => {
    const root = await makeRoot("runes-runtime-sibling");
    await mkdir(path.join(root, "legacy"), { recursive: true });
    await writeFile(path.join(root, "legacy", "seed.txt"), "sibling-data");
    await writeFile(path.join(root, "legacy", "tool.py"), 'import json\nprint(json.dumps("WRONG-ORIGINAL"))\n');
    const snapshot = [
      "import json,os",
      'with open(os.path.join(os.path.dirname(__file__), "seed.txt")) as handle:',
      '    print(json.dumps({"seed": handle.read(), "file": __file__}))',
      "",
    ].join("\n");
    const result = await runRune(root, runeFor(legacyManifest(), snapshot), { word: "hi" }, { authorize: allow });
    expect(result.value).toEqual({ seed: "sibling-data", file: path.join(root, "legacy", "tool.py") });
  });

  it("reports_non_python_legacy_argv_as_unsupported_before_authorizing", async () => {
    const root = await makeRoot("runes-runtime-argvunsupported");
    const manifest = manifestFor({
      language: "javascript",
      entry: "main.js",
      interface: "argv",
      legacy: { path: "legacy/tool.js", sha256: sha, format: "caveman-blocks" },
      params: { word: { type: "string", required: true } },
    });
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, "export default () => ({});"), { word: "hi" }, {
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("unsupported");
    }
    expect(calls).toBe(0);
  });
});

describe("runtime_param_validation", () => {
  const echo = "export default (params) => params;";

  it("applies_declared_defaults_before_execution", async () => {
    const root = await makeRoot("runes-runtime-defaults");
    const manifest = manifestFor({ params: { greeting: { type: "string", default: "hello" } } });
    const result = await runRune(root, runeFor(manifest, echo), {}, { authorize: allow });
    expect(result.value).toEqual({ greeting: "hello" });
  });

  it("rejects_unknown_params_without_authorizing_or_spawning", async () => {
    const root = await makeRoot("runes-runtime-unknown");
    const manifest = manifestFor({ params: { known: { type: "string" } } });
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, echo), { known: "yes", surprise: 1 }, {
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("invalid_params");
    }
    expect(calls).toBe(0);
  });

  it("rejects_missing_required_params_without_authorizing_or_spawning", async () => {
    const root = await makeRoot("runes-runtime-required");
    const manifest = manifestFor({ params: { token: { type: "string", required: true } } });
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, echo), {}, {
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("invalid_params");
    }
    expect(calls).toBe(0);
  });

  it("rejects_wrong_types_without_coercion_or_spawning", async () => {
    const root = await makeRoot("runes-runtime-coercion");
    const manifest = manifestFor({ params: { count: { type: "integer", required: true } } });
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, echo), { count: "3" }, {
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("invalid_params");
    }
    expect(calls).toBe(0);
  });
});

describe("runtime_authorization", () => {
  it("denied_bash_authorization_propagates_unwrapped_without_side_effects", async () => {
    const root = await makeRoot("runes-runtime-denybash");
    const sentinel = path.join(root, "side-effect.txt");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = `open(${JSON.stringify(sentinel)}, "w").write("x")\nprint("null")\n`;
    const denied = new Error("permission denied for bash");
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, source), {}, {
        authorize: async () => {
          calls += 1;
          throw denied;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBe(denied);
    }
    expect(calls).toBe(1);
    expect(await exists(sentinel)).toBe(false);
  });

  it("denied_runes_run_authorization_still_prevents_side_effects", async () => {
    const root = await makeRoot("runes-runtime-denyrun");
    const sentinel = path.join(root, "side-effect.txt");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = `open(${JSON.stringify(sentinel)}, "w").write("x")\nprint("null")\n`;
    const denied = new Error("permission denied for runes.run");
    const actions: string[] = [];
    try {
      await runRune(root, runeFor(manifest, source), {}, {
        authorize: async (request) => {
          actions.push(request.action);
          if (request.action === "runes.run") throw denied;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBe(denied);
    }
    expect(actions).toEqual(["bash", "runes.run"]);
    expect(await exists(sentinel)).toBe(false);
  });

  it("authorizes_both_actions_with_content_hash_params_and_effects_identity", async () => {
    const root = await makeRoot("runes-runtime-identity");
    const manifest = manifestFor({ params: { n: { type: "integer", default: 7 } } });
    const seen: Array<{ action: string; resources: string[]; metadata?: Record<string, unknown> }> = [];
    const result = await runRune(root, runeFor(manifest, "export default (params) => params;"), {}, {
      authorize: async (request) => {
        seen.push(request);
      },
    });
    expect(result.value).toEqual({ n: 7 });
    expect(seen.map((request) => request.action)).toEqual(["bash", "runes.run"]);
    for (const request of seen) {
      expect(request.resources).toHaveLength(1);
      const raw = request.resources[0];
      expect(typeof raw).toBe("string");
      const identity = JSON.parse(raw as string) as Record<string, unknown>;
      expect(identity).toMatchObject({
        project: root,
        name: "probe",
        sha256: "probe-hash",
        effects: "test-only",
        params: { n: 7 },
      });
      expect(request.metadata).toMatchObject({
        name: "probe",
        sha256: "probe-hash",
        effects: "test-only",
        project: root,
        params: { n: 7 },
      });
      expect(typeof (request.metadata as Record<string, unknown>)["executable"]).toBe("string");
    }
  });
});

describe("runtime_path_params", () => {
  const echo = "export default (params) => params;";
  function pathManifest(): RuneManifest {
    return manifestFor({ params: { target: { type: "path", required: true } } });
  }

  it("confines_a_path_param_to_its_canonical_project_location", async () => {
    const root = await makeRoot("runes-runtime-path");
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "input.txt"), "input");
    const result = await runRune(root, runeFor(pathManifest(), echo), { target: "data/input.txt" }, { authorize: allow });
    expect(result.value).toEqual({ target: path.join(root, "data", "input.txt") });
  });

  it("allows_a_missing_output_path_with_safe_ancestors_without_creating_it", async () => {
    const root = await makeRoot("runes-runtime-pathmissing");
    const result = await runRune(root, runeFor(pathManifest(), echo), { target: "newdir/out.txt" }, { authorize: allow });
    expect(result.value).toEqual({ target: path.join(root, "newdir", "out.txt") });
    expect(await exists(path.join(root, "newdir", "out.txt"))).toBe(false);
  });

  it("accepts_an_existing_directory_valued_path_param", async () => {
    const root = await makeRoot("runes-runtime-pathdir");
    await mkdir(path.join(root, "datadir"), { recursive: true });
    const result = await runRune(root, runeFor(pathManifest(), echo), { target: "datadir" }, { authorize: allow });
    expect(result.value).toEqual({ target: path.join(root, "datadir") });
  });

  it("rejects_dotdot_traversal_in_a_path_param_before_authorizing", async () => {
    const root = await makeRoot("runes-runtime-pathtraversal");
    let calls = 0;
    try {
      await runRune(root, runeFor(pathManifest(), echo), { target: "../escape.txt" }, {
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
    expect(calls).toBe(0);
  });

  it("rejects_an_absolute_path_escaping_the_project", async () => {
    const root = await makeRoot("runes-runtime-pathabsolute");
    const outside = await makeRoot("runes-runtime-pathabsolute-outside");
    const escape = path.join(outside, "secret.txt");
    await writeFile(escape, "secret");
    try {
      await runRune(root, runeFor(pathManifest(), echo), { target: escape }, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_a_symlink_escape_in_a_path_param", async () => {
    const root = await makeRoot("runes-runtime-pathlink");
    const outside = await makeRoot("runes-runtime-pathlink-outside");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"));
    try {
      await runRune(root, runeFor(pathManifest(), echo), { target: "link/secret.txt" }, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_a_regular_file_used_as_a_path_ancestor", async () => {
    const root = await makeRoot("runes-runtime-pathancestor");
    await writeFile(path.join(root, "afile"), "data");
    try {
      await runRune(root, runeFor(pathManifest(), echo), { target: "afile/child.txt" }, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });
});

describe("runtime_source_snapshot", () => {
  it("executes_the_approved_snapshot_when_the_entry_file_changes_during_authorization", async () => {
    const root = await makeRoot("runes-runtime-snapshot");
    const rune = runeFor(manifestFor(), 'export default () => ({ rev: "snapshot" });');
    const entryPath = path.join(root, ".opencode", ".runes", "probe", "main.js");
    const result = await runRune(root, rune, {}, {
      authorize: async () => {
        await mkdir(path.dirname(entryPath), { recursive: true });
        await writeFile(entryPath, 'export default () => ({ rev: "mutated" });');
      },
    });
    expect(result.value).toEqual({ rev: "snapshot" });
    expect(await readFile(entryPath, "utf8")).toContain("mutated");
  });
});

describe("runtime_output_timeout_cancel", () => {
  it("rejects_output_beyond_the_byte_limit", async () => {
    const root = await makeRoot("runes-runtime-outputlimit");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = 'import json\nprint(json.dumps("x" * 70000))\n';
    try {
      await runRune(root, runeFor(manifest, source), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("output_limit");
    }
  });

  it("times_out_and_kills_a_sigterm_ignoring_process_tree", async () => {
    const root = await makeRoot("runes-runtime-timeout");
    const marker = nextMarker();
    const manifest = manifestFor({ language: "python", entry: "main.py", timeoutMs: 300 });
    const source = [
      "import signal,subprocess,sys,time",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      `subprocess.Popen([sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)", ${JSON.stringify(marker)}])`,
      "time.sleep(30)",
      "",
    ].join("\n");
    const started = Date.now();
    try {
      await runRune(root, runeFor(manifest, source), {}, { authorize: allow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("timeout");
    }
    // SIGKILL escalation must bound the kill even though the tree ignores SIGTERM.
    expect(Date.now() - started).toBeLessThan(10000);
    await waitFor(async () => (await processesMatching(marker)).length === 0, 5000, "timeout process tree cleanup");
  });

  it("cancels_on_abort_after_deterministic_ready_sync", async () => {
    const root = await makeRoot("runes-runtime-cancel");
    const ready = path.join(root, "ready.txt");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = `import time\nopen(${JSON.stringify(ready)}, "w").write("ready")\ntime.sleep(30)\n`;
    const controller = new AbortController();
    const pending = runRune(root, runeFor(manifest, source), {}, { signal: controller.signal, authorize: allow });
    await waitFor(() => exists(ready), 5000, "rune readiness signal");
    controller.abort();
    try {
      await pending;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("cancelled");
    }
    // The runtime stays usable after a cancellation.
    const followUp = await runRune(root, runeFor(manifestFor(), "export default () => ({ ok: true });"), {}, { authorize: allow });
    expect(followUp.value).toEqual({ ok: true });
  });

  it("rejects_an_already_aborted_signal_without_authorizing_or_spawning", async () => {
    const root = await makeRoot("runes-runtime-preabort");
    const sentinel = path.join(root, "side-effect.txt");
    const manifest = manifestFor({ language: "python", entry: "main.py" });
    const source = `open(${JSON.stringify(sentinel)}, "w").write("x")\nprint("null")\n`;
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    try {
      await runRune(root, runeFor(manifest, source), {}, {
        signal: controller.signal,
        authorize: async () => {
          calls += 1;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("cancelled");
    }
    expect(calls).toBe(0);
    expect(await exists(sentinel)).toBe(false);
  });

  it("terminates_background_descendants_after_a_successful_exit", async () => {
    const root = await makeRoot("runes-runtime-descendants");
    const marker = nextMarker();
    const source = [
      'import { spawn } from "node:child_process";',
      "export default async () => {",
      `  const grandchild = spawn("python3", ["-c", "import time;time.sleep(30)", ${JSON.stringify(marker)}], { stdio: "ignore" });`,
      "  grandchild.unref();",
      '  return { spawned: true };',
      "};",
      "",
    ].join("\n");
    const result = await runRune(root, runeFor(manifestFor(), source), {}, { authorize: allow });
    expect(result.value).toEqual({ spawned: true });
    await waitFor(async () => (await processesMatching(marker)).length === 0, 5000, "background descendant cleanup");
  });
});
