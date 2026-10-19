import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateBlocks } from "../src/migrate.ts";
import { runRune } from "../src/runtime.ts";
import { RuneStore } from "../src/store.ts";

// End-to-end migration coverage for decided behavior: real `.blocks` Python
// sources are copied read-only into unique owned fixture roots, converted via
// migrateBlocks, then executed via RuneStore.load + runRune. Fixtures are
// retained after the run and never recursively deleted. Fault-check and
// deployment/activation helpers are never executed here.
const GLOBAL_BLOCKS = "/home/example/.config/opencode-v2/.blocks";
const BOTS_BLOCKS = "/home/example/Documents/example-project-a/.blocks";
const FIXTURE_BASE = "/var/tmp/example/opencode";

// Explicit test-only authorizer: allows every permission request. It must
// only be used with owned scratch roots and never with production data.
const allowTestOnly = async (): Promise<void> => {};

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function ownedRoot(prefix: string): Promise<string> {
  await mkdir(FIXTURE_BASE, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_BASE, `${prefix}-`));
  await mkdir(join(root, ".blocks"), { recursive: true });
  return root;
}

describe("migration_runtime_json_peek", () => {
  test("migrated_probe_reports_shape_of_controlled_input", async () => {
    const root = await ownedRoot("runes-migration-runtime-jsonpeek");
    const scriptPath = join(GLOBAL_BLOCKS, "json-peek.py");
    const original = await readFile(scriptPath);
    await copyFile(scriptPath, join(root, ".blocks", "json-peek.py"));

    await mkdir(join(root, "data"), { recursive: true });
    const sampleText = '{"name":"ada","count":3}';
    await writeFile(join(root, "data", "sample.json"), sampleText);

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["json-peek"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("json-peek");
    expect(loaded.source).toBe(original.toString("utf8"));
    expect(loaded.manifest.legacy).toMatchObject({
      path: ".blocks/json-peek.py",
      sha256: digest(original),
      format: "caveman-blocks",
    });

    const params = { path: "data/sample.json", depth: 2 };
    const first = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(first.name).toBe("json-peek");
    expect(first.value).toEqual({
      kind: "object",
      keys: ["name", "count"],
      rows: 1,
      sample: { name: "ada", count: 3 },
      truncated: false,
    });
    expect(typeof first.durationMs).toBe("number");

    // Original project bytes and the fixture copy are unchanged by migration and execution.
    expect(await readFile(join(root, ".blocks", "json-peek.py"))).toEqual(original);
    expect(await readFile(scriptPath)).toEqual(original);
    expect(await readFile(join(root, "data", "sample.json"), "utf8")).toBe(sampleText);

    // Repeating the run reuses the already-loaded snapshot without
    // re-emitting source and yields the identical bounded result.
    const second = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(second.value).toEqual(first.value);

    const repeated = await migrateBlocks(root, {
      dryRun: false,
      authorize: async () => {
        throw new Error("repeat migration must not ask again");
      },
    });
    expect(repeated).toEqual({ converted: [], existing: ["json-peek"], unsupported: [], dryRun: false });
  });
});

describe("migration_runtime_artifact_probe", () => {
  test("migrated_probe_reports_exact_literal_offsets", async () => {
    const root = await ownedRoot("runes-migration-runtime-artifact");
    const scriptPath = join(GLOBAL_BLOCKS, "artifact-literal-probe.py");
    const original = await readFile(scriptPath);
    await copyFile(scriptPath, join(root, ".blocks", "artifact-literal-probe.py"));

    await mkdir(join(root, "data"), { recursive: true });
    // 64 bytes of context on each side keep the default 64-byte windows exact.
    const artifactText = `${"A".repeat(70)}NEEDLE${"B".repeat(70)}`;
    await writeFile(join(root, "data", "sample.bin"), artifactText);

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["artifact-literal-probe"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("artifact-literal-probe");
    expect(loaded.manifest.legacy).toMatchObject({
      path: ".blocks/artifact-literal-probe.py",
      sha256: digest(original),
      format: "caveman-blocks",
    });

    const params = { path: "data/sample.bin", literal: "NEEDLE" };
    const first = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(first.name).toBe("artifact-literal-probe");
    expect(first.value).toEqual({
      path: join(root, "data", "sample.bin"),
      sha256: digest(artifactText),
      file_size: 146,
      literal: "NEEDLE",
      offset_start: 0,
      total_matches: 1,
      matches: [{ offset: 70, before: "A".repeat(64), after: "B".repeat(64) }],
      truncated: false,
      matches_truncated: false,
      context_clipped: false,
      more_skipped: 0,
    });

    expect(await readFile(join(root, ".blocks", "artifact-literal-probe.py"))).toEqual(original);
    expect(await readFile(scriptPath)).toEqual(original);
    expect(await readFile(join(root, "data", "sample.bin"), "utf8")).toBe(artifactText);

    const second = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(second.value).toEqual(first.value);

    const repeated = await migrateBlocks(root, {
      dryRun: false,
      authorize: async () => {
        throw new Error("repeat migration must not ask again");
      },
    });
    expect(repeated).toEqual({ converted: [], existing: ["artifact-literal-probe"], unsupported: [], dryRun: false });
  });
});

describe("migration_runtime_brand_export", () => {
  // Reports a skip (rather than installing anything) when rsvg-convert is unavailable.
  test.skipIf(!Bun.which("rsvg-convert"))("migrated_export_renders_small_png", async () => {
    const root = await ownedRoot("runes-migration-runtime-brand");
    const scriptPath = join(BOTS_BLOCKS, "brand-export.py");
    const svgPath = join(BOTS_BLOCKS, "fixtures", "brand-export", "sample.svg");
    const originalScript = await readFile(scriptPath);
    const originalSvg = await readFile(svgPath);
    await copyFile(scriptPath, join(root, ".blocks", "brand-export.py"));
    await mkdir(join(root, ".blocks", "fixtures", "brand-export"), { recursive: true });
    await copyFile(svgPath, join(root, ".blocks", "fixtures", "brand-export", "sample.svg"));

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["brand-export"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("brand-export");
    expect(loaded.manifest.legacy).toMatchObject({
      path: ".blocks/brand-export.py",
      sha256: digest(originalScript),
      format: "caveman-blocks",
    });

    const output = ".blocks/fixtures/brand-export/sample-32.png";
    const params = {
      source: ".blocks/fixtures/brand-export/sample.svg",
      output,
      size: 32,
    };
    const first = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(first.name).toBe("brand-export");
    expect(first.value).toMatchObject({ output, width: 32, height: 32, size: 32 });
    const firstBytes = (first.value as { bytes: unknown }).bytes;
    expect(typeof firstBytes).toBe("number");
    expect(firstBytes as number).toBeGreaterThan(0);

    const png = await readFile(join(root, output));
    expect(png.length).toBe(firstBytes as number);
    expect(Buffer.from(png.subarray(0, 8))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    expect((await stat(join(root, output))).size).toBe(firstBytes as number);

    // Master SVG and block script are preserved byte-for-byte in both the
    // fixture copy and the original project.
    expect(await readFile(join(root, ".blocks", "brand-export.py"))).toEqual(originalScript);
    expect(await readFile(scriptPath)).toEqual(originalScript);
    expect(await readFile(join(root, ".blocks", "fixtures", "brand-export", "sample.svg"))).toEqual(originalSvg);
    expect(await readFile(svgPath)).toEqual(originalSvg);

    const second = await runRune(root, loaded, params, { authorize: allowTestOnly });
    expect(second.value).toMatchObject({ output, width: 32, height: 32, size: 32 });

    const repeated = await migrateBlocks(root, {
      dryRun: false,
      authorize: async () => {
        throw new Error("repeat migration must not ask again");
      },
    });
    expect(repeated).toEqual({ converted: [], existing: ["brand-export"], unsupported: [], dryRun: false });
  });
});
