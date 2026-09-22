import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { readZip } from '../archive/zip-reader.ts'
import type { Arch, NodePlatform } from '../shared/platform.ts'
import { downloadElectron, electronArchiveName } from './download.ts'

interface ElectronZipConfig {
  electronVersion: string
  electronMirror?: string
  checksums?: Record<string, string>
  cacheDir?: string
}

/**
 * Download (with cache) and read the Electron distribution zip for a target.
 *
 * Checksums are resolved from the electron package's checksums.json when
 * present; otherwise the caller provides config.checksums keyed by archive name.
 */
export async function downloadAndReadElectron(
  platform: NodePlatform,
  arch: Arch,
  config: ElectronZipConfig,
) {
  const expectedChecksum = await resolveChecksum(config, platform, arch)
  const zipPath = await downloadElectron({
    version: config.electronVersion,
    platform,
    arch,
    mirror: config.electronMirror,
    cacheDir: config.cacheDir,
    expectedChecksum,
  })
  const { entries } = await readZip(zipPath)
  return { zipPath, entries }
}

async function resolveChecksum(
  config: ElectronZipConfig,
  platform: NodePlatform,
  arch: Arch,
): Promise<string> {
  const archiveName = electronArchiveName(config.electronVersion, platform, arch)

  if (config.checksums?.[archiveName]) {
    return config.checksums[archiveName]
  }

  try {
    const require = createRequire(import.meta.url)
    const checksumsPath = require.resolve('electron/checksums.json', {
      paths: [process.cwd()],
    })
    const checksums = JSON.parse(await readFile(checksumsPath, 'utf8')) as Record<string, string>
    if (!checksums[archiveName]) {
      throw new Error(`No official checksum for ${archiveName}`)
    }
    return checksums[archiveName]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Cannot verify Electron archive ${archiveName}: ${message}. Install the "electron" package in the target project or provide config.checksums.`,
    )
  }
}
