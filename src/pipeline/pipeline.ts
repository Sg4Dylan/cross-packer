/**
 * Main packaging pipeline: validate, collect the payload, then pack each target.
 *
 * Targets run concurrently; a target failure is captured and reported
 * without aborting the remaining targets.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setPrebuiltDirResolver } from '../asar/fileset/platform-fileset.ts'
import { collectProjectFiles, packAsarForTarget } from '../asar/pack.ts'
import type { NormalizedConfig } from '../config/index.ts'
import { removeStagingDir } from '../packer/common/staging.ts'
import { createLogger } from '../shared/logger.ts'
import type { Arch, Platform } from '../shared/platform.ts'
import type { FileSet } from '../shared/types.ts'
import { type PackTarget, runPlatformPackers } from './targets.ts'

export interface PackResult {
  ok: boolean
  outputDir: string
  targets: TargetResult[]
}

export interface PipelineOptions {
  platforms: Platform[]
  arches: Arch[]
  output: string
  dryRun: boolean
  onTargetComplete?: (result: TargetResult) => void
}

export interface TargetResult {
  platform: Platform
  arch: Arch
  output?: string
  error?: string
}

export interface TargetSpec {
  platform: Platform
  arches?: Arch[]
  config?: (config: NormalizedConfig) => NormalizedConfig
}

interface CollectedProjectFiles {
  appFileSet: FileSet
  nmFileSets: FileSet[]
  transformer: (file: string) => Promise<string | null> | string | null
}

interface SharedState {
  collectPromise?: Promise<CollectedProjectFiles>
}

export async function resolveAsarForTarget(
  target: PackTarget,
  config: NormalizedConfig,
  outputDir: string,
  shared: SharedState,
) {
  if (config.asar?.path) {
    return {
      asarPath: path.resolve(config.projectDir, config.asar.path),
      unpackedDir: config.asar.unpackedDir
        ? path.resolve(config.projectDir, config.asar.unpackedDir)
        : undefined,
    }
  }

  if (!shared.collectPromise) {
    shared.collectPromise = collectProjectFiles(config.projectDir, config)
  }
  const { appFileSet, nmFileSets, transformer } = await shared.collectPromise

  const stagingDir = path.join(outputDir, 'cross-packer-asar-staging')
  await mkdir(stagingDir, { recursive: true })
  return packAsarForTarget({
    platform: target.platform,
    arch: target.arch,
    appFileSet,
    nmFileSets: nmFileSets ?? [],
    transformer: transformer ?? (() => null),
    config,
    projectDir: config.projectDir,
    stagingDir,
  })
}

export async function runPack(
  config: NormalizedConfig,
  options: PipelineOptions,
  targetSpecs?: TargetSpec[],
): Promise<PackResult> {
  const { dryRun } = options
  const logger = createLogger()

  setPrebuiltDirResolver(config.nativeModules?.prebuiltRules ?? null)

  const outputDir = resolveOutputDir(config, options)
  await mkdir(outputDir, { recursive: true })
  const results: TargetResult[] = []

  if (dryRun) {
    logger.info('Dry run: config validated, targets resolved, no build performed.')
    for (const platform of options.platforms) {
      for (const arch of options.arches) {
        const entry = { platform, arch, output: '(dry-run)' }
        results.push(entry)
        options.onTargetComplete?.(entry)
      }
    }
    return { ok: true, outputDir, targets: results }
  }

  const targets = runPlatformPackers({ config, options, outputDir, targetSpecs })

  // State shared across targets: project file collection runs only once.
  const shared: SharedState = {}

  const settled = await Promise.all(
    targets.map(async (target: PackTarget) => {
      try {
        const asar = await resolveAsarForTarget(target, config, outputDir, shared)
        const output = await target.run(asar)
        return { platform: target.platform, arch: target.arch, output }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`${target.platform}-${target.arch}: ${message}`)
        return { platform: target.platform, arch: target.arch, error: message }
      }
    }),
  )

  for (const entry of settled) {
    options.onTargetComplete?.(entry)
  }

  const stagingDir = path.join(outputDir, 'cross-packer-asar-staging')
  await removeStagingDir(stagingDir)

  results.push(...settled)
  return { ok: !results.some((r) => r.error), outputDir, targets: results }
}

function resolveOutputDir(config: NormalizedConfig, options: PipelineOptions): string {
  if (options.output) return path.resolve(options.output)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(config.projectDir, 'dist', `cross-packer-${stamp}`)
}
