import os from 'node:os'
import path from 'node:path'
import { Minimatch } from 'minimatch'
import type { NormalizedConfig } from '../config/index.ts'
import { logger } from '../shared/logger.ts'
import { type Arch, NodePlatform, nodePlatformOf, Platform } from '../shared/platform.ts'
import type { FileFilter, FileSet, FileStat, JsonObject } from '../shared/types.ts'
import { createFilter, hasMagic } from './fileset/matcher.ts'
import { derivePlatformFileSet } from './fileset/platform-fileset.ts'
import { collectAllFiles } from './packer/collector.ts'
import { mapWithConcurrency } from './packer/concurrency.ts'
import { packAsarFromFileSets } from './packer/stream-builder.ts'

const TRANSFORM_CONCURRENCY = Number(
  process.env.CROSS_PACKER_ASAR_TRANSFORM_CONCURRENCY ?? Math.max(4, os.cpus().length),
)

const PLATFORM_NAMES: Record<Platform, NodePlatform> = {
  [Platform.WIN]: NodePlatform.WIN32,
  [Platform.MAC]: NodePlatform.DARWIN,
  [Platform.LINUX]: NodePlatform.LINUX,
}

/** A FileSet plus the transformed contents collected during packing. */
interface PackedFileSet extends FileSet {
  transformedFiles?: Map<number, string>
}

type Transformer = (file: string) => Promise<string | null> | string | null

/** A files-config entry: either a glob string or a mapping object with a filter. */
interface FilesConfigEntry {
  from?: string
  filter?: string | string[]
}

export async function collectProjectFiles(projectDir: string, config: NormalizedConfig) {
  const nodeModuleFileFilter = createNodeModuleFileFilter(config.files, projectDir)

  logger.info('\n  Collecting all files (single traversal) ...')
  const hostPlatform = nodePlatformOf(process.platform)
  const { appFileSet, nmFileSets, transformer } = await collectAllFiles(projectDir, {
    platform: hostPlatform,
    appDistDir: config.appDistDir,
    includePdb: false,
    disableDefaultIgnoredFiles: config.disableDefaultIgnoredFiles ?? false,
    workspaceRoot: projectDir,
    extraMetadata: config.extraMetadata,
    nodeModuleFileFilter: nodeModuleFileFilter,
    onNodeModuleFile: config.onNodeModuleFile,
  })
  logger.info(`  App files: ${appFileSet.files.length} entries`)
  logger.info(`  node_modules fileSets: ${nmFileSets.length}`)

  return { appFileSet, nmFileSets, transformer }
}

export async function packAsarForTarget({
  platform,
  arch,
  appFileSet,
  nmFileSets,
  transformer,
  config,
  projectDir,
  stagingDir,
}: {
  platform: Platform
  arch: Arch
  appFileSet: FileSet
  nmFileSets: FileSet[]
  transformer: Transformer
  config: NormalizedConfig
  projectDir: string
  stagingDir: string
}) {
  const platformName = PLATFORM_NAMES[platform]
  const asarOutputPath = path.join(stagingDir, `app-${platform}-${arch}.asar`)

  const label = `${platform}-${arch}`
  logger.info(`  [${label}] Deriving platform file set ...`)
  const platformAppFileSet = derivePlatformFileSet(appFileSet, platformName, arch, projectDir)
  const platformNmFileSets = nmFileSets.map((s) =>
    derivePlatformFileSet(s, platformName, arch, projectDir),
  )
  const allFileSets: PackedFileSet[] = [platformAppFileSet, ...platformNmFileSets]
  logger.info(`  [${label}] Total fileSets: ${allFileSets.length}`)

  interface TransformTask {
    fileSet: PackedFileSet
    index: number
    file: string
    fileStat: FileStat
  }
  const transformTasks: TransformTask[] = []
  for (const fileSet of allFileSets) {
    fileSet.transformedFiles = new Map()
    for (let i = 0; i < fileSet.files.length; i++) {
      const file = fileSet.files[i]
      const fileStat = fileSet.metadata.get(file)
      if (fileStat?.type !== 'file') continue
      transformTasks.push({ fileSet, index: i, file, fileStat })
    }
  }

  await mapWithConcurrency(
    transformTasks,
    TRANSFORM_CONCURRENCY,
    async ({ fileSet, index, file, fileStat }: TransformTask) => {
      const fileToRead = fileStat.realFilePath || file
      const transformedValue = await transformer(fileToRead)
      if (transformedValue != null) {
        fileSet.transformedFiles?.set(index, transformedValue)
      }
    },
  )

  const packStartedAt = performance.now()
  logger.info(`  [${label}] Packing asar ...`)
  const { asarPath, unpackedDir } = await packAsarFromFileSets(allFileSets, {
    outputPath: asarOutputPath,
    unpackPattern: createAsarUnpackFilter(config.asarUnpack, projectDir),
    smartUnpack: config.smartUnpack,
    defaultDestination: projectDir,
    workspaceRoot: projectDir,
  })
  const packElapsedSec = ((performance.now() - packStartedAt) / 1000).toFixed(1)
  logger.info(`  [${label}] app.asar: ${asarPath} (${packElapsedSec}s)`)

  return { asarPath, unpackedDir }
}

function isFilesConfigEntry(value: unknown): value is FilesConfigEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collect exclusion patterns from a files config entry. */
function addPatterns(patterns: unknown, excludePatterns: string[]): void {
  if (patterns == null) return
  if (!Array.isArray(patterns)) {
    if (typeof patterns === 'string' && patterns.startsWith('!')) {
      excludePatterns.push(patterns)
    }
    return
  }
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (pattern.startsWith('!')) {
        excludePatterns.push(pattern)
      }
    } else if (isFilesConfigEntry(pattern) && (pattern.from == null || pattern.from === '.')) {
      const filter = pattern.filter
      const filterList = Array.isArray(filter) ? filter : typeof filter === 'string' ? [filter] : []
      for (const p of filterList) {
        excludePatterns.push(p)
      }
    }
  }
}

function buildMinimatchPatterns(patterns: string[]): Minimatch[] {
  const parsedPatterns: Minimatch[] = []
  for (const pattern of patterns) {
    const parsedPattern = new Minimatch(pattern, { dot: true })
    parsedPatterns.push(parsedPattern)
    if (!pattern.includes('.') && !pattern.startsWith('!') && !hasMagic(parsedPattern)) {
      parsedPatterns.push(new Minimatch(`${pattern}/**/*`, { dot: true }))
    }
  }
  return parsedPatterns
}

function createAsarUnpackFilter(patterns: string[], baseDir: string): FileFilter {
  return createFilter(baseDir, buildMinimatchPatterns(patterns))
}

function createNodeModuleFileFilter(
  filesConfig: JsonObject | undefined,
  baseDir: string,
): FileFilter | undefined {
  const excludePatterns: string[] = []
  addPatterns(filesConfig, excludePatterns)
  if (excludePatterns.length === 0) return undefined
  const allPatterns = ['**/*', ...excludePatterns.map((p) => (p.startsWith('!') ? p : `!${p}`))]
  return createFilter(baseDir, buildMinimatchPatterns(allPatterns))
}
