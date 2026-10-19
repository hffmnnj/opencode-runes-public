// RuneStore: create-only, project-local rune storage. Manifest is written
// LAST so its presence marks a complete rune; partial directories are
// retained, never deleted. Exclusive creation prevents concurrent overwrites.

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, opendir } from "node:fs/promises";
import {
  LIMITS,
  RuneError,
  validateManifest,
  validateName,
  type Language,
  type RuneManifest,
} from "./contracts.ts";
import { ensureDirectory, readBounded, safePath } from "./paths.ts";

export type LoadedRune = {
  manifest: RuneManifest;
  source: string;
  hash: string;
};

export type RuneSummary = {
  name: string;
  description: string;
  language: Language;
  effects: string;
};

export type SaveResult = { name: string; created: boolean; hash: string };

export type ListOptions = { query?: string; offset?: number; limit?: number };

export type ListResult = {
  runes: RuneSummary[];
  nextOffset?: number;
  invalid: number;
};

const RUNES_BASE = ".opencode/.runes";
const MANIFEST_FILE = "rune.json";

// Concurrent-create loser waits briefly for the winner's manifest so an
// identical simultaneous save reports idempotence instead of a conflict.
const COMPARE_ATTEMPTS = 25;
const COMPARE_DELAY_MS = 5;

// Lone surrogates encode to U+FFFD and would corrupt byte-exact sources.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

// Deterministic key ordering so identical manifests hash identically.
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function hashRune(manifest: RuneManifest, source: string): string {
  return createHash("sha256")
    .update(`${canonicalJson(manifest)}\n${source}`, "utf8")
    .digest("hex");
}

function validateSource(source: string): void {
  if (typeof source !== "string") {
    throw new RuneError("invalid-source", "rune source must be a string");
  }
  if (LONE_SURROGATE_RE.test(source)) {
    throw new RuneError(
      "invalid-source",
      "rune source contains unpaired surrogates",
    );
  }
  if (byteLength(source) > LIMITS.sourceBytes) {
    throw new RuneError(
      "too-large",
      `rune source exceeds ${LIMITS.sourceBytes} bytes`,
    );
  }
}

async function writeExclusive(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW |
    constants.O_WRONLY;
  let handle;
  try {
    handle = await open(path, flags, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST" || code === "ELOOP") {
      throw new RuneError(
        "exists",
        `refusing to overwrite existing file at ${path}`,
      );
    }
    throw err;
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

export class RuneStore {
  constructor(readonly root: string, private readonly authorizeRead?: (resource: string) => Promise<void>) {}

  async save(manifest: unknown, source: string): Promise<SaveResult> {
    const valid = validateManifest(manifest);
    validateSource(source);
    const canonical = canonicalJson(valid);
    if (byteLength(canonical) > LIMITS.manifestBytes) {
      throw new RuneError(
        "too-large",
        `rune manifest exceeds ${LIMITS.manifestBytes} bytes`,
      );
    }
    const hash = hashRune(valid, source);
    const name = valid.name;
    const dirRel = `${RUNES_BASE}/${name}`;

    await ensureDirectory(this.root, RUNES_BASE);
    const dirPath = await safePath(this.root, dirRel, {
      directory: true,
      missing: true,
    });
    let createdDir = false;
    try {
      // Exclusive mkdir is the atomic claim: exactly one concurrent save wins.
      await mkdir(dirPath, { recursive: false, mode: 0o755 });
      createdDir = true;
    } catch (err) {
      if (!isErrno(err) || err.code !== "EEXIST") throw err;
    }

    if (!createdDir) {
      const existing = await this.readExistingForCompare(name);
      if (existing !== null && existing.hash === hash) {
        return { name, created: false, hash };
      }
      throw new RuneError("exists", `rune "${name}" already exists`);
    }

    try {
      // Entry first, manifest LAST: manifest presence marks completion.
      const entryPath = await safePath(this.root, `${dirRel}/${valid.entry}`, {
        missing: true,
      });
      await writeExclusive(entryPath, source, 0o644);
      const manifestPath = await safePath(
        this.root,
        `${dirRel}/${MANIFEST_FILE}`,
        { missing: true },
      );
      await writeExclusive(manifestPath, `${canonical}\n`, 0o644);
    } catch (err) {
      // Retain the partially written owned directory; report, never delete.
      if (err instanceof RuneError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new RuneError(
        "write-failed",
        `save of rune "${name}" failed; partial directory retained at ${dirRel}: ${detail}`,
      );
    }
    return { name, created: true, hash };
  }

  async load(name: string): Promise<LoadedRune> {
    const clean = validateName(name);
    const dirRel = `${RUNES_BASE}/${clean}`;
    let manifestText: string;
    await this.authorizeRead?.(`${this.root}/${dirRel}/${MANIFEST_FILE}`);
    try {
      manifestText = await readBounded(
        this.root,
        `${dirRel}/${MANIFEST_FILE}`,
        LIMITS.manifestBytes,
      );
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") {
        throw new RuneError("not-found", `rune "${clean}" does not exist`);
      }
      throw err;
    }
    let manifest: RuneManifest;
    try {
      manifest = validateManifest(JSON.parse(manifestText) as unknown);
    } catch (err) {
      if (err instanceof RuneError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new RuneError(
        "invalid-manifest",
        `rune "${clean}" has a malformed manifest: ${detail}`,
      );
    }
    if (manifest.name !== clean) {
      throw new RuneError(
        "invalid-manifest",
        `rune manifest name "${manifest.name}" does not match "${clean}"`,
      );
    }
    let source: string;
    await this.authorizeRead?.(`${this.root}/${dirRel}/${manifest.entry}`);
    try {
      source = await readBounded(
        this.root,
        `${dirRel}/${manifest.entry}`,
        LIMITS.sourceBytes,
      );
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") {
        // Manifest present but entry absent: interrupted publication.
        throw new RuneError(
          "corrupt",
          `rune "${clean}" is missing its entry file ${manifest.entry}`,
        );
      }
      throw err;
    }
    return { manifest, source, hash: hashRune(manifest, source) };
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const { query, offset = 0, limit = LIMITS.listLimit } = options;
    if (typeof query !== "undefined" && typeof query !== "string") {
      throw new RuneError("invalid-argument", "list query must be a string");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RuneError(
        "invalid-argument",
        "list offset must be a non-negative integer",
      );
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RuneError(
        "invalid-argument",
        "list limit must be a positive integer",
      );
    }
    const capped = Math.min(limit, LIMITS.listLimit);
    const base = await safePath(this.root, RUNES_BASE, {
      directory: true,
      missing: true,
    });
    let names: string[];
    try {
      const dir = await opendir(base);
      try {
        names = [];
        let entry;
        while ((entry = await dir.read()) !== null) {
          names.push(entry.name);
          if (names.length > LIMITS.catalogEntries) {
            throw new RuneError(
              "limit",
              `rune catalog exceeds ${LIMITS.catalogEntries} entries`,
            );
          }
        }
      } finally {
        await dir.close();
      }
    } catch (err) {
      if (err instanceof RuneError && err.code === "limit") throw err;
      if (isErrno(err) && err.code === "ENOENT") {
        return { runes: [], invalid: 0 };
      }
      throw err;
    }
    names.sort();
    const needle = query?.toLowerCase();
    const matched: RuneSummary[] = [];
    let invalid = 0;
    for (const entryName of names) {
      try { validateName(entryName); }
      catch { invalid += 1; continue; }
      // Keep permission failures outside the invalid-file recovery boundary.
      await this.authorizeRead?.(`${this.root}/${RUNES_BASE}/${entryName}/${MANIFEST_FILE}`);
      let summary: RuneSummary;
      try {
        summary = await this.readSummary(entryName);
      } catch {
        invalid += 1;
        continue;
      }
      if (
        needle !== undefined &&
        needle !== "" &&
        !summary.name.toLowerCase().includes(needle) &&
        !summary.description.toLowerCase().includes(needle)
      ) {
        continue;
      }
      matched.push(summary);
    }
    const page = matched.slice(offset, offset + capped);
    const nextOffset =
      offset + capped < matched.length ? offset + capped : undefined;
    return nextOffset === undefined
      ? { runes: page, invalid }
      : { runes: page, nextOffset, invalid };
  }

  // Discovery reads manifests only; source bodies stay on disk until load.
  private async readSummary(entryName: string): Promise<RuneSummary> {
    const clean = validateName(entryName);
    const dirRel = `${RUNES_BASE}/${clean}`;
    const manifestText = await readBounded(
      this.root,
      `${dirRel}/${MANIFEST_FILE}`,
      LIMITS.manifestBytes,
    );
    let manifest: RuneManifest;
    try {
      manifest = validateManifest(JSON.parse(manifestText) as unknown);
    } catch (err) {
      if (err instanceof RuneError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new RuneError(
        "invalid-manifest",
        `rune "${clean}" has a malformed manifest: ${detail}`,
      );
    }
    if (manifest.name !== clean) {
      throw new RuneError(
        "invalid-manifest",
        `rune manifest name "${manifest.name}" does not match "${clean}"`,
      );
    }
    try {
      await safePath(this.root, `${dirRel}/${manifest.entry}`);
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") {
        throw new RuneError(
          "corrupt",
          `rune "${clean}" is missing its entry file ${manifest.entry}`,
        );
      }
      throw err;
    }
    return {
      name: manifest.name,
      description: manifest.description,
      language: manifest.language,
      effects: manifest.effects,
    };
  }

  // Reads the current occupant of dirRel for create-only comparison. A
  // concurrent winner may still be publishing, so transient load failures
  // are retried briefly; a persistent failure yields null (conflict).
  private async readExistingForCompare(
    name: string,
  ): Promise<LoadedRune | null> {
    for (let attempt = 0; attempt < COMPARE_ATTEMPTS; attempt += 1) {
      try {
        return await this.load(name);
      } catch (err) {
        if (!(err instanceof RuneError)) throw err;
        await delay(COMPARE_DELAY_MS);
      }
    }
    return null;
  }
}
