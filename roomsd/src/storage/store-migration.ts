import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";

const CANONICAL_FILENAME = "rooms.sqlite";
const LEGACY_FILENAME = "roomsd-ts.sqlite";

function regularFile(path: string, label: string): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing ${label}: expected a regular file, not a symlink or other file type (${path})`);
  return true;
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve the canonical store, moving the legacy store only by same-directory rename. */
export function prepareCanonicalStorePath(inputPath: string): string {
  const canonical = resolve(inputPath);
  if (basename(canonical) !== CANONICAL_FILENAME) return canonical;
  const directory = dirname(canonical);
  const legacy = join(directory, LEGACY_FILENAME);
  const canonicalWal = `${canonical}-wal`;
  const canonicalShm = `${canonical}-shm`;
  const legacyWal = `${legacy}-wal`;
  const legacyShm = `${legacy}-shm`;
  const canonicalExists = regularFile(canonical, "canonical Rooms store");
  const legacyExists = regularFile(legacy, "legacy Rooms store");
  let sidecars = [canonicalWal, canonicalShm, legacyWal, legacyShm].filter(present);

  if (canonicalExists && legacyExists) {
    throw new Error(`Rooms store collision: both canonical ${canonical} and legacy ${legacy} exist; stop Rooms and run the Rooms-owned store migration command`);
  }
  if (!canonicalExists && legacyExists && sidecars.length > 0) {
    checkpointLegacyStore(legacy, legacyWal, legacyShm);
    sidecars = [canonicalWal, canonicalShm, legacyWal, legacyShm].filter(present);
  } else if (!canonicalExists && sidecars.length > 0) {
    throw new Error(`cannot safely migrate Rooms store: SQLite sidecars exist without a legacy store (${sidecars.join(", ")})`);
  }
  if (!legacyExists) return canonical;
  if (sidecars.length > 0) {
    throw new Error(`cannot safely migrate legacy Rooms store: SQLite sidecars exist (${sidecars.join(", ")}); stop the Rooms-owned service and use its migration command`);
  }
  renameSync(legacy, canonical);
  return canonical;
}

function checkpointLegacyStore(legacy: string, legacyWal: string, legacyShm: string): void {
  const backup = join(dirname(legacy), `roomsd-ts.pre-canonical-migration-${randomUUID()}.sqlite`);
  const database = new DatabaseSync(legacy);
  try {
    database.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    chmodSync(backup, 0o600);
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | undefined;
    const busy = Number(result?.busy ?? Object.values(result ?? {})[0] ?? 1);
    if (busy !== 0) throw new Error("legacy Rooms store is still in use; stop its service before setup migration");
  } finally {
    database.close();
  }
  for (const sidecar of [legacyWal, legacyShm]) {
    try { unlinkSync(sidecar); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
