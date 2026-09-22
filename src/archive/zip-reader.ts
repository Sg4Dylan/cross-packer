/**
 * Reads a zip archive (Electron distributions) preserving Unix permissions
 * so symlinks and setuid bits survive repacking.
 */
import { readFile } from 'node:fs/promises'
import type { JSZipObject } from 'jszip'
import JSZip from 'jszip'

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

export interface ZipEntry {
  path: string
  dir: boolean
  symlink: boolean
  mode: string | number
  entry: JSZipObject
}

export async function readZip(zipPath: string): Promise<{ entries: ZipEntry[]; zip: JSZip }> {
  const data = await readFile(zipPath)
  const zip = await JSZip.loadAsync(data)

  const entries: ZipEntry[] = []
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    const unixPerms = Number(entry.unixPermissions || 0)
    const fileType = unixPerms & S_IFMT

    entries.push({
      path: entryPath,
      dir: entry.dir,
      symlink: fileType === S_IFLNK,
      mode: unixPerms,
      entry,
    })
  }

  return { entries, zip }
}

export async function getEntryBuffer(entry: JSZipObject): Promise<Buffer> {
  return entry.async('nodebuffer')
}

export async function getSymlinkTarget(entry: JSZipObject): Promise<string> {
  return entry.async('text')
}

export function isSymlink(zipEntry: ZipEntry): boolean {
  return (Number(zipEntry.mode) & S_IFMT) === S_IFLNK
}

export function isDefaultAppEntry(entryPath: string): boolean {
  return (
    entryPath === 'resources/app' ||
    entryPath.startsWith('resources/app/') ||
    entryPath === 'resources/default_app.asar' ||
    entryPath === 'Electron.app/Contents/Resources/app' ||
    entryPath.startsWith('Electron.app/Contents/Resources/app/')
  )
}
