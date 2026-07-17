import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILE } from "./config.ts";
import { log } from "./logger.ts";
import { Mutex } from "./mutex.ts";

/**
 * One manifest entry per "owner/repo". `branch`/`fetched_at` may be missing in
 * hand-edited or legacy files; only `dir` is required for an entry to be kept.
 */
export interface ManifestEntry {
  dir: string;
  branch?: string;
  fetched_at?: string;
}

type Manifest = Record<string, ManifestEntry>;

const lock = new Mutex();

function sanitize(data: unknown): Manifest {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    log.warn(`manifest ${MANIFEST_FILE} is not a JSON object — starting empty`);
    return {};
  }
  const manifest: Manifest = {};
  for (const [repo, entry] of Object.entries(data)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { dir?: unknown }).dir === "string"
    ) {
      manifest[repo] = entry as ManifestEntry;
    }
  }
  return manifest;
}

async function load(): Promise<Manifest> {
  try {
    return sanitize(JSON.parse(await readFile(MANIFEST_FILE, "utf-8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`unreadable manifest ${MANIFEST_FILE} (${String(err)}) — starting empty`);
    }
    return {};
  }
}

async function save(manifest: Manifest): Promise<void> {
  try {
    await mkdir(path.dirname(MANIFEST_FILE), { recursive: true });
    const sorted = Object.fromEntries(
      Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
    );
    const tmp = `${MANIFEST_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
    await rename(tmp, MANIFEST_FILE); // atomic on POSIX
  } catch (err) {
    log.warn(`cannot write manifest ${MANIFEST_FILE} (${String(err)})`);
  }
}

export function manifestGet(repo: string): Promise<ManifestEntry | undefined> {
  return lock.runExclusive(async () => (await load())[repo]);
}

export function manifestPut(repo: string, entry: ManifestEntry): Promise<void> {
  return lock.runExclusive(async () => {
    const manifest = await load();
    manifest[repo] = entry;
    await save(manifest);
  });
}
