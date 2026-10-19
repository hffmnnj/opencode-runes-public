import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuneError } from "../src/contracts.ts";
import { ensureDirectory, projectRoot, readBounded, safePath } from "../src/paths.ts";

// Owned scratch fixtures only. Partially written fixtures are retained and
// never recursively deleted.
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

describe("projectRoot", () => {
  it("returns_the_canonical_directory_for_an_existing_path", async () => {
    const root = await makeRoot("runes-paths-root");
    const sub = path.join(root, "sub");
    await mkdir(sub);
    expect(await projectRoot(sub)).toBe(sub);
  });

  it("resolves_a_symlinked_directory_to_its_canonical_target", async () => {
    const root = await makeRoot("runes-paths-rootlink");
    const target = path.join(root, "target");
    await mkdir(target);
    await symlink(target, path.join(root, "link"));
    expect(await projectRoot(path.join(root, "link"))).toBe(target);
  });

  it("rejects_a_regular_file_as_project_root", async () => {
    const root = await makeRoot("runes-paths-rootfile");
    const file = path.join(root, "file.txt");
    await writeFile(file, "data");
    try {
      await projectRoot(file);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_a_missing_project_root", async () => {
    const root = await makeRoot("runes-paths-rootmissing");
    await expect(projectRoot(path.join(root, "absent"))).rejects.toThrow();
  });
});

describe("safePath", () => {
  it("resolves_an_existing_file_inside_the_project", async () => {
    const root = await makeRoot("runes-paths-safe");
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "file.md"), "hello");
    expect(await safePath(root, "notes/file.md")).toBe(path.join(root, "notes", "file.md"));
  });

  it("rejects_absolute_paths", async () => {
    const root = await makeRoot("runes-paths-absolute");
    try {
      await safePath(root, "/etc/hostname");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_dotdot_traversal_components", async () => {
    const root = await makeRoot("runes-paths-traversal");
    for (const bad of ["..", "../escape.txt", "sub/../../escape.txt", "a/../.."]) {
      try {
        await safePath(root, bad);
        expect.unreachable(`accepted ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RuneError);
        expect((error as RuneError).code).toBe("path");
      }
    }
  });

  it("rejects_empty_and_nul_paths", async () => {
    const root = await makeRoot("runes-paths-empty");
    for (const bad of ["", "a\0b"]) {
      try {
        await safePath(root, bad);
        expect.unreachable(`accepted ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RuneError);
      }
    }
  });

  it("requires_the_directory_flag_for_directories", async () => {
    const root = await makeRoot("runes-paths-dirflag");
    await mkdir(path.join(root, "docs"));
    try {
      await safePath(root, "docs");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
    }
    expect(await safePath(root, "docs", { directory: true })).toBe(path.join(root, "docs"));
  });

  it("rejects_a_file_used_as_an_intermediate_component", async () => {
    const root = await makeRoot("runes-paths-intermediate");
    await writeFile(path.join(root, "afile"), "data");
    try {
      await safePath(root, "afile/child.txt", { missing: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("allows_a_missing_tail_with_missing_flag_without_creating_anything", async () => {
    const root = await makeRoot("runes-paths-missing");
    const resolved = await safePath(root, "newdir/out.txt", { missing: true });
    expect(resolved).toBe(path.join(root, "newdir", "out.txt"));
    expect(await exists(resolved)).toBe(false);
    expect(await exists(path.join(root, "newdir"))).toBe(false);
  });

  it("surfaces_system_missing_errors_without_the_missing_flag", async () => {
    const root = await makeRoot("runes-paths-nomissing");
    try {
      await safePath(root, "absent.txt");
      expect.unreachable();
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  it("rejects_a_symlink_file_even_when_it_points_inside_the_project", async () => {
    const root = await makeRoot("runes-paths-insidelink");
    await writeFile(path.join(root, "real.txt"), "real");
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    try {
      await safePath(root, "link.txt", { missing: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_symlink_directory_escape_to_an_owned_outside_directory", async () => {
    const root = await makeRoot("runes-paths-escape");
    const outside = await makeRoot("runes-paths-outside");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"));
    try {
      await safePath(root, "link/secret.txt");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_a_missing_tail_beneath_a_symlinked_ancestor", async () => {
    const root = await makeRoot("runes-paths-linktail");
    const outside = await makeRoot("runes-paths-linktail-outside");
    await symlink(outside, path.join(root, "link"));
    try {
      await safePath(root, "link/fresh.txt", { missing: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
    expect(await exists(path.join(outside, "fresh.txt"))).toBe(false);
  });

  it("accepts_an_existing_directory_as_final_component_with_the_any_flag", async () => {
    const root = await makeRoot("runes-paths-any");
    await mkdir(path.join(root, "datadir"));
    await writeFile(path.join(root, "regular.txt"), "data");
    expect(await safePath(root, "datadir", { any: true })).toBe(path.join(root, "datadir"));
    expect(await safePath(root, "regular.txt", { any: true })).toBe(path.join(root, "regular.txt"));
  });

  it("still_rejects_symlinks_and_traversal_with_the_any_flag", async () => {
    const root = await makeRoot("runes-paths-anyreject");
    const outside = await makeRoot("runes-paths-anyreject-outside");
    await symlink(outside, path.join(root, "link"));
    for (const bad of ["link", "link/secret.txt", "../escape"]) {
      try {
        await safePath(root, bad, { missing: true, any: true });
        expect.unreachable(`accepted ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RuneError);
        expect((error as RuneError).code).toBe("path");
      }
    }
  });
});

describe("readBounded", () => {
  it("reads_exact_bytes_for_a_small_regular_file", async () => {
    const root = await makeRoot("runes-paths-read");
    await writeFile(path.join(root, "note.txt"), "exact-bytes");
    expect(await readBounded(root, "note.txt", 64)).toBe("exact-bytes");
  });

  it("reads_a_file_at_the_exact_size_bound", async () => {
    const root = await makeRoot("runes-paths-boundary");
    await writeFile(path.join(root, "edge.txt"), "x".repeat(16));
    expect(await readBounded(root, "edge.txt", 16)).toBe("x".repeat(16));
  });

  it("rejects_a_file_beyond_the_size_bound", async () => {
    const root = await makeRoot("runes-paths-oversize");
    await writeFile(path.join(root, "big.txt"), "x".repeat(100));
    try {
      await readBounded(root, "big.txt", 16);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("limit");
    }
  });

  it("rejects_invalid_utf8_bytes", async () => {
    const root = await makeRoot("runes-paths-encoding");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0x41]));
    try {
      await readBounded(root, "binary.bin", 64);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("encoding");
    }
  });

  it("refuses_to_follow_symlinks", async () => {
    const root = await makeRoot("runes-paths-readlink");
    await writeFile(path.join(root, "real.txt"), "real");
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    try {
      await readBounded(root, "link.txt", 64);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
  });

  it("rejects_directory_and_missing_reads", async () => {
    const root = await makeRoot("runes-paths-readdirmissing");
    await mkdir(path.join(root, "subdir"));
    try {
      await readBounded(root, "subdir", 64);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
    }
    try {
      await readBounded(root, "absent.txt", 64);
      expect.unreachable();
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  it("returns_content_equal_to_a_direct_read_for_a_stable_file", async () => {
    const root = await makeRoot("runes-paths-stable");
    const content = "stable-content-".repeat(10);
    await writeFile(path.join(root, "stable.txt"), content);
    const bounded = await readBounded(root, "stable.txt", 1024);
    const direct = await readFile(path.join(root, "stable.txt"), "utf8");
    expect(bounded).toBe(direct);
    expect(bounded).toBe(content);
  });
});

describe("ensureDirectory", () => {
  it("creates_nested_directories_and_returns_the_joined_path", async () => {
    const root = await makeRoot("runes-paths-ensure");
    const created = await ensureDirectory(root, "a/b/c");
    expect(created).toBe(path.join(root, "a", "b", "c"));
    expect((await lstat(path.join(root, "a", "b", "c"))).isDirectory()).toBe(true);
  });

  it("is_idempotent_for_existing_directories", async () => {
    const root = await makeRoot("runes-paths-idempotent");
    expect(await ensureDirectory(root, "work/nested")).toBe(path.join(root, "work", "nested"));
    expect(await ensureDirectory(root, "work/nested")).toBe(path.join(root, "work", "nested"));
    await writeFile(path.join(root, "work", "nested", "file.txt"), "kept");
    expect(await ensureDirectory(root, "work/nested")).toBe(path.join(root, "work", "nested"));
    expect(await readFile(path.join(root, "work", "nested", "file.txt"), "utf8")).toBe("kept");
  });

  it("rejects_traversal_without_creating_anything_outside", async () => {
    const root = await makeRoot("runes-paths-ensuretraversal");
    const evil = `runes-evil-${process.pid}`;
    try {
      await ensureDirectory(root, `../${evil}`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
    }
    expect(await exists(path.join(FIXTURE_BASE, evil))).toBe(false);
  });

  it("refuses_to_build_through_a_symlinked_ancestor", async () => {
    const root = await makeRoot("runes-paths-ensurelink");
    const outside = await makeRoot("runes-paths-ensurelink-outside");
    await symlink(outside, path.join(root, "link"));
    try {
      await ensureDirectory(root, "link/sub");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("path");
    }
    expect(await exists(path.join(outside, "sub"))).toBe(false);
  });

  it("rejects_a_regular_file_blocking_the_requested_directory", async () => {
    const root = await makeRoot("runes-paths-ensurefile");
    await writeFile(path.join(root, "afile"), "data");
    try {
      await ensureDirectory(root, "afile/sub");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
    }
  });
});
