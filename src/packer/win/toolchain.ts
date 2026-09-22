/**
 * Download, sha512-verify, and extract 7z toolchain archives
 * (NSIS, nsis-resources).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { get7zaPath } from '../../archive/seven-za.ts'
import { downloadFile } from '../../electron/download.ts'
import { hashFile } from '../../shared/hash.ts'
import { logger } from '../../shared/logger.ts'

export async function downloadAndExtract7z({
  url,
  sha512,
  name,
  cacheDir,
  targetDir,
  validateExtracted,
}: {
  url: string
  sha512: string
  name: string
  cacheDir: string
  targetDir: string
  validateExtracted: (dir: string) => boolean
}): Promise<void> {
  const completeMarker = `${targetDir}.complete`

  if (existsSync(completeMarker) && validateExtracted(targetDir)) {
    return
  }

  const archivePath = path.join(cacheDir, `${name}.7z`)
  if (!existsSync(archivePath)) {
    const tmpPath = `${archivePath}.downloading`
    logger.info(`    Downloading ${name} from ${url} ...`)
    await downloadFile(url, tmpPath)
    renameSync(tmpPath, archivePath)
  }

  const hash = hashFile(archivePath, 'sha512', 'base64')
  if (hash !== sha512) {
    throw new Error(`Checksum mismatch for ${name}: expected ${sha512}, got ${hash}`)
  }

  mkdirSync(targetDir, { recursive: true })
  const sevenZipPath = get7zaPath()
  const result = spawnSync(sevenZipPath, ['x', '-bd', archivePath, `-o${targetDir}`, '-y'], {
    stdio: 'pipe',
    windowsHide: true,
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || ''
    throw new Error(`7z extraction failed for ${name} (exit ${result.status}): ${stderr}`)
  }

  if (!validateExtracted(targetDir)) {
    throw new Error(`Extraction of ${name} did not produce expected files in ${targetDir}`)
  }

  writeFileSync(completeMarker, '')
}
