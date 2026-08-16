// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const OWNER_DIRECTORY_MODE = 0o700;
export const OWNER_FILE_MODE = 0o600;
export const OWNER_EXECUTABLE_FILE_MODE = 0o700;

export function assertSafeStateSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

export function ensureOwnerDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  const value = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (value.isSymbolicLink() || !value.isDirectory() || (value.mode & 0o777) !== OWNER_DIRECTORY_MODE || (uid !== undefined && value.uid !== uid)) {
    throw new Error(`refusing insecure profile state directory: ${path}`);
  }
  return path;
}

export function assertOwnerFile(path: string, expectedMode = OWNER_FILE_MODE): void {
  const value = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (value.isSymbolicLink() || !value.isFile() || (value.mode & 0o777) !== expectedMode || (uid !== undefined && value.uid !== uid)) {
    throw new Error(`refusing insecure profile state file: ${path}`);
  }
}

export function readOwnerFile(path: string, maximumBytes: number, expectedMode = OWNER_FILE_MODE): Buffer {
  assertOwnerFile(path, expectedMode);
  const value = readFileSync(path);
  if (value.byteLength > maximumBytes) throw new Error(`profile state file is oversized: ${path}`);
  return value;
}

export function writeNewOwnerFile(path: string, content: Uint8Array, mode = OWNER_FILE_MODE): void {
  if (mode !== OWNER_FILE_MODE && mode !== OWNER_EXECUTABLE_FILE_MODE) throw new Error(`invalid owner-only file mode: ${mode.toString(8)}`);
  const fd = openSync(path, "wx", mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if ((statSync(path).mode & 0o777) !== mode) throw new Error(`profile state file mode changed during write: ${path}`);
}

export function replaceOwnerFile(path: string, content: Uint8Array): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeNewOwnerFile(temporary, content);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function withOwnerFileLock<T>(path: string, operation: () => T): T {
  writeNewOwnerFile(path, new Uint8Array());
  try { return operation(); }
  finally {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  }
}

export function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
