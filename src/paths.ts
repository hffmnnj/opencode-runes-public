import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { RuneError } from "./contracts.ts";

export async function projectRoot(directory: string): Promise<string> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new RuneError("path", "Project root is not a directory");
  return root;
}

function components(relative: string): string[] {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative) ||
      (process.platform === "win32" && (path.win32.parse(relative).root !== "" || relative.includes(":")))) {
    throw new RuneError("path", "Expected a project-relative path");
  }
  // Windows accepts both separators. Splitting only on path.sep lets a
  // forward-slash path hide traversal or a symlinked intermediate component.
  const parts = relative.split(process.platform === "win32" ? /[\\/]/ : /\//);
  if (parts.some(part => !part || part === "..")) throw new RuneError("path", "Path traversal is not allowed");
  return parts.filter(part => part !== ".");
}

export async function safePath(
  root: string,
  relative: string,
  options: { directory?: boolean; missing?: boolean; any?: boolean } = {},
): Promise<string> {
  const parts = components(relative);
  let cursor = root;
  let missing = false;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    if (missing) continue;
    let stat;
    try { stat = await lstat(cursor); }
    catch (error) {
      if (options.missing && (error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; continue; }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new RuneError("path", "Symlinks are not allowed in rune paths");
    const directory = index < parts.length - 1 || options.directory;
    if (directory ? !stat.isDirectory() : !(stat.isFile() || (options.any && stat.isDirectory()))) {
      throw new RuneError("path", directory ? "Expected a directory" : "Expected a regular file");
    }
  }
  return cursor;
}

export async function ensureDirectory(root: string, relative: string): Promise<string> {
  const parts = components(relative);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const target = await safePath(root, current, { directory: true, missing: true });
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await safePath(root, current, { directory: true });
  }
  return path.join(root, ...parts);
}

export async function readBounded(root: string, relative: string, maxBytes: number): Promise<string> {
  const target = await safePath(root, relative);
  const before = await lstat(target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.ino !== before.ino || initial.dev !== before.dev) {
      throw new RuneError("path", "File identity changed during read");
    }
    if (initial.size > maxBytes) throw new RuneError("limit", "File exceeds rune size limit");
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used > maxBytes) throw new RuneError("limit", "File exceeds rune size limit");
    const after = await handle.stat();
    const current = await lstat(target);
    if (current.isSymbolicLink() || current.ino !== initial.ino || current.dev !== initial.dev ||
        after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) {
      throw new RuneError("path", "File changed during read");
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)); }
    catch { throw new RuneError("encoding", "Rune files must contain valid UTF-8"); }
  } finally { await handle.close(); }
}
