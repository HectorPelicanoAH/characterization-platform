import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../shared/model.ts";

const excluded = new Set([
  "node_modules",
  ".git",
  ".env",
  "dist",
  "build",
  ".next",
  ".data",
  ".aws",
  ".ssh",
]);
const allowed = /\.(md|mdc|txt|ya?ml)$/i;
export async function collectContext(
  directories: string[],
): Promise<ContextSnapshot> {
  const snapshot: ContextSnapshot = { files: [], warnings: [], characters: 0 };
  const seen = new Set<string>();
  let visited = 0;
  for (const directory of directories) {
    if (!isAbsolute(directory))
      throw new Error(`Use an absolute directory path: ${directory}`);
    const root = await realpath(directory).catch(() => {
      throw new Error(`Directory not found: ${directory}`);
    });
    if (!(await lstat(root)).isDirectory())
      throw new Error(`Not a directory: ${directory}`);
    async function walk(path: string, depth: number): Promise<void> {
      if (
        depth > 6 ||
        visited > 3000 ||
        snapshot.files.length >= 80 ||
        snapshot.characters >= 120000
      ) {
        snapshot.warnings.push(`Context limit reached at ${path}.`);
        return;
      }
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          ++visited > 3000 ||
          snapshot.files.length >= 80 ||
          snapshot.characters >= 120000
        )
          break;
        if (
          excluded.has(entry.name) ||
          entry.name.startsWith(".env") ||
          /secret|credential|token|private[-_]?key/i.test(entry.name)
        )
          continue;
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(file, depth + 1);
          continue;
        }
        if (!entry.isFile() || !allowed.test(entry.name) || seen.has(file))
          continue;
        const canonical = await realpath(file);
        if (relative(root, canonical).startsWith(".." + sep)) continue;
        const stat = await lstat(file);
        if (stat.size > 24000) {
          snapshot.warnings.push(`Skipped due to size (>24 KB): ${file}`);
          continue;
        }
        const content = await readFile(file, "utf8");
        if (content.includes("\0")) continue;
        if (snapshot.characters + content.length > 120000) {
          snapshot.warnings.push(`Context budget exhausted for ${file}`);
          continue;
        }
        snapshot.files.push({
          path: canonical,
          content,
          hash: createHash("sha256").update(content).digest("hex"),
        });
        snapshot.characters += content.length;
        seen.add(file);
      }
    }
    await walk(root, 0);
  }
  if (
    visited > 3000 ||
    snapshot.files.length >= 80 ||
    snapshot.characters >= 120000
  )
    snapshot.warnings.push(
      "Context is limited to 80 files, 120,000 characters and 3,000 entries.",
    );
  return snapshot;
}
