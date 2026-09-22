/**
 * Zero-dependency shared types.
 *
 * This file may only import from `node:` builtins and external type
 * packages — never from project modules. Every other layer depends on
 * `shared/`, which keeps type-only dependencies acyclic at the module level.
 */
import type { Stats } from 'node:fs'

/** The kind of an asar-storable entry. */
export enum EntryKind {
  FILE = 'file',
  DIRECTORY = 'directory',
  LINK = 'link',
}

/** A plain JSON object: arbitrary string keys, JSON-compatible values. */
export type JsonObject = Record<string, unknown>

/** A logical file set: an absolute source dir plus the collected files. */
export interface FileSet {
  src: string
  destination: string
  files: string[]
  metadata: Map<string, FileStat>
}

/** File filter predicate used across collectors. */
export type FileFilter = (file: string, stat: FileStat) => boolean

/**
 * Callback invoked for each collected node_modules file; returning true
 * forces the file to be included even if it matches default exclusions.
 */
export type FileVisitor = (file: string) => boolean

/**
 * Collected entry metadata: the entry kind plus the module metadata that
 * the collectors attach. Pure data with no behavior.
 */
export interface FileStat {
  type: EntryKind
  size: number
  mode: number
  /** Real on-disk source path when the packed file differs from the logical path. */
  realFilePath?: string
  /** Name of the node module the file belongs to. */
  moduleName?: string
  /** Root directory of the owning module. */
  moduleRootPath?: string
  /** Full path relative to the module root. */
  moduleFullFilePath?: string
  /** Symlink target relative to the module root. */
  relativeLink?: string
  /** Symlink target relative to the link's directory. */
  linkRelativeToFile?: string
}

/** A resolved production dependency reported by the collector. */
export interface DependencyEntry {
  name: string
  dir: string
  dependencies?: DependencyEntry[]
}

/** A parsed minimatch pattern (from the `minimatch` package). */
export interface MinimatchPattern {
  match: (p: string, partial?: boolean) => boolean
  set: Array<Array<string | object | symbol>>
  negate: boolean
}

/**
 * Map an fs stat result to its entry kind, or null for special entries
 * (sockets, FIFOs, devices) that the asar format cannot store.
 */
export function entryKind(stat: Stats): EntryKind | null {
  if (stat.isSymbolicLink()) return EntryKind.LINK
  if (stat.isFile()) return EntryKind.FILE
  if (stat.isDirectory()) return EntryKind.DIRECTORY
  return null
}
