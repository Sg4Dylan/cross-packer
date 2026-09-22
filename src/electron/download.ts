/**
 * Electron distribution download + cache + checksum validation.
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Arch, type NodePlatform } from '../shared/platform.ts'

export interface DownloadElectronOptions {
  version: string
  platform: NodePlatform
  arch: Arch
  mirror?: string
  cacheDir?: string
  expectedChecksum: string
}

/**
 * Compose the Electron distribution archive name for a target. The Electron
 * release artifacts use "x64" rather than "amd64" for the x86-64 architecture,
 * for example version "33.2.0" yields "electron-v33.2.0-win32-x64.zip".
 */
export function electronArchiveName(version: string, platform: NodePlatform, arch: Arch): string {
  const electronArch = arch === Arch.AMD64 ? 'x64' : arch
  return `electron-v${version}-${platform}-${electronArch}.zip`
}

/** Streams a file through sha256 and compares against the expected hex digest. */
export async function validateArchiveChecksum(
  archivePath: string,
  expectedChecksum: string,
): Promise<void> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archivePath)) {
    hash.update(chunk)
  }
  const actual = hash.digest('hex')
  if (actual !== expectedChecksum) {
    throw new Error(
      `Checksum mismatch for ${archivePath}: expected ${expectedChecksum}, got ${actual}`,
    )
  }
}

/** Download a file with cache support and return the cached archive path. */
export async function downloadElectron({
  version,
  platform,
  arch,
  mirror = 'https://github.com/electron/electron/releases/download/',
  cacheDir,
  expectedChecksum,
}: DownloadElectronOptions): Promise<string> {
  const zipName = electronArchiveName(version, platform, arch)
  const base = mirror.endsWith('/') ? mirror : `${mirror}/`
  const url = `${base}v${version}/${zipName}`

  const dir = cacheDir ?? path.join(process.cwd(), '.electron-cache')
  const cachePath = path.join(dir, zipName)

  if (existsSync(cachePath)) {
    try {
      await validateArchiveChecksum(cachePath, expectedChecksum)
      return cachePath
    } catch {
      rmSync(cachePath, { force: true })
    }
  }

  mkdirSync(dir, { recursive: true })
  const tmpPath = `${cachePath}.downloading`
  try {
    await downloadFile(url, tmpPath)
    await validateArchiveChecksum(tmpPath, expectedChecksum)
    renameSync(tmpPath, cachePath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
  return cachePath
}

/** Download a file while following redirects. No external dependencies. */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (current: string): void => {
      const client = current.startsWith('https') ? https : http
      client
        .get(current, { timeout: 300_000 }, (res) => {
          const statusCode = res.statusCode ?? 0
          if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
            follow(res.headers.location)
            return
          }
          if (statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${statusCode} from ${current}`))
            return
          }
          const file = createWriteStream(destPath)
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
          file.on('error', reject)
          res.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url)
  })
}
