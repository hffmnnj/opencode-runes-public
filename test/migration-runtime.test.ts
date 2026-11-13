import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateBlocks } from "../src/migrate.ts";
import { runRune } from "../src/runtime.ts";
import { RuneStore } from "../src/store.ts";

// End-to-end migration coverage for decided behavior: synthetic `.blocks`
// Python sources are written into unique owned fixture roots, converted via
// migrateBlocks, then executed via RuneStore.load + runRune. Fixtures are
// retained after the run and never recursively deleted. Fault-check and
// deployment/activation helpers are never executed here.

// Explicit test-only authorizer: allows every permission request. It must
// only be used with owned scratch roots and never with production data.
const allowTestOnly = async (): Promise<void> => {};

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function ownedRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await mkdir(join(root, ".blocks"), { recursive: true });
  return root;
}

// Legacy Python block headers are TOML comments; the body is ordinary Python
// executed by the runtime's argv worker after migration.
function legacyBlock(name: string, summary: string, params: string, body: string, effects = "read-only fixture"): string {
  const header = params.split("\n").map((line) => `# ${line}`).join("\n");
  return [
    "#!/usr/bin/env python3",
    "# /// block",
    `# name = "${name}"`,
    `# summary = "${summary}"`,
    `# effects = "${effects}"`,
    "# [params]",
    header,
    "# ///",
    body,
  ].join("\n");
}

const jsonPeekBlock = legacyBlock(
  "json-peek",
  "Synthetic JSON shape probe",
  'path = { type = "path", required = true }\ndepth = { type = "int", default = 2, min = 1, max = 10 }',
  `import json, sys

options = {}
for argument in sys.argv[1:]:
    name, _, value = argument.partition("=")
    options[name.removeprefix("--")] = value

with open(options["path"], encoding="utf-8") as handle:
    document = json.load(handle)

depth = int(options.get("depth", "2"))

def shape(value, remaining):
    if isinstance(value, dict):
        return {
            "kind": "object",
            "keys": list(value),
            "rows": 1,
            "sample": value if remaining > 0 else {},
            "truncated": False,
        }
    if isinstance(value, list):
        return {
            "kind": "array",
            "rows": len(value),
            "sample": value[:2] if remaining > 0 else [],
            "truncated": len(value) > 2,
        }
    return {"kind": "scalar", "sample": value, "truncated": False}

print(json.dumps(shape(document, depth)))
`,
);

const literalProbeBlock = legacyBlock(
  "artifact-literal-probe",
  "Synthetic literal offset probe",
  'path = { type = "path", required = true }\nliteral = { type = "str", required = true }',
  `import hashlib, json, sys

options = {}
for argument in sys.argv[1:]:
    name, _, value = argument.partition("=")
    options[name.removeprefix("--")] = value

with open(options["path"], "rb") as handle:
    data = handle.read()

literal = options["literal"].encode("utf-8")
context = 64
offsets = []
start = 0
while True:
    offset = data.find(literal, start)
    if offset < 0:
        break
    offsets.append(offset)
    start = offset + len(literal)

first = offsets[0] if offsets else 0
before = data[max(0, first - context):first]
after_start = first + len(literal)
after = data[after_start:after_start + context]

matches = []
if offsets:
    matches.append({
        "offset": first,
        "before": before.decode("utf-8", "replace"),
        "after": after.decode("utf-8", "replace"),
    })

print(json.dumps({
    "path": options["path"],
    "sha256": hashlib.sha256(data).hexdigest(),
    "file_size": len(data),
    "literal": options["literal"],
    "offset_start": 0,
    "total_matches": len(offsets),
    "matches": matches,
    "truncated": False,
    "matches_truncated": len(offsets) > 1,
    "context_clipped": bool(offsets) and (first < context or after_start + context > len(data)),
    "more_skipped": max(0, len(offsets) - 1),
}))
`,
);

const brandExportBlock = legacyBlock(
  "brand-export",
  "Synthetic SVG PNG export",
  'source = { type = "path", required = true }\noutput = { type = "path", required = true }\nsize = { type = "int", default = 32, min = 8, max = 512 }',
  `import json, os, subprocess, sys

options = {}
for argument in sys.argv[1:]:
    name, _, value = argument.partition("=")
    options[name.removeprefix("--")] = value

size = int(options.get("size", "32"))
output = options["output"]
completed = subprocess.run(
    ["rsvg-convert", "--width", str(size), "--height", str(size),
     "--output", output, options["source"]],
    capture_output=True,
    text=True,
)
if completed.returncode != 0:
    raise SystemExit(completed.stderr or "rsvg-convert failed")

with open(output, "rb") as handle:
    png = handle.read()
if png[:8] != b"\\x89PNG\\r\\n\\x1a\\n":
    raise SystemExit("renderer did not emit a PNG")

marker = os.sep + ".blocks" + os.sep
print(json.dumps({
    "output": ".blocks/" + output.split(marker, 1)[1].replace(os.sep, "/"),
    "width": int.from_bytes(png[16:20], "big"),
    "height": int.from_bytes(png[20:24], "big"),
    "size": size,
    "bytes": len(png),
}))
`,
  "write-workspace",
);

const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0f172a"/>
  <circle cx="32" cy="32" r="20" fill="#f59e0b"/>
</svg>
`;

describe("migration_runtime_json_peek", () => {
  test("migrated_probe_reports_shape_of_controlled_input", async () => {
    const root = await ownedRoot("runes-migration-runtime-jsonpeek");
    const original = Buffer.from(jsonPeekBlock);
    await writeFile(join(root, ".blocks", "json-peek.py"), original);

    await mkdir(join(root, "data"), { recursive: true });
    const sampleText = '{"name":"ada","count":3}';
    await writeFile(join(root, "data", "sample.json"), sampleText);

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["json-peek"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("json-peek");
    expect(loaded.source).toBe(jsonPeekBlock);
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

    // Synthetic source and controlled input are unchanged by migration and execution.
    expect(await readFile(join(root, ".blocks", "json-peek.py"))).toEqual(original);
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
    const original = Buffer.from(literalProbeBlock);
    await writeFile(join(root, ".blocks", "artifact-literal-probe.py"), original);

    await mkdir(join(root, "data"), { recursive: true });
    // 64 bytes of context on each side keep the default 64-byte windows exact.
    const artifactText = `${"A".repeat(70)}NEEDLE${"B".repeat(70)}`;
    await writeFile(join(root, "data", "sample.bin"), artifactText);

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["artifact-literal-probe"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("artifact-literal-probe");
    expect(loaded.source).toBe(literalProbeBlock);
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
    const originalScript = Buffer.from(brandExportBlock);
    const originalSvg = Buffer.from(sampleSvg);
    const svgDirectory = join(root, ".blocks", "fixtures", "brand-export");
    const svgPath = join(svgDirectory, "sample.svg");
    await mkdir(svgDirectory, { recursive: true });
    await writeFile(join(root, ".blocks", "brand-export.py"), originalScript);
    await writeFile(svgPath, originalSvg);

    const report = await migrateBlocks(root, { dryRun: false, authorize: allowTestOnly });
    expect(report).toEqual({ converted: ["brand-export"], existing: [], unsupported: [], dryRun: false });

    const store = new RuneStore(root);
    const loaded = await store.load("brand-export");
    expect(loaded.source).toBe(brandExportBlock);
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

    // The synthetic SVG and block script are preserved byte-for-byte.
    expect(await readFile(join(root, ".blocks", "brand-export.py"))).toEqual(originalScript);
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
