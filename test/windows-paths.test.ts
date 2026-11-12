import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { safePath } from "../src/paths.ts";

test.skipIf(process.platform !== "win32")("Windows paths validate both separators component by component", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "runes-win-path-"));
  const root = path.join(fixture, "project");
  const outside = path.join(fixture, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(path.join(root, "inside"));
  await writeFile(path.join(root, "inside", "ok.txt"), "ok");
  await writeFile(path.join(outside, "secret.txt"), "outside");
  // Junctions do not require Windows symlink privileges.
  await symlink(outside, path.join(root, "link"), "junction");

  expect(await safePath(root, "inside/ok.txt")).toBe(path.join(root, "inside", "ok.txt"));
  for (const input of [
    "inside/../../outside/secret.txt", "inside\\..\\..\\outside\\secret.txt",
    "inside/..\\../outside/secret.txt", "link/secret.txt", "link\\secret.txt",
    "C:relative.txt", "inside/ok.txt:stream",
  ]) {
    await expect(safePath(root, input, { missing: true })).rejects.toThrow();
  }
});
