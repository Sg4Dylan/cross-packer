/**
 * Tar entry helpers: materialize entries into a temporary directory, then
 * pack it with `tar` while preserving per-entry modes. Mode preservation is
 * required for setuid binaries such as chrome-sandbox.
 */
import { existsSync, type Stats } from 'node:fs'
import { mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReadEntry } from 'tar'
import * as tar from 'tar'

export type TarEntry =
  | { type: 'dir'; path: string; mode?: number }
  | {
      type: 'file'
      path: string
      mode?: number
      content?: Buffer
      filePath?: string
      getBuffer?: () => Promise<Buffer>
    }
  | {
      type: 'link'
      path: string
      mode?: number
      target?: string
      getTarget?: () => Promise<string>
    }

/** Packs entries into an uncompressed tar at destPath. */
export async function writeTarFromEntries(entries: TarEntry[], destPath: string): Promise<void> {
  const tmpDir = `${destPath}-tmp`
  await mkdir(tmpDir, { recursive: true })

  try {
    const modeMap = new Map<string, number | undefined>()

    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry.path)
      const parentDir = path.dirname(fullPath)

      if (entry.type === 'dir') {
        await mkdir(fullPath, { recursive: true })
        modeMap.set(entry.path, entry.mode)
      } else if (entry.type === 'file') {
        await mkdir(parentDir, { recursive: true })
        await writeFile(fullPath, await resolveBuffer(entry))
        modeMap.set(entry.path, entry.mode)
      } else if (entry.type === 'link') {
        await mkdir(parentDir, { recursive: true })
        const target = entry.getTarget ? await entry.getTarget() : entry.target || ''
        await symlink(target, fullPath)
        modeMap.set(entry.path, entry.mode)
      }
    }

    await tar.create(
      {
        gzip: false,
        file: destPath,
        cwd: tmpDir,
        portable: true,
        noPax: true,
        filter: (entryPath: string, stat: ReadEntry | Stats) => {
          const p = entryPath.replace(/^\.\//, '')
          if (p === '.') return true
          const mode = modeMap.get(p)
          if (mode !== undefined) {
            stat.mode = mode
          }
          return true
        },
      },
      ['.'],
    )
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

export interface CollectDirectoryOptions {
  includeSymlinks?: boolean
  resolveFileMode?: (input: {
    filePath: string
    relativePath: string
    sourceMode: number
  }) => number | undefined | undefined
}

/** Flattens a directory on disk into tar entries rooted at prefix. */
export async function collectDirectoryEntries(
  dirPath: string,
  prefix: string,
  options: CollectDirectoryOptions = {},
): Promise<TarEntry[]> {
  if (!existsSync(dirPath)) return []

  const entries: TarEntry[] = []
  await walkDir(dirPath, dirPath, prefix, entries, options)
  return entries
}

/** Resolve a file entry's content: inline Buffer, disk path, or lazy getter. */
async function resolveBuffer(entry: Extract<TarEntry, { type: 'file' }>): Promise<Buffer> {
  if (entry.content) return entry.content
  if (entry.filePath) return readFile(entry.filePath)
  if (entry.getBuffer) return entry.getBuffer()
  throw new Error(`TarEntry "${entry.path}" has no content source`)
}

async function walkDir(
  rootDir: string,
  dirPath: string,
  prefix: string,
  entries: TarEntry[],
  options: CollectDirectoryOptions,
): Promise<void> {
  const children = await readdir(dirPath, { withFileTypes: true })
  for (const child of children) {
    const fullPath = path.join(dirPath, child.name)
    const entryPath = `${prefix}/${child.name}`
    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join('/')

    if (child.isDirectory()) {
      entries.push({ type: 'dir', path: entryPath, mode: 0o40755 })
      await walkDir(rootDir, fullPath, entryPath, entries, options)
    } else if (child.isFile()) {
      const s = await stat(fullPath)
      const mode =
        options.resolveFileMode?.({ filePath: fullPath, relativePath, sourceMode: s.mode }) ??
        0o100644
      entries.push({ type: 'file', path: entryPath, mode, filePath: fullPath })
    } else if (child.isSymbolicLink() && options.includeSymlinks) {
      entries.push({
        type: 'link',
        path: entryPath,
        mode: 0o120755,
        target: await readlink(fullPath),
      })
    }
  }
}
