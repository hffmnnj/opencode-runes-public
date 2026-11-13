import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '../src/contracts.ts';
import { migrateBlocks } from '../src/migrate.ts';
import { RuneStore } from '../src/store.ts';

const allow = async () => {};
const digest = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');
const original = 'throw new Error("ORIGINAL EXECUTED DURING MIGRATION");\n';
const adapted = 'throw new Error("ADAPTER EXECUTED DURING MIGRATION: café");\n';
const reviewed = {
  version: 1, name: 'bounded-server', description: 'Reviewed bounded lifecycle fixture',
  language: 'javascript', entry: 'main.js', interface: 'native', params: {}, effects: 'fixture only',
} as const;
function entry(changes: Record<string, unknown> = {}) {
  return { sha256: digest(original), manifest: reviewed, adapter: { source: adapted, sha256: digest(adapted) }, ...changes };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runes-adapter-'));
  await mkdir(join(root, '.blocks'));
  await mkdir(join(root, '.opencode'));
  await writeFile(join(root, '.blocks/serve-static.mjs'), original);
  return root;
}
async function override(root: string, value: unknown) {
  await writeFile(join(root, '.opencode/runes-migration.json'), JSON.stringify({
    version: 1, entries: { '.blocks/serve-static.mjs': value },
  }));
}
async function expectUnwritten(root: string) {
  expect(await readdir(join(root, '.opencode'))).toEqual(['runes-migration.json']);
  expect(await readFile(join(root, '.blocks/serve-static.mjs'), 'utf8')).toBe(original);
}

test('reviewed native adapter saves exact UTF-8 source without executing either source and repeats without editing', async () => {
  const root = await fixture();
  await override(root, entry({ manifest: { ...reviewed, legacy: {
    path: '.blocks/serve-static.mjs', sha256: digest(original), format: 'caveman-blocks',
  } } }));
  const edits: unknown[] = [];
  const reads: string[] = [];
  expect(await migrateBlocks(root, {
    dryRun: false, authorize: async request => { edits.push(request); },
    authorizeRead: async resource => { reads.push(resource); },
  })).toEqual({ converted: ['bounded-server'], existing: [], unsupported: [], dryRun: false });
  expect(reads).toContain(join(root, '.opencode/runes-migration.json'));
  expect(reads).toContain(join(root, '.blocks/serve-static.mjs'));
  expect(edits).toEqual([{
    action: 'edit', resources: [
      join(root, '.opencode/.runes/bounded-server/rune.json'),
      join(root, '.opencode/.runes/bounded-server/main.js'),
    ],
    metadata: { root, source: '.blocks/serve-static.mjs', sha256: digest(original), adapterSha256: digest(adapted), effects: 'fixture only' },
  }]);
  const stored = await new RuneStore(root).load('bounded-server');
  expect(stored.source).toBe(adapted);
  const savedBytes = await readFile(join(root, '.opencode/.runes/bounded-server/main.js'));
  expect(createHash('sha256').update(savedBytes).digest('hex')).toBe(digest(adapted));
  expect(stored.manifest).toEqual({ ...reviewed, legacy: {
    path: '.blocks/serve-static.mjs', sha256: digest(original), format: 'caveman-blocks',
  } });
  expect(await readFile(join(root, '.blocks/serve-static.mjs'), 'utf8')).toBe(original);
  expect(await migrateBlocks(root, { dryRun: false, authorize: async () => { throw Error('unexpected edit'); } }))
    .toEqual({ converted: [], existing: ['bounded-server'], unsupported: [], dryRun: false });
});

test('adapter dry run validates and reports conversion without writing or requesting edit', async () => {
  const root = await fixture();
  await override(root, entry());
  expect(await migrateBlocks(root, { authorize: async () => { throw Error('unexpected edit'); } }))
    .toEqual({ converted: ['bounded-server'], existing: [], unsupported: [], dryRun: true });
  await expectUnwritten(root);
});

test('adapter cannot bypass a stale original hash or conflicting supplied provenance', async () => {
  for (const [changes, reason] of [
    [{ sha256: 'b'.repeat(64) }, 'Stale migration override'],
    [{ manifest: { ...reviewed, legacy: { path: '.blocks/other.mjs' } } }, 'conflicts with source provenance'],
    [{ manifest: { ...reviewed, legacy: { sha256: digest(adapted) } } }, 'conflicts with source provenance'],
  ] as const) {
    const root = await fixture();
    await override(root, entry(changes));
    const result = await migrateBlocks(root, { dryRun: false, authorize: async () => { throw Error('unexpected edit'); } });
    expect(result.converted).toEqual([]);
    expect(result.existing).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]!.reason).toContain(reason);
    await expectUnwritten(root);
  }
});

test('adapter hash binds exact bytes rather than accepting changed or normalized source', async () => {
  const root = await fixture();
  await override(root, entry({ adapter: { source: adapted.replace('café', 'cafe\u0301'), sha256: digest(adapted) } }));
  await expect(migrateBlocks(root, { dryRun: false, authorize: allow }))
    .rejects.toMatchObject({ code: 'unsupported', message: 'Stale migration adapter: source hash differs' });
  await expectUnwritten(root);
});

test('adapter requires native interface and original language and entry', async () => {
  for (const changes of [
    { interface: 'argv' }, { language: 'python', entry: 'main.py' }, { entry: 'main.ts' },
  ]) {
    const root = await fixture();
    await override(root, entry({ manifest: { ...reviewed, ...changes } }));
    const result = await migrateBlocks(root, { dryRun: false, authorize: allow });
    expect(result).toEqual({ converted: [], existing: [], dryRun: false, unsupported: [{
      path: '.blocks/serve-static.mjs', reason: 'Source or header is unsupported: Migration override must match source language, entry and native interface',
    }] });
    await expectUnwritten(root);
  }
});

test('strict adapter schema rejects missing, non-string, extra and prototype fields', async () => {
  const invalid: unknown[] = [null, [], {}, { source: adapted }, { sha256: digest(adapted) },
    { source: 1, sha256: digest(adapted) }, { source: adapted, sha256: 1 },
    { source: adapted, sha256: 'not-a-hash' }, { source: adapted, sha256: digest(adapted), timeout: 10 },
    JSON.parse(`{"source":${JSON.stringify(adapted)},"sha256":"${digest(adapted)}","__proto__":{}}`),
  ];
  for (const adapter of invalid) {
    const root = await fixture();
    await override(root, entry({ adapter }));
    await expect(migrateBlocks(root, { dryRun: false, authorize: allow }))
      .rejects.toMatchObject({ code: 'unsupported', message: 'Invalid migration adapter schema' });
    await expectUnwritten(root);
  }
});

test('adapter overrides retain the bounded override-file limit', async () => {
  const root = await fixture();
  const source = 'x'.repeat(LIMITS.sourceBytes + 1);
  await override(root, entry({ adapter: { source, sha256: digest(source) } }));
  await expect(migrateBlocks(root, { dryRun: false, authorize: allow })).rejects.toMatchObject({ code: 'limit' });
  await expectUnwritten(root);
});

test('adapter manifest still rejects invalid and non-finite data', async () => {
  for (const manifest of [{ ...reviewed, extra: true }, { ...reviewed, legacy: { metadata: { unsafe: Infinity } } }]) {
    const root = await fixture();
    await override(root, entry({ manifest }));
    if ('legacy' in manifest) {
      // JSON.stringify turns Infinity into null; exercise an actual JSON numeric overflow instead.
      const path = join(root, '.opencode/runes-migration.json');
      await writeFile(path, (await readFile(path, 'utf8')).replace('"unsafe":null', '"unsafe":1e400'));
    }
    const result = await migrateBlocks(root, { dryRun: false, authorize: allow });
    expect(result.converted).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]!.reason).toContain('invalid_manifest');
    await expectUnwritten(root);
  }
});

test('adapter sidecar reads, original reads and edits propagate denials unchanged before writing', async () => {
  for (const boundary of ['override-read', 'original-read', 'edit']) {
    const root = await fixture();
    await override(root, entry());
    const denied = new Error(`${boundary} denied`);
    await expect(migrateBlocks(root, {
      dryRun: false,
      authorizeRead: async resource => {
        if ((boundary === 'override-read' && resource.endsWith('runes-migration.json'))
          || (boundary === 'original-read' && resource.endsWith('serve-static.mjs'))) throw denied;
      },
      authorize: async () => { if (boundary === 'edit') throw denied; },
    })).rejects.toBe(denied);
    await expectUnwritten(root);
  }
});

test('a newly reviewed adapter cannot overwrite an existing Rune with different source', async () => {
  const root = await fixture();
  await override(root, entry());
  await migrateBlocks(root, { dryRun: false, authorize: allow });
  const before = await new RuneStore(root).load('bounded-server');
  const changed = adapted + '// revised review\n';
  await override(root, entry({ adapter: { source: changed, sha256: digest(changed) } }));
  expect(await migrateBlocks(root, { dryRun: false, authorize: async () => { throw Error('unexpected edit'); } }))
    .toEqual({ converted: [], existing: [], dryRun: false, unsupported: [{
      path: '.blocks/serve-static.mjs', reason: 'Rune name already exists with conflicting content or provenance',
    }] });
  expect(await new RuneStore(root).load('bounded-server')).toEqual(before);
  expect(await readFile(join(root, '.blocks/serve-static.mjs'), 'utf8')).toBe(original);
});
