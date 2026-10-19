import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { LIMITS, RuneError, entryFor, validateManifest, type Language, type RuneManifest } from './contracts.ts';
import { readBounded, safePath } from './paths.ts';
import { RuneStore } from './store.ts';

type Authorization = (request: {
  action: string;
  resources: string[];
  metadata?: Record<string, unknown>;
}) => Promise<void>;

type MigrationResult = {
  converted: string[];
  existing: string[];
  unsupported: { path: string; reason: string }[];
  dryRun: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function refuse(reason: string): never {
  throw new RuneError('unsupported', reason);
}

function parseManifest(source: string, path: string): RuneManifest {
  const lines = source.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.startsWith('#!')) start++;
  while (lines[start]?.trim() === '') start++;
  if (lines[start] !== '# /// block') refuse('Missing supported TOML block header');
  const header: string[] = [];
  let closed = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '# ///') { closed = true; break; }
    if (!line.startsWith('#')) refuse('Malformed TOML comment header');
    header.push(line.replace(/^# ?/, ''));
    if (Buffer.byteLength(header.join('\n')) > LIMITS.manifestBytes) refuse('TOML header exceeds size limit');
  }
  if (!closed) refuse('Unterminated TOML block header');
  let data: unknown;
  try {
    // Bun parses data only; legacy source is never evaluated during conversion.
    data = Bun.TOML.parse(header.join('\n'));
  } catch {
    refuse('Invalid TOML block header');
  }
  if (!record(data)) refuse('Unsupported TOML header schema');
  const allowed = new Set(['name', 'summary', 'effects', 'example', 'matches', 'params', 'returns', 'provenance', 'stamp', 'allow_effects']);
  if (Object.keys(data).some(key => !allowed.has(key))) refuse('Unsupported TOML header field');
  if (!record(data.params)) refuse('Missing parameter table');
  const types = { str: 'string', int: 'integer', float: 'number', bool: 'boolean', path: 'path' } as const;
  const params: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(data.params)) {
    if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(types, value.type)) {
      refuse('Unsupported parameter schema or scalar type');
    }
    if (value.type === 'bool') refuse('Boolean argv encoding is ambiguous; manual conversion required');
    const fields = new Set(['type', 'min', 'max', 'default', 'required', 'help', 'enum']);
    if (Object.keys(value).some(key => !fields.has(key))) refuse('Unsupported parameter field');
    const param: Record<string, unknown> = { type: types[value.type as keyof typeof types] };
    for (const key of ['min', 'max', 'default', 'required', 'enum'] as const) {
      if (Object.hasOwn(value, key)) param[key] = value[key];
    }
    if (Object.hasOwn(value, 'help')) param.description = value.help;
    params[name] = param;
  }
  if (data.example !== undefined && (!Array.isArray(data.example) || data.example.some(x => typeof x !== 'string'))) {
    refuse('Unsupported example: expected argv string array');
  }
  // Historical stamps and allow_effects are not migrated as verification or authority.
  const { stamp: _stamp, allow_effects: _authority, ...metadata } = data;
  let manifest: RuneManifest;
  try {
    manifest = validateManifest({
      version: 1, name: data.name, description: data.summary, language: 'python',
      interface: 'argv', entry: 'main.py', params, effects: data.effects,
      legacy: {
        path, sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
        format: 'caveman-blocks', ...(data.example === undefined ? {} : { example: data.example }), metadata,
      },
    });
  } catch {
    refuse('Header cannot be represented by a valid Rune manifest');
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > LIMITS.manifestBytes) refuse('Converted manifest exceeds size limit');
  return manifest;
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

type ReviewedAdapter = { source: string; sha256: string };
type ReviewedOverride = { sha256: string; manifest: Record<string, unknown>; adapter?: ReviewedAdapter };
const OVERRIDES_PATH = '.opencode/runes-migration.json';

async function readOverrides(root: string, authorizeRead?: (resource: string) => Promise<void>): Promise<Map<string, ReviewedOverride>> {
  try { await lstat(await safePath(root, OVERRIDES_PATH)); }
  catch (error) { if (missing(error)) return new Map(); throw error; }
  await authorizeRead?.(join(root, OVERRIDES_PATH));
  let data: unknown;
  try { data = JSON.parse(await readBounded(root, OVERRIDES_PATH, LIMITS.sourceBytes)); }
  catch (error) { if (error instanceof SyntaxError) refuse('Invalid migration override JSON'); throw error; }
  if (!record(data) || data.version !== 1 || Object.keys(data).some(k => k !== 'version' && k !== 'entries') || !record(data.entries)) {
    refuse('Invalid migration override schema');
  }
  if (Object.keys(data.entries).length > LIMITS.catalogEntries) refuse('Too many migration overrides');
  const entries = new Map<string, ReviewedOverride>();
  for (const [key, value] of Object.entries(data.entries)) {
    if (!/^\.blocks\/[^/\\\0]+\.(?:py|js|ts|mjs|cjs)$/.test(key) || !record(value)
      || Object.keys(value).some(k => k !== 'sha256' && k !== 'manifest' && k !== 'adapter')
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !record(value.manifest)) {
      refuse('Invalid migration override entry');
    }
    let adapter: ReviewedAdapter | undefined;
    if (Object.hasOwn(value, 'adapter')) {
      const supplied = value.adapter;
      if (!record(supplied) || Object.keys(supplied).some(k => k !== 'source' && k !== 'sha256')
        || typeof supplied.source !== 'string' || typeof supplied.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(supplied.sha256)) refuse('Invalid migration adapter schema');
      if (Buffer.byteLength(supplied.source, 'utf8') > LIMITS.sourceBytes) refuse('Migration adapter exceeds source size limit');
      if (createHash('sha256').update(supplied.source, 'utf8').digest('hex') !== supplied.sha256) {
        refuse('Stale migration adapter: source hash differs');
      }
      adapter = { source: supplied.source, sha256: supplied.sha256 };
    }
    entries.set(key, { sha256: value.sha256, manifest: value.manifest, ...(adapter === undefined ? {} : { adapter }) });
  }
  return entries;
}

function reviewedManifest(override: ReviewedOverride, source: string, path: string): RuneManifest {
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (override.sha256 !== sha256) refuse('Stale migration override: source hash differs');
  const language: Language = path.endsWith('.py') ? 'python' : path.endsWith('.ts') ? 'typescript' : 'javascript';
  const supplied = override.manifest;
  const requiredInterface = override.adapter === undefined ? 'argv' : 'native';
  if (supplied.language !== language || supplied.entry !== entryFor(language) || supplied.interface !== requiredInterface) {
    refuse(`Migration override must match source language, entry and ${requiredInterface} interface`);
  }
  const legacy = supplied.legacy;
  if (legacy !== undefined && (!record(legacy) || (legacy.path !== undefined && legacy.path !== path)
    || (legacy.sha256 !== undefined && legacy.sha256 !== sha256)
    || (legacy.format !== undefined && legacy.format !== 'caveman-blocks'))) {
    refuse('Migration override conflicts with source provenance');
  }
  const manifest = validateManifest({ ...supplied, legacy: { ...(legacy as Record<string, unknown> | undefined), path, sha256, format: 'caveman-blocks' } });
  if (Buffer.byteLength(JSON.stringify(manifest)) > LIMITS.manifestBytes) refuse('Converted manifest exceeds size limit');
  return manifest;
}

export async function migrateBlocks(root: string, options: {
  dryRun?: boolean;
  authorize: Authorization;
  authorizeRead?: (resource: string) => Promise<void>;
}): Promise<MigrationResult> {
  const result: MigrationResult = { converted: [], existing: [], unsupported: [], dryRun: options.dryRun ?? true };
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(await safePath(root, '.blocks', { directory: true, missing: true }));
  } catch (error) {
    if (missing(error)) return result;
    throw error;
  }
  const candidates: string[] = [];
  let entries = 0;
  for await (const entry of directory) {
    if (++entries > LIMITS.catalogEntries) throw new RuneError('limit', 'Blocks directory exceeds catalog limit');
    // Data, fixtures, indexes, lockfiles and cache directories are never candidates.
    if (/\.(?:py|js|ts|mjs|cjs|sh|bash|rb|pl|ps1)$/.test(entry.name) && !entry.isDirectory()) candidates.push(entry.name);
  }
  candidates.sort();
  const overrides = await readOverrides(root, options.authorizeRead);
  const store = new RuneStore(root, options.authorizeRead);
  const planned = new Set<string>();
  function unsupported(path: string, reason: string) {
    result.unsupported.push({ path, reason });
    checkResult();
  }
  function checkResult() {
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) throw new RuneError('limit', 'Migration report exceeds output limit');
  }
  for (const filename of candidates) {
    const path = `.blocks/${filename}`;
    if (!filename.endsWith('.py') && !overrides.has(path)) {
      unsupported(path, 'Unsupported language without a reviewed migration override');
      continue;
    }
    let source: string;
    let runeSource: string;
    let manifest: RuneManifest;
    const override = overrides.get(path);
    await options.authorizeRead?.(join(root, path));
    try {
      source = await readBounded(root, path, LIMITS.sourceBytes);
      const info = await lstat(await safePath(root, path));
      if (info.size !== Buffer.byteLength(source, 'utf8')) refuse('Source decoding is not byte-preserving');
      manifest = override ? reviewedManifest(override, source, path) : parseManifest(source, path);
      runeSource = override?.adapter?.source ?? source;
    } catch (error) {
      if (!(error instanceof RuneError)) throw error;
      unsupported(path, 'Source or header is unsupported: ' + (error.code === 'unsupported' ? error.message : error.code));
      continue;
    }
    if (planned.has(manifest.name)) {
      unsupported(path, 'Multiple Blocks declare the same Rune name; never overwritten');
      continue;
    }
    let exists = false;
    try {
      const destination = await safePath(root, `.opencode/.runes/${manifest.name}`, { directory: true, missing: true });
      await lstat(destination);
      exists = true;
    } catch (error) {
      if (!missing(error)) {
        if (!(error instanceof RuneError)) throw error;
        unsupported(path, 'Destination is unsafe or inaccessible');
        continue;
      }
    }
    if (exists) {
      try {
        const current = await store.load(manifest.name);
        if (current.manifest.legacy?.path === path && current.manifest.legacy.sha256 === manifest.legacy!.sha256
          && current.source === runeSource && isDeepStrictEqual(current.manifest, manifest)) {
          result.existing.push(manifest.name);
          checkResult();
        } else unsupported(path, 'Rune name already exists with conflicting content or provenance');
      } catch (error) {
        if (!(error instanceof RuneError)) throw error;
        unsupported(path, 'Rune name already exists but cannot be safely loaded');
      }
      continue;
    }
    if (!result.dryRun) {
      // Permission failures propagate unchanged and cannot be mistaken for unsupported data.
      await options.authorize({
        action: 'edit', resources: [
          join(root, '.opencode', '.runes', manifest.name, 'rune.json'),
          join(root, '.opencode', '.runes', manifest.name, manifest.entry),
        ],
        metadata: { root, source: path, sha256: manifest.legacy!.sha256, effects: manifest.effects,
          ...(override?.adapter === undefined ? {} : { adapterSha256: override.adapter.sha256 }) },
      });
      try {
        const saved = await store.save(manifest, runeSource);
        if (!saved.created) { result.existing.push(manifest.name); checkResult(); continue; }
      } catch (error) {
        if (!(error instanceof RuneError) || error.code !== 'exists') throw error;
        unsupported(path, 'Rune name was concurrently created; never overwritten');
        continue;
      }
    }
    result.converted.push(manifest.name);
    planned.add(manifest.name);
    checkResult();
  }
  return result;
}
