import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest, type RuneManifest } from '../src/contracts.ts';
import { migrateBlocks } from '../src/migrate.ts';
import { runRune } from '../src/runtime.ts';
import { RuneStore } from '../src/store.ts';

const allow = async () => {};
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runes-compat-'));
  await mkdir(join(root, '.blocks'));
  return root;
}
function manifest(filename = 'probe.py', changes: Record<string, unknown> = {}): RuneManifest {
  const language = filename.endsWith('.py') ? 'python' : filename.endsWith('.ts') ? 'typescript' : 'javascript';
  return validateManifest({ version: 1, name: 'probe', description: 'safe fixture', effects: 'fixture only',
    language, entry: language === 'python' ? 'main.py' : language === 'typescript' ? 'main.ts' : 'main.js',
    interface: 'argv', params: {}, legacy: { path: `.blocks/${filename}`, sha256: 'a'.repeat(64), format: 'caveman-blocks' }, ...changes });
}
async function execute(root: string, m: RuneManifest, source: string, params: unknown = {}, authorize = allow) {
  return runRune(root, { manifest: m, source, hash: digest(source) }, params, { authorize });
}
async function override(root: string, filename: string, source: string, m: unknown, hash = digest(source)) {
  await mkdir(join(root, '.opencode'), { recursive: true });
  await writeFile(join(root, '.opencode/runes-migration.json'), JSON.stringify({ version: 1, entries: {
    [`.blocks/${filename}`]: { sha256: hash, manifest: m },
  } }));
}

test('explicit true and false flags and repeated string arguments preserve argv without coercion', async () => {
  const root = await fixture();
  const m = manifest('probe.py', {
    params: { enable: { type: 'boolean', default: false }, disable: { type: 'boolean', default: true }, item: { type: 'string' }, count: { type: 'integer', default: 7 } },
    legacy: { path: '.blocks/probe.py', sha256: 'a'.repeat(64), format: 'caveman-blocks', argv: {
      enable: { mode: 'flag' }, disable: { mode: 'flag', when: false }, item: { mode: 'repeat-json' },
    } },
  });
  const source = 'import json,sys\nprint(json.dumps(sys.argv[1:]))';
  expect((await execute(root, m, source)).value).toEqual(['--count=7']);
  expect((await execute(root, m, source, { enable: true, disable: false, item: '["a=b","--quoted value"]' })).value)
    .toEqual(['--enable', '--disable', '--item=a=b', '--item=--quoted value', '--count=7']);
  let calls = 0;
  for (const item of ['not json', '{}', '[1]', 'null', true]) {
    await expect(execute(root, m, source, { item }, async () => { calls++; })).rejects.toMatchObject({ code: 'invalid_params' });
  }
  expect(calls).toBe(0);
  expect(() => manifest('probe.py', { params: { flag: { type: 'boolean' } } })).toThrow('ambiguous');
});

test('reviewed headerless overrides inject provenance, preserve source bytes and are create-only and idempotent', async () => {
  const root = await fixture();
  const source = 'raise Exception("migration must never execute")\n';
  await writeFile(join(root, '.blocks/probe.py'), source);
  const { legacy: _, ...reviewed } = manifest();
  await override(root, 'probe.py', source, reviewed);
  const reads: string[] = [];
  const first = await migrateBlocks(root, { dryRun: false, authorize: allow, authorizeRead: async p => { reads.push(p); } });
  expect(first).toEqual({ converted: ['probe'], existing: [], unsupported: [], dryRun: false });
  expect(reads).toContain(join(root, '.opencode/runes-migration.json'));
  const stored = await new RuneStore(root).load('probe');
  expect(stored.manifest.legacy).toEqual({ path: '.blocks/probe.py', sha256: digest(source), format: 'caveman-blocks' });
  expect(stored.source).toBe(source);
  expect(await readFile(join(root, '.blocks/probe.py'), 'utf8')).toBe(source);
  expect(await migrateBlocks(root, { dryRun: false, authorize: async () => { throw Error('must not edit'); } }))
    .toEqual({ converted: [], existing: ['probe'], unsupported: [], dryRun: false });
  await override(root, 'probe.py', source, { ...reviewed, description: 'conflicting review' });
  expect((await migrateBlocks(root, { dryRun: false, authorize: allow })).unsupported[0]!.reason).toContain('conflicting');
  expect(await new RuneStore(root).load('probe')).toEqual(stored);
});

test('stale and conflicting overrides fail closed; denied override reads propagate before mutation', async () => {
  const root = await fixture();
  const source = 'print("null")';
  await writeFile(join(root, '.blocks/probe.py'), source);
  await override(root, 'probe.py', source, manifest());
  expect((await migrateBlocks(root, { authorize: allow })).unsupported[0]!.reason).toContain('conflicts with source provenance');
  const { legacy: _, ...reviewed } = manifest();
  await override(root, 'probe.py', source, reviewed, 'b'.repeat(64));
  expect((await migrateBlocks(root, { authorize: allow })).unsupported[0]!.reason).toContain('Stale');
  const denied = new Error('read denied');
  await expect(migrateBlocks(root, { dryRun: false, authorize: allow, authorizeRead: async () => { throw denied; } })).rejects.toBe(denied);
  expect(await readdir(join(root, '.opencode'))).toEqual(['runes-migration.json']);
});

test('reviewed JavaScript and TypeScript overrides migrate without importing source', async () => {
  for (const filename of ['probe.mjs', 'probe.cjs', 'probe.ts']) {
    const root = await fixture();
    const source = 'throw new Error("MIGRATION EXECUTED SOURCE")';
    await writeFile(join(root, '.blocks', filename), source);
    const { legacy: _, ...reviewed } = manifest(filename);
    await override(root, filename, source, reviewed);
    expect(await migrateBlocks(root, { dryRun: false, authorize: allow }))
      .toEqual({ converted: ['probe'], existing: [], unsupported: [], dryRun: false });
    const loaded = await new RuneStore(root).load('probe');
    expect(loaded.source).toBe(source);
    expect(loaded.manifest.language).toBe(filename.endsWith('.ts') ? 'typescript' : 'javascript');
    expect(loaded.manifest.legacy!.path).toBe(`.blocks/${filename}`);
  }
});

test('reviewed overrides cannot change language or bypass edit authorization', async () => {
  const root = await fixture();
  const source = 'print("null")';
  await writeFile(join(root, '.blocks/probe.py'), source);
  const { legacy: _, ...reviewed } = manifest();
  for (const changes of [{ language: 'javascript', entry: 'main.js' }, { interface: 'native' }]) {
    await override(root, 'probe.py', source, { ...reviewed, ...changes });
    expect((await migrateBlocks(root, { dryRun: false, authorize: allow })).unsupported[0]!.reason)
      .toContain('must match source language, entry and argv interface');
  }
  await override(root, 'probe.py', source, reviewed);
  const denied = new Error('edit denied');
  await expect(migrateBlocks(root, { dryRun: false, authorize: async () => { throw denied; } })).rejects.toBe(denied);
  expect(await readdir(join(root, '.opencode'))).toEqual(['runes-migration.json']);
});

test('override schemas and symlink paths cannot smuggle prototype keys or escape the project', async () => {
  const root = await fixture();
  await writeFile(join(root, '.blocks/probe.py'), 'print("null")');
  await mkdir(join(root, '.opencode'));
  const target = join(root, '.opencode/runes-migration.json');
  await writeFile(target, '{"version":1,"entries":{"__proto__":{}}}');
  await expect(migrateBlocks(root, { authorize: allow })).rejects.toMatchObject({ code: 'unsupported' });
  const other = await fixture();
  await mkdir(join(other, '.opencode'));
  await symlink(target, join(other, '.opencode/runes-migration.json'));
  await expect(migrateBlocks(other, { authorize: allow })).rejects.toMatchObject({ code: 'path' });
});

for (const extension of ['mjs', 'js', 'ts', 'cjs']) {
  test(`legacy ${extension} executes approved snapshot at original origin and delegates sibling imports`, async () => {
    const root = await fixture();
    const filename = `probe.${extension}`;
    const original = join(root, '.blocks', filename);
    await writeFile(join(root, '.blocks/sibling.cjs'), 'module.exports = { word: "sibling" };');
    const source = extension === 'cjs'
      ? 'const sibling = require("./sibling.cjs"); process.stdout.write(JSON.stringify({word:sibling.word, file:__filename, argv:process.argv.slice(1)}));'
      : `import sibling from './sibling.cjs'; import {pathToFileURL} from 'node:url';
         ${extension === 'ts' ? 'const word: string = sibling.word;' : 'const word = sibling.word;'}
         if (import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify({word, file:import.meta.url, argv:process.argv.slice(1)}));`;
    await writeFile(original, source);
    const m = manifest(filename, { params: { label: { type: 'string' } } });
    const value = (await execute(root, m, source, { label: 'bound' }, async () => {
      await writeFile(original, 'throw new Error("MUTABLE ORIGINAL EXECUTED")');
    })).value;
    expect(value).toEqual({ word: 'sibling', file: extension === 'cjs' ? original : pathToFileURL(original).href, argv: [original, '--label=bound'] });
  });
}

test('legacy Node worker preserves output bounds and timeout cancellation', async () => {
  const root = await fixture();
  const m = manifest('probe.mjs');
  await expect(execute(root, m, 'process.stdout.write(JSON.stringify("x".repeat(70000)))')).rejects.toMatchObject({ code: 'output_limit' });
  await expect(execute(root, { ...m, timeoutMs: 150 }, 'setInterval(()=>{},1000)')).rejects.toMatchObject({ code: 'timeout' });
  const controller = new AbortController();
  await expect(runRune(root, { manifest: m, source: 'setInterval(()=>{},1000)', hash: 'fixture' }, {}, {
    signal: controller.signal, authorize: async request => { if (request.action === 'runes.run') controller.abort(); },
  })).rejects.toMatchObject({ code: 'cancelled' });
});

test('legacy Node cancellation after readiness kills the owned child', async () => {
  const root = await fixture();
  const ready = join(root, 'ready.json');
  const controller = new AbortController();
  const pending = runRune(root, {
    manifest: manifest('probe.mjs'), hash: 'fixture',
    source: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, JSON.stringify(process.pid)); setInterval(()=>{},1000);`,
  }, {}, { signal: controller.signal, authorize: allow });
  // Observe a real worker readiness event instead of racing a fixed delay.
  const deadline = Date.now() + 5000;
  let pid: number | undefined;
  while (Date.now() < deadline) {
    try { pid = JSON.parse(await readFile(ready, 'utf8')) as number; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(typeof pid).toBe('number');
  expect(() => process.kill(pid!, 0)).toThrow();
});
