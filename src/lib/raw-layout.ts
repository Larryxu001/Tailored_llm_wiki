/**
 * Tailored LLM Wiki — relaxed raw/ layout.
 *
 * Stock llm-wiki only recognises sources under `raw/sources/`. Here any file
 * under `raw/` is a source (e.g. `raw/海外投行/2026-10/report.pdf`), except
 * the folders the app and agents write themselves:
 *   raw/assets/        images and attachments
 *   raw/parsed/        visible parsed-text copies
 *   raw/translations/  agent translations
 * plus hidden folders such as `.cache/`.
 *
 * Source identity (used in `sources:` frontmatter, ingest cache and summary
 * slugs) stays backward compatible: a file under `raw/sources/` keeps its
 * identity relative to `raw/sources/`; any other file uses its path relative
 * to `raw/`. Avoid keeping `raw/x.pdf` and `raw/sources/x.pdf` side by side —
 * they would share an identity.
 *
 * Mirrors `is_raw_source_rel` in src-tauri/src/commands/file_sync.rs.
 */
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { filterRawSourceTree } from "@/lib/source-filter"
import type { FileNode } from "@/types/wiki"

export const RAW_DIR = "raw"
export const LEGACY_SOURCES_DIR = "raw/sources"
export const RESERVED_RAW_DIRS = new Set(["assets", "parsed", "translations"])

/** Project-relative path → is it a raw source file? */
export function isRawSourceRelPath(relativePath: string): boolean {
  const rel = normalizePath(relativePath).replace(/^\/+/, "")
  if (!rel.toLowerCase().startsWith("raw/")) return false
  const segments = rel.slice(4).split("/")
  if (segments.length === 0 || segments.some((s) => s.length === 0)) return false
  if (segments.length > 1 && RESERVED_RAW_DIRS.has(segments[0].toLowerCase())) return false
  return !segments.slice(0, -1).some((s) => s.startsWith("."))
}

/** Project-relative raw path → source identity. */
export function rawSourceIdentityFromRel(relativePath: string): string | null {
  const rel = normalizePath(relativePath).replace(/^\/+/, "")
  const lower = rel.toLowerCase()
  if (lower.startsWith("raw/sources/")) return rel.slice("raw/sources/".length)
  if (lower.startsWith("raw/")) return rel.slice("raw/".length)
  return null
}

/** Source identity → candidate project-relative paths, legacy location first. */
export function rawSourceRelCandidates(sourceIdentity: string): string[] {
  const id = normalizePath(sourceIdentity).replace(/^\/+/, "")
  return [`raw/sources/${id}`, `raw/${id}`]
}

/** Drop reserved folders from a listing of `raw/` (top level only). */
export function filterRawLayoutTree(rawChildren: FileNode[]): FileNode[] {
  return rawChildren.filter((node) => !(node.is_dir && RESERVED_RAW_DIRS.has(node.name.toLowerCase())))
}

/**
 * Tree of every raw source file in the project (replaces listing
 * `raw/sources`). Hidden and sensitive entries are filtered like before.
 */
export async function listRawSourceTree(projectPath: string): Promise<FileNode[]> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const nodes = await listDirectory(`${pp}/${RAW_DIR}`, true)
  return filterRawSourceTree(filterRawLayoutTree(nodes))
}
