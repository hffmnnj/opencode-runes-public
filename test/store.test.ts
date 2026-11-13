// Store tests use isolated fixtures created under the system temporary directory.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuneStore } from "../src/store.ts";

// LIMITS.sourceBytes per CONTRACT.md.
const SOURCE_LIMIT = 262144;
const HEX64 = /^[0-9a-f]{64}$/;

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "runes-store-"));
}

function jsManifest(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    name,
    description: `Test rune ${name}`,
    language: "javascript",
    interface: "native",
    entry: "main.js",
    params: {},
    effects: "read-only",
    ...overrides,
  };
}

const JS_SOURCE = `export default function (params) {\n  return { echo: params, snowman: "☃✓" };\n}\n`;

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code "${code}" but it resolved`);
}

describe("save and load", () => {
  test("save_then_load_roundtrip_preservesManifestAndSource", async () => {
    const store = new RuneStore(await freshRoot());
    const saved = await store.save(jsManifest("roundtrip"), JS_SOURCE);

    expect(saved).toEqual({ name: "roundtrip", created: true, hash: expect.any(String) });
    expect(saved.hash).toMatch(HEX64);

    const loaded = await store.load("roundtrip");
    expect(loaded.source).toBe(JS_SOURCE);
    expect(loaded.hash).toBe(saved.hash);
    expect(loaded.manifest.name).toBe("roundtrip");
    expect(loaded.manifest.description).toBe("Test rune roundtrip");
    expect(loaded.manifest.language).toBe("javascript");
    expect(loaded.manifest.effects).toBe("read-only");
  });

  test("save_allLanguages_loadsEachEntryFile", async () => {
    const store = new RuneStore(await freshRoot());
    const cases = [
      { manifest: jsManifest("js-rune"), source: JS_SOURCE },
      {
        manifest: {
          ...jsManifest("ts-rune"),
          language: "typescript",
          entry: "main.ts",
        },
        source: `export default function (params: Record<string, unknown>): unknown {\n  return params;\n}\n`,
      },
      {
        manifest: {
          ...jsManifest("py-rune"),
          language: "python",
          entry: "main.py",
        },
        source: `import json, sys\nprint(json.dumps(json.load(sys.stdin)))\n`,
      },
    ];
    for (const { manifest, source } of cases) {
      const saved = await store.save(manifest, source as string);
      expect(saved.created).toBe(true);
      const loaded = await store.load(manifest["name"] as string);
      expect(loaded.source).toBe(source);
      expect(loaded.hash).toBe(saved.hash);
    }
  });

  test("save_identicalBytesAndManifest_returnsNotCreated", async () => {
    const store = new RuneStore(await freshRoot());
    const first = await store.save(jsManifest("idem"), JS_SOURCE);
    const second = await store.save(jsManifest("idem"), JS_SOURCE);

    expect(first.created).toBe(true);
    expect(second).toEqual({ name: "idem", created: false, hash: first.hash });
  });

  test("save_sameNameDifferentSource_throwsExistsAndPreservesOriginal", async () => {
    const store = new RuneStore(await freshRoot());
    await store.save(jsManifest("conflict"), JS_SOURCE);

    await expectCode(
      store.save(jsManifest("conflict"), "export default () => 2;\n"),
      "exists",
    );

    const loaded = await store.load("conflict");
    expect(loaded.source).toBe(JS_SOURCE);
  });

  test("save_sameNameDifferentManifest_throwsExistsAndPreservesOriginal", async () => {
    const store = new RuneStore(await freshRoot());
    await store.save(jsManifest("clash"), JS_SOURCE);

    await expectCode(
      store.save(
        jsManifest("clash", { description: "A different description" }),
        JS_SOURCE,
      ),
      "exists",
    );

    const loaded = await store.load("clash");
    expect(loaded.manifest.description).toBe("Test rune clash");
  });

  test("save_rejectsOversizeSource", async () => {
    const store = new RuneStore(await freshRoot());
    await expectCode(
      store.save(jsManifest("big"), `// ${"x".repeat(SOURCE_LIMIT + 1)}`),
      "too-large",
    );
  });

  test("save_rejectsUnpairedSurrogates", async () => {
    const store = new RuneStore(await freshRoot());
    await expectCode(
      store.save(jsManifest("lone"), "export default () => \"\uD800\";\n"),
      "invalid-source",
    );
  });
});

describe("concurrent saves", () => {
  test("save_concurrentIdentical_exactlyOneCreated", async () => {
    const store = new RuneStore(await freshRoot());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.save(jsManifest("race-same"), JS_SOURCE),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const firstHash = results[0]?.hash;
    if (firstHash === undefined) throw new Error("expected a save result");
    expect(firstHash).toMatch(HEX64);
    for (const result of results) {
      expect(result.hash).toBe(firstHash);
    }
    const loaded = await store.load("race-same");
    expect(loaded.source).toBe(JS_SOURCE);
  });

  test("save_concurrentDifferent_oneWinnerWithoutTornWrite", async () => {
    const store = new RuneStore(await freshRoot());
    const sources = Array.from(
      { length: 8 },
      (_, i) => `export default () => ${i};\n`,
    );
    const settled = await Promise.allSettled(
      sources.map((source) => store.save(jsManifest("race-diff"), source)),
    );

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const outcome of rejected) {
      expect(
        (outcome as PromiseRejectedResult).reason as { code?: unknown },
      ).toMatchObject({ code: "exists" });
    }

    const loaded = await store.load("race-diff");
    expect(sources).toContain(loaded.source);
  });
});

describe("load failures", () => {
  test("load_missing_throwsNotFound", async () => {
    const store = new RuneStore(await freshRoot());
    await expectCode(store.load("no-such-rune"), "not-found");
  });

  test("load_invalidName_throws", async () => {
    const store = new RuneStore(await freshRoot());
    await expect(store.load("../escape")).rejects.toThrow();
  });
});

describe("list", () => {
  test("list_emptyRoot_returnsEmpty", async () => {
    const store = new RuneStore(await freshRoot());
    await expect(store.list()).resolves.toEqual({ runes: [], invalid: 0 });
  });

  test("list_paginatesFiltersAndCountsInvalid", async () => {
    const root = await freshRoot();
    const store = new RuneStore(root);
    // Saved out of order to prove sorted output.
    for (const name of ["delta-rune", "alpha-rune", "echo-rune", "bravo-rune"]) {
      await store.save(jsManifest(name), JS_SOURCE);
    }
    await store.save(
      jsManifest("charlie-rune", { description: "carries the zebra-token" }),
      JS_SOURCE,
    );
    // Fixture setup (not store writes): one corrupt manifest dir and one
    // stray file that cannot be a rune name.
    await mkdir(`${root}/.opencode/.runes/zzz-broken`, { recursive: true });
    await writeFile(
      `${root}/.opencode/.runes/zzz-broken/rune.json`,
      "{ not json",
      "utf8",
    );
    await writeFile(`${root}/.opencode/.runes/STRAY-FILE`, "x", "utf8");

    const all = await store.list();
    expect(all.runes.map((r) => r.name)).toEqual([
      "alpha-rune",
      "bravo-rune",
      "charlie-rune",
      "delta-rune",
      "echo-rune",
    ]);
    expect(all.invalid).toBe(2);
    expect(all.nextOffset).toBeUndefined();
    expect(all.runes[0]).toEqual({
      name: "alpha-rune",
      description: "Test rune alpha-rune",
      language: "javascript",
      effects: "read-only",
    });

    const first = await store.list({ limit: 2 });
    expect(first.runes.map((r) => r.name)).toEqual([
      "alpha-rune",
      "bravo-rune",
    ]);
    expect(first.nextOffset).toBe(2);
    expect(first.invalid).toBe(2);

    const second = await store.list({ offset: 2, limit: 2 });
    expect(second.runes.map((r) => r.name)).toEqual([
      "charlie-rune",
      "delta-rune",
    ]);
    expect(second.nextOffset).toBe(4);

    const tail = await store.list({ offset: 4, limit: 2 });
    expect(tail.runes.map((r) => r.name)).toEqual(["echo-rune"]);
    expect(tail.nextOffset).toBeUndefined();

    const pastEnd = await store.list({ offset: 9 });
    expect(pastEnd.runes).toEqual([]);

    await expect(store.list({ offset: -1 })).rejects.toThrow();
    await expect(store.list({ limit: 0 })).rejects.toThrow();

    const byName = await store.list({ query: "BRAVO" });
    expect(byName.runes.map((r) => r.name)).toEqual(["bravo-rune"]);

    const byDescription = await store.list({ query: "zebra-token" });
    expect(byDescription.runes.map((r) => r.name)).toEqual(["charlie-rune"]);

    const none = await store.list({ query: "nothing-matches-this" });
    expect(none.runes).toEqual([]);
    expect(none.nextOffset).toBeUndefined();
  });

  test("list_readsManifestOnly_skipsSourceBodies", async () => {
    const root = await freshRoot();
    const store = new RuneStore(root);
    await mkdir(`${root}/.opencode/.runes/big-body`, { recursive: true });
    await writeFile(
      `${root}/.opencode/.runes/big-body/rune.json`,
      `${JSON.stringify(jsManifest("big-body"))}\n`,
      "utf8",
    );
    await writeFile(
      `${root}/.opencode/.runes/big-body/main.js`,
      "x".repeat(SOURCE_LIMIT + 1),
      "utf8",
    );

    const listed = await store.list();
    expect(listed.runes.map((r) => r.name)).toEqual(["big-body"]);
    expect(listed.invalid).toBe(0);
    await expectCode(store.load("big-body"), "limit");
  });

  test("list_missingEntry_countsInvalid", async () => {
    const root = await freshRoot();
    const store = new RuneStore(root);
    await store.save(jsManifest("good-rune"), JS_SOURCE);
    await mkdir(`${root}/.opencode/.runes/no-entry`, { recursive: true });
    await writeFile(
      `${root}/.opencode/.runes/no-entry/rune.json`,
      `${JSON.stringify(jsManifest("no-entry"))}\n`,
      "utf8",
    );

    const listed = await store.list();
    expect(listed.runes.map((r) => r.name)).toEqual(["good-rune"]);
    expect(listed.invalid).toBe(1);
  });

  test("list_overCatalogLimit_throwsLimit", async () => {
    const root = await freshRoot();
    const store = new RuneStore(root);
    await mkdir(`${root}/.opencode/.runes`, { recursive: true });
    for (let index = 0; index < 1001; index += 1) {
      await mkdir(
        `${root}/.opencode/.runes/limit-probe-${String(index).padStart(4, "0")}`,
      );
    }
    await expectCode(store.list(), "limit");
  });
});
