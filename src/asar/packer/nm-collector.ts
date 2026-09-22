import fs from 'node:fs'
import path from 'node:path'
import fsExtra from 'fs-extra'
import { NodePlatform } from '../../shared/platform.ts'
import {
  EntryKind,
  entryKind,
  type FileFilter,
  type FileStat,
  type FileVisitor,
} from '../../shared/types.ts'
import { excludedExts, excludedFiles, topLevelExcludedFiles } from '../fileset/matcher.ts'

export function getNodeModuleExcludedExts(platform: NodePlatform, includePdb: boolean): string[] {
  const result = ['.o', '.obj'].concat(excludedExts.split(',').map((it) => `.${it}`))
  if (includePdb !== true) {
    result.push('.pdb')
  }
  if (platform !== NodePlatform.WIN32) {
    result.push('.dll')
    result.push('.exe')
  }
  return result
}

export async function collectNodeModuleFiles(
  moduleDir: string,
  moduleName: string,
  moduleRootPath: string,
  platform: NodePlatform,
  includePdb: boolean,
  disableDefaultIgnoredFiles: boolean,
  filter: FileFilter | undefined = undefined,
  onNodeModuleFile: FileVisitor | undefined = undefined,
): Promise<{ files: string[]; metadata: Map<string, FileStat> }> {
  const nodeModuleExcludedExts = getNodeModuleExcludedExts(platform, includePdb)
  const metadata = new Map<string, FileStat>()
  const result: (string | undefined)[] = []
  const queue: string[] = []
  const emptyDirs = new Set<string>()
  const symlinkFiles = new Map<string, number>()
  const depPath = path.normalize(moduleDir)
  queue.push(depPath)

  while (queue.length > 0) {
    const dirPath = queue.pop()
    if (dirPath === undefined) continue
    let childNames: string[]
    try {
      childNames = await fsExtra.readdir(dirPath)
    } catch {
      continue
    }
    childNames.sort()
    const isTopLevel = dirPath === depPath
    const dirs: string[] = []
    let isEmpty = true

    for (const name of childNames) {
      const filePath = path.join(dirPath, name)
      const forceIncluded = onNodeModuleFile != null && !!onNodeModuleFile(filePath)
      if (excludedFiles.has(name) || name.startsWith('._')) {
        if (!forceIncluded) continue
      }
      const dirStat = await fsExtra.lstat(dirPath).catch(() => null)
      const dirKind = dirStat != null ? entryKind(dirStat) : null
      const fileMatched =
        filter != null && dirStat != null && dirKind !== null
          ? filter(dirPath, { type: dirKind, size: dirStat.size, mode: dirStat.mode })
          : false
      if (!fileMatched || !forceIncluded || disableDefaultIgnoredFiles) {
        let excluded = false
        for (const ext of nodeModuleExcludedExts) {
          if (name.endsWith(ext)) {
            excluded = true
            break
          }
        }
        if (excluded) continue
        if (
          isTopLevel &&
          (topLevelExcludedFiles.has(name) ||
            (moduleName === 'libui-node' &&
              (name === 'build' || name === 'docs' || name === 'src')))
        ) {
          continue
        }
        if (dirPath.endsWith('build')) {
          if (
            name === 'gyp-mac-tool' ||
            name === 'Makefile' ||
            name.endsWith('.mk') ||
            name.endsWith('.gypi') ||
            name.endsWith('.Makefile')
          ) {
            continue
          }
        } else if (dirPath.endsWith('Release') && (name === '.deps' || name === 'obj.target')) {
          continue
        } else if (
          name === 'src' &&
          (dirPath.endsWith('keytar') || dirPath.endsWith('keytar-prebuild'))
        ) {
          continue
        } else if (dirPath.endsWith('lzma-native') && (name === 'build' || name === 'deps')) {
          continue
        }
      }

      let lstat: fs.Stats
      try {
        lstat = await fsExtra.lstat(filePath)
      } catch {
        continue
      }
      const type = entryKind(lstat)
      if (type === null) continue
      const stat: FileStat = {
        type,
        size: lstat.size,
        mode: lstat.mode,
        moduleName,
        moduleRootPath,
        moduleFullFilePath: path.join(moduleRootPath, path.relative(depPath, filePath)),
      }

      if (filter != null && stat.type !== 'directory' && !filter(filePath, stat)) {
        continue
      }

      if (stat.type === EntryKind.LINK) {
        let linkTarget: string
        try {
          linkTarget = await fsExtra.readlink(filePath)
        } catch {
          continue
        }
        const resolvedLinkTarget = path.resolve(dirPath, linkTarget)
        const link = path.relative(depPath, resolvedLinkTarget)
        if (link.startsWith('..')) {
          try {
            const targetStat = await fsExtra.stat(resolvedLinkTarget)
            const targetType = entryKind(targetStat)
            if (targetType !== null) {
              metadata.set(filePath, {
                type: targetType,
                size: targetStat.size,
                mode: targetStat.mode,
              })
              result.push(filePath)
              isEmpty = false
            }
          } catch {
            // Skip broken external symlinks.
          }
        } else {
          stat.relativeLink = link
          stat.linkRelativeToFile = path.relative(dirPath, resolvedLinkTarget)
          result.push(filePath)
          symlinkFiles.set(filePath, result.length - 1)
          isEmpty = false
        }
      } else if (stat.type === EntryKind.DIRECTORY) {
        metadata.set(filePath, stat)
        dirs.push(name)
        isEmpty = false
      } else {
        metadata.set(filePath, stat)
        result.push(filePath)
        isEmpty = false
      }
    }
    if (isEmpty) {
      emptyDirs.add(dirPath)
    }
    dirs.sort()
    for (const child of dirs) {
      queue.push(dirPath + path.sep + child)
    }
  }

  for (const [file, index] of symlinkFiles) {
    let resolvedPath: string
    try {
      resolvedPath = fs.realpathSync(file)
    } catch {
      continue
    }
    if (emptyDirs.has(resolvedPath)) {
      result[index] = undefined
    }
  }
  return { files: result.filter((it): it is string => it !== undefined), metadata }
}
