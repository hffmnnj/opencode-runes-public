import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, validateParams } from '../src/contracts.ts';
import { migrateBlocks } from '../src/migrate.ts';
import { RuneStore } from '../src/store.ts';

const authorize = async () => {};
const digest = (source: string | Buffer) => createHash('sha256').update(source).digest('hex');

async function fixture() {
  const root = await mkdtemp('/var/tmp/example/opencode/runes-migrate-');
  await mkdir(join(root, '.blocks'));
  return root;
}

function python(name = 'scalar-probe', params = 'count = { type = "int", default = 7, min = 1, max = 10, help = "Count items" }', extra = '') {
  return `#!/usr/bin/env python3\n# /// block\n# name = "${name}"\n# summary = "Scalar probe"\n# effects = "write-workspace"\n# example = ["--count", "8"]\n${extra}# [params]\n${params.split('\n').map(line => '# ' + line).join('\n')}\n# ///\nraise RuntimeError("MIGRATION MUST NOT EXECUTE THIS")\n`;
}

describe('migrateBlocks', () => {
  test('dry-run previews supported files without mutation, authorization, or execution', async () => {
    const root = await fixture();
    const source = python();
    await writeFile(join(root, '.blocks/probe.py'), source);
    const report = await migrateBlocks(root, { authorize: async () => { throw new Error('must not ask'); } });
    expect(report).toEqual({ converted: ['scalar-probe'], existing: [], unsupported: [], dryRun: true });
    expect(await readdir(root)).toEqual(['.blocks']);
    expect(await readFile(join(root, '.blocks/probe.py'), 'utf8')).toBe(source);
  });

  test('applies typed scalar metadata, provenance and snapshots without importing authority', async () => {
    const root = await fixture();
    const source = python('scalar-probe', [
      'count = { type = "int", default = 7, min = 1, max = 10, help = "Count items" }',
      'ratio = { type = "float", default = 1.5, min = 0.5, max = 2.5 }',
      'label = { type = "str", required = true, enum = ["left", "right"] }',
      'input = { type = "path", required = true }',
    ].join('\n'), '# stamp = { verified = "old" }\n# allow_effects = ["external"]\n# provenance = { source = "local" }\n');
    await writeFile(join(root, '.blocks/probe.py'), source);
    const requests: unknown[] = [];
    const report = await migrateBlocks(root, { dryRun: false, authorize: async request => {
      expect(await readdir(root)).toEqual(['.blocks']);
      requests.push(request);
    } });
    expect(report).toEqual({ converted: ['scalar-probe'], existing: [], unsupported: [], dryRun: false });
    expect(requests).toEqual([{
      action: 'edit', resources: [join(root, '.opencode/.runes/scalar-probe/rune.json'), join(root, '.opencode/.runes/scalar-probe/main.py')],
      metadata: { root, source: '.blocks/probe.py', sha256: digest(source), effects: 'write-workspace' },
    }]);
    const loaded = await new RuneStore(root).load('scalar-probe');
    expect(loaded.source).toBe(source);
    expect(loaded.manifest.params).toEqual({
      count: { type: 'integer', default: 7, min: 1, max: 10, description: 'Count items' },
      ratio: { type: 'number', default: 1.5, min: 0.5, max: 2.5 },
      label: { type: 'string', required: true, enum: ['left', 'right'] },
      input: { type: 'path', required: true },
    });
    expect(validateParams(loaded.manifest, { label: 'right', input: 'fixture.json' })).toEqual({
      count: 7, ratio: 1.5, label: 'right', input: 'fixture.json',
    });
    expect(loaded.manifest.legacy).toMatchObject({
      path: '.blocks/probe.py', sha256: digest(source), format: 'caveman-blocks', example: ['--count', '8'],
      metadata: { provenance: { source: 'local' } },
    });
    expect(loaded.manifest.legacy!.metadata).not.toHaveProperty('stamp');
    expect(loaded.manifest.legacy!.metadata).not.toHaveProperty('allow_effects');
    expect(await readFile(join(root, '.blocks/probe.py'), 'utf8')).toBe(source);
  });

  test('permission denial is propagated unchanged before any destination mutation', async () => {
    const root = await fixture();
    await writeFile(join(root, '.blocks/probe.py'), python());
    const denied = new Error('edit denied');
    await expect(migrateBlocks(root, { dryRun: false, authorize: async () => { throw denied; } })).rejects.toBe(denied);
    expect(await readdir(root)).toEqual(['.blocks']);
  });

  test('identical repeat is existing without permission while changed provenance never overwrites', async () => {
    const root = await fixture();
    await writeFile(join(root, '.blocks/probe.py'), python());
    await migrateBlocks(root, { dryRun: false, authorize });
    const before = await new RuneStore(root).load('scalar-probe');
    const noPermission = async () => { throw new Error('must not ask'); };
    expect(await migrateBlocks(root, { dryRun: false, authorize: noPermission })).toEqual({
      converted: [], existing: ['scalar-probe'], unsupported: [], dryRun: false,
    });
    await writeFile(join(root, '.blocks/probe.py'), python() + '# changed\n');
    const conflict = await migrateBlocks(root, { dryRun: false, authorize: noPermission });
    expect(conflict.converted).toEqual([]);
    expect(conflict.existing).toEqual([]);
    expect(conflict.unsupported).toEqual([{ path: '.blocks/probe.py', reason: 'Rune name already exists with conflicting content or provenance' }]);
    expect(await new RuneStore(root).load('scalar-probe')).toEqual(before);
  });

  test('reports ambiguous booleans, unsupported languages, malformed and unsafe schemas', async () => {
    const root = await fixture();
    await writeFile(join(root, '.blocks/boolean.py'), python('bool-probe', 'flag = { type = "bool", default = false }'));
    await writeFile(join(root, '.blocks/script.ts'), 'throw new Error("not executable");');
    await writeFile(join(root, '.blocks/malformed.py'), '# /// block\n# name = [\n# ///\n');
    await writeFile(join(root, '.blocks/escape.py'), python('../escape'));
    await writeFile(join(root, '.blocks/schema.py'), python('schema', 'x = { type = "str", action = "append" }'));
    await writeFile(join(root, '.blocks/INDEX.md'), 'not a candidate');
    await mkdir(join(root, '.blocks/fixtures.py'));
    const report = await migrateBlocks(root, { dryRun: false, authorize: async () => { throw new Error('must not ask'); } });
    expect(report.converted).toEqual([]);
    expect(report.unsupported.map(row => row.path)).toEqual([
      '.blocks/boolean.py', '.blocks/escape.py', '.blocks/malformed.py', '.blocks/schema.py', '.blocks/script.ts',
    ]);
    expect(report.unsupported[0]!.reason).toContain('Boolean argv encoding is ambiguous');
    expect(report.unsupported[2]!.reason).toContain('Invalid TOML');
    expect(await readdir(root)).toEqual(['.blocks']);
  });

  test('refuses source symlinks, oversized sources and malformed UTF-8', async () => {
    const root = await fixture();
    await writeFile(join(root, 'outside.py'), python());
    await symlink('../outside.py', join(root, '.blocks/link.py'));
    await writeFile(join(root, '.blocks/large.py'), 'x'.repeat(LIMITS.sourceBytes + 1));
    await writeFile(join(root, '.blocks/invalid.py'), Buffer.from([0xff, 0xfe]));
    const report = await migrateBlocks(root, { authorize });
    expect(report.converted).toEqual([]);
    expect(report.unsupported.map(row => row.path)).toEqual(['.blocks/invalid.py', '.blocks/large.py', '.blocks/link.py']);
    expect(report.unsupported.map(row => row.reason)).toEqual([
      'Source or header is unsupported: encoding', 'Source or header is unsupported: limit', 'Source or header is unsupported: path',
    ]);
    expect((await lstat(join(root, '.blocks/link.py'))).isSymbolicLink()).toBe(true);
  });

  test('missing Blocks is an empty nonmutating preview', async () => {
    const root = await mkdtemp('/var/tmp/example/opencode/runes-migrate-empty-');
    expect(await migrateBlocks(root, { authorize })).toEqual({ converted: [], existing: [], unsupported: [], dryRun: true });
    expect(await readdir(root)).toEqual([]);
  });

  test('duplicate names preview conflicts just as applied migration does', async () => {
    const root = await fixture();
    await writeFile(join(root, '.blocks/a.py'), python());
    await writeFile(join(root, '.blocks/b.py'), python() + '# different source\n');
    const preview = await migrateBlocks(root, { authorize });
    const applied = await migrateBlocks(root, { dryRun: false, authorize });
    expect(preview.converted).toEqual(['scalar-probe']);
    expect(preview.unsupported).toEqual([{
      path: '.blocks/b.py', reason: 'Multiple Blocks declare the same Rune name; never overwritten',
    }]);
    expect(applied.unsupported).toEqual(preview.unsupported);
    expect((await new RuneStore(root).load('scalar-probe')).source).toBe(python());
  });

  test('byte-order marks cannot silently change snapshot bytes or provenance', async () => {
    const root = await fixture();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(python())]);
    await writeFile(join(root, '.blocks/bom.py'), bytes);
    const report = await migrateBlocks(root, { dryRun: false, authorize: async () => { throw new Error('must not ask'); } });
    expect(report.converted).toEqual([]);
    expect(report.unsupported).toHaveLength(1);
    expect(await readFile(join(root, '.blocks/bom.py'))).toEqual(bytes);
    expect(await readdir(root)).toEqual(['.blocks']);
  });

  test('bounds the directory inventory before authorizing or writing', async () => {
    const root = await fixture();
    await writeFile(join(root, '.blocks/probe.py'), python());
    await Promise.all(Array.from({ length: LIMITS.catalogEntries }, (_, index) =>
      writeFile(join(root, '.blocks', `data-${index}.txt`), '')));
    await expect(migrateBlocks(root, { dryRun: false, authorize: async () => { throw new Error('must not ask'); } }))
      .rejects.toMatchObject({ code: 'limit', message: 'Blocks directory exceeds catalog limit' });
    expect(await readdir(root)).toEqual(['.blocks']);
  });

  test('Blocks directory symlink is rejected rather than scanning its target', async () => {
    const root = await mkdtemp('/var/tmp/example/opencode/runes-migrate-link-');
    const target = await fixture();
    await symlink(join(target, '.blocks'), join(root, '.blocks'));
    await expect(migrateBlocks(root, { authorize })).rejects.toMatchObject({ code: 'path' });
    expect(await readdir(root)).toEqual(['.blocks']);
  });

  test('converts copied real project inventories, retaining original bytes and location dependencies', async () => {
    const inventories = [
      { directory: '/home/example/Documents/example-project-a/.blocks', total: 9, converted: 9 },
      { directory: '/home/example/Documents/example-project-b/.blocks', names: ['property-retention-core.py'], total: 1, converted: 1 },
      { directory: '/home/example/.config/opencode-v2/.blocks', total: 5, converted: 4 },
    ];
    for (const inventory of inventories) {
      const root = await fixture();
      const names = inventory.names ?? (await readdir(inventory.directory)).filter(name => name.endsWith('.py')).sort();
      expect(names).toHaveLength(inventory.total);
      const originals = new Map<string, Buffer<ArrayBuffer>>();
      for (const name of names) {
        const original = await readFile(join(inventory.directory, name));
        originals.set(name, original);
        await copyFile(join(inventory.directory, name), join(root, '.blocks', name));
      }
      const preview = await migrateBlocks(root, { authorize });
      expect(preview.converted).toHaveLength(inventory.converted);
      expect(await readdir(root)).toEqual(['.blocks']);
      const applied = await migrateBlocks(root, { dryRun: false, authorize });
      expect(applied.converted).toEqual(preview.converted);
      expect(applied.unsupported).toHaveLength(inventory.total - inventory.converted);
      if (inventory.total === 5) {
        expect(applied.unsupported).toEqual([{
          path: '.blocks/static-bundle-activate.py', reason: 'Source or header is unsupported: Boolean argv encoding is ambiguous; manual conversion required',
        }]);
      }
      const repeated = await migrateBlocks(root, { dryRun: false, authorize: async () => { throw new Error('must not ask again'); } });
      expect(repeated.existing).toEqual(applied.converted);
      expect(repeated.converted).toEqual([]);
      for (const [name, bytes] of originals) {
        expect(await readFile(join(root, '.blocks', name))).toEqual(bytes);
        expect(await readFile(join(inventory.directory, name))).toEqual(bytes);
      }
      const first = await new RuneStore(root).load(applied.converted[0]!);
      expect(first.manifest.legacy!.path).toBe(`.blocks/${applied.converted[0]}.py`);
      expect(first.manifest.legacy!.sha256).toBe(digest(originals.get(`${applied.converted[0]}.py`)!));
    }
  });
});
