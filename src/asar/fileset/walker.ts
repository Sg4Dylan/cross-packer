import { type Dirent, existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import type { FileStat } from '../../shared/types.ts'
import { EntryKind, entryKind } from '../../shared/types.ts'

export function walkDirectory(
  dirPath: string,
  files: string[],
  metadata: Map<string, FileStat>,
  projectDir: string,
): void {
  if (!existsSync(dirPath)) return

  let entries: Dirent[]
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(fullPath)
    } catch {
      continue
    }

    const type = entryKind(stat)
    if (type === null) continue

    const meta: FileStat = { type, size: stat.size, mode: stat.mode }

    const nodeModulesIdx = fullPath.lastIndexOf(`${path.sep}node_modules${path.sep}`)
    if (nodeModulesIdx !== -1) {
      const afterNodeModules = fullPath.slice(nodeModulesIdx + '/node_modules/'.length)
      const moduleName = afterNodeModules.split(path.sep)[0]
      if (moduleName.startsWith('@')) {
        const scopedName = afterNodeModules.split(path.sep).slice(0, 2).join(path.sep)
        meta.moduleRootPath = fullPath.slice(
          0,
          nodeModulesIdx + '/node_modules/'.length + scopedName.length,
        )
        meta.moduleName = scopedName
      } else {
        meta.moduleRootPath = fullPath.slice(
          0,
          nodeModulesIdx + '/node_modules/'.length + moduleName.length,
        )
        meta.moduleName = moduleName
      }
      meta.moduleFullFilePath = fullPath
    }

    if (meta.type === EntryKind.LINK) {
      let linkTarget: string
      try {
        linkTarget = readlinkSync(fullPath)
      } catch {
        continue
      }
      const resolvedLinkTarget = path.resolve(dirPath, linkTarget)
      const link = path.relative(projectDir, resolvedLinkTarget)
      if (link.startsWith('..')) {
        try {
          const targetStat = statSync(resolvedLinkTarget)
          const targetType = entryKind(targetStat)
          if (targetType === null) continue
          metadata.set(fullPath, {
            type: targetType,
            size: targetStat.size,
            mode: targetStat.mode,
          })
          files.push(fullPath)
          continue
        } catch {
          continue
        }
      }
      meta.relativeLink = link
      meta.linkRelativeToFile = path.relative(dirPath, resolvedLinkTarget)
    }

    files.push(fullPath)
    metadata.set(fullPath, meta)

    if (meta.type === EntryKind.DIRECTORY) {
      walkDirectory(fullPath, files, metadata, projectDir)
    }
  }
}

export function mergeFileSets(
  set1: { files: string[]; metadata: Map<string, FileStat> },
  set2: { files: string[]; metadata: Map<string, FileStat> },
): { files: string[]; metadata: Map<string, FileStat> } {
  const metadata = new Map([...set1.metadata, ...set2.metadata])
  const fileSet = new Set([...set1.files, ...set2.files])
  const files = Array.from(fileSet).sort()
  return { files, metadata }
}

/** Derive the deepest common ancestor directory of a file list. */
export function deriveProjectDir(files: string[]): string {
  if (files.length === 0) return process.cwd()
  let prefix = files[0]
  for (const f of files) {
    while (!f.startsWith(prefix + path.sep) && f !== prefix) {
      prefix = path.dirname(prefix)
    }
  }
  return prefix
}
