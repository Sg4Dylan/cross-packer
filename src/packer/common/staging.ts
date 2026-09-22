/**
 * Per-target staging directory creation and removal, shared by the platform
 * packers.
 */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../shared/logger.ts'
import type { Arch } from '../../shared/platform.ts'

export async function createStagingDir(
  outputDir: string,
  label: string,
  arch: Arch,
): Promise<string> {
  const stagingDir = path.join(outputDir, `cross-packer-${label}-${arch}-staging`)
  await mkdir(stagingDir, { recursive: true })
  return stagingDir
}

export async function removeStagingDir(stagingDir: string): Promise<void> {
  try {
    await rm(stagingDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 1000,
    })
  } catch (err) {
    logger.warn(
      `Could not remove staging directory ${stagingDir}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
