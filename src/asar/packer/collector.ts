import { existsSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../../shared/logger.ts'
import type { NodePlatform } from '../../shared/platform.ts'
import type { DependencyEntry, FileFilter, FileSet, FileVisitor } from '../../shared/types.ts'
import { collectProductionDeps } from '../dependency/collect.ts'
import { createTransformer } from '../fileset/transformer.ts'
import { collectAppFileSet } from './app-collector.ts'
import { collectNodeModuleFiles } from './nm-collector.ts'

export interface CollectAllFilesOptions {
  platform: NodePlatform
  /** Directory under projectDir holding the built app (e.g. "out" for electron-vite). */
  appDistDir: string
  includePdb: boolean
  disableDefaultIgnoredFiles: boolean
  workspaceRoot?: string
  extraMetadata?: Record<string, unknown>
  nodeModuleFileFilter?: FileFilter
  onNodeModuleFile?: FileVisitor
}

export async function collectAllFiles(
  projectDir: string,
  {
    platform,
    appDistDir,
    includePdb,
    disableDefaultIgnoredFiles,
    workspaceRoot,
    extraMetadata,
    nodeModuleFileFilter,
    onNodeModuleFile,
  }: CollectAllFilesOptions,
): Promise<{
  appFileSet: FileSet
  nmFileSets: FileSet[]
  transformer: (file: string) => Promise<string | null> | string | null
}> {
  const distDir = path.join(projectDir, appDistDir)
  if (!existsSync(distDir)) {
    throw new Error(
      `${appDistDir}/ directory not found. Build the app first, or set files.appDistDir in the config.`,
    )
  }

  logger.info(`    Collecting app files (${appDistDir}/ + package.json) ...`)
  const appFileSet = await collectAppFileSet(projectDir, distDir, includePdb)
  logger.info(`    App files: ${appFileSet.files.length} entries`)

  logger.info('    Collecting production node_modules ...')
  const nmFileSets = await collectNodeModuleFileSets(projectDir, {
    platform,
    includePdb,
    disableDefaultIgnoredFiles,
    workspaceRoot,
    filter: nodeModuleFileFilter,
    onNodeModuleFile,
  })
  logger.info(`    node_modules fileSets: ${nmFileSets.length}`)

  const transformer = createTransformer(projectDir, extraMetadata)

  return { appFileSet, nmFileSets, transformer }
}

interface CollectNodeModuleFileSetsOptions {
  platform: NodePlatform
  includePdb: boolean
  disableDefaultIgnoredFiles: boolean
  workspaceRoot?: string
  filter?: FileFilter
  onNodeModuleFile?: FileVisitor
}

async function collectNodeModuleFileSets(
  projectDir: string,
  {
    platform,
    includePdb,
    disableDefaultIgnoredFiles,
    workspaceRoot,
    filter,
    onNodeModuleFile,
  }: CollectNodeModuleFileSetsOptions,
): Promise<FileSet[]> {
  const nmDir = path.join(projectDir, 'node_modules')
  if (!existsSync(nmDir)) {
    return []
  }

  const productionPackages = await collectProductionDeps(projectDir, workspaceRoot)
  logger.info(`    Production packages: ${productionPackages.length}`)

  const result: FileSet[] = []

  const collectModule = async (dep: DependencyEntry, parentDestination: string): Promise<void> => {
    const pkgDir = dep.dir
    if (!pkgDir || !existsSync(pkgDir)) return

    const NODE_MODULES = 'node_modules'
    const destination = path.join(parentDestination, NODE_MODULES, dep.name)

    const { files: pkgFiles, metadata: pkgMeta } = await collectNodeModuleFiles(
      pkgDir,
      dep.name,
      destination,
      platform,
      includePdb,
      disableDefaultIgnoredFiles,
      filter,
      onNodeModuleFile,
    )

    result.push({
      src: pkgDir,
      destination,
      files: pkgFiles,
      metadata: pkgMeta,
    })

    if (dep.dependencies && dep.dependencies.length > 0) {
      for (const child of dep.dependencies) {
        await collectModule(child, destination)
      }
    }
  }

  for (const dep of productionPackages) {
    await collectModule(dep, projectDir)
  }

  return result
}
