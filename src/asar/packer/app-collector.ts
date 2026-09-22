import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { Minimatch } from 'minimatch'
import { entryKind, type FileSet, type FileStat } from '../../shared/types.ts'
import { createFilter, excludedExts, excludedNames } from '../fileset/matcher.ts'
import { walkDirectory } from '../fileset/walker.ts'

export async function collectAppFileSet(
  projectDir: string,
  distDir: string,
  includePdb: boolean,
): Promise<FileSet> {
  const metadata = new Map<string, FileStat>()
  const files: string[] = []

  walkDirectory(distDir, files, metadata, projectDir)

  const pkgJsonPath = path.join(projectDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    const stat = await lstat(pkgJsonPath)
    const type = entryKind(stat)
    if (type === null) {
      throw new Error(`package.json is not a regular file: ${pkgJsonPath}`)
    }
    files.push(pkgJsonPath)
    metadata.set(pkgJsonPath, { type, size: stat.size, mode: stat.mode })
  }

  const patterns = computeAppPatterns(projectDir, includePdb)
  const appFilter = createFilter(projectDir, patterns)

  const filtered = files.filter((f) => {
    if (f === projectDir) return true
    const stat = metadata.get(f)
    if (!stat) return false
    return appFilter(f, stat)
  })
  const filteredMetadata = new Map<string, FileStat>()
  for (const f of filtered) {
    const m = metadata.get(f)
    if (m) filteredMetadata.set(f, m)
  }

  filtered.sort()
  return {
    src: projectDir,
    destination: projectDir,
    files: filtered,
    metadata: filteredMetadata,
  }
}

function computeAppPatterns(src: string, includePdb: boolean): Minimatch[] {
  const patterns: Minimatch[] = []
  patterns.push(new Minimatch('**/*', { dot: true }))
  patterns.push(new Minimatch('!**/node_modules/**', { dot: true }))
  const relativeOutDir = path.relative(src, path.join(src, '..', 'dist'))
  if (relativeOutDir.length !== 0 && !relativeOutDir.startsWith('.')) {
    patterns.push(new Minimatch(`!${relativeOutDir}{,/**/*}`, { dot: true }))
  }
  const effectiveExts = includePdb === true ? excludedExts : `${excludedExts},pdb`
  patterns.push(new Minimatch(`!**/*.{${effectiveExts}}`, { dot: true }))
  patterns.push(new Minimatch('!**/._*', { dot: true }))
  patterns.push(new Minimatch('!**/electron-builder.{yaml,yml,json,json5,toml,ts}', { dot: true }))
  const excludedNamesList = excludedNames.split(',')
  for (const name of excludedNamesList) {
    patterns.push(new Minimatch(`!**/${name}`, { dot: true }))
  }
  patterns.push(new Minimatch('!.yarn{,/**/*}', { dot: true }))
  patterns.push(new Minimatch('!.editorconfig', { dot: true }))
  patterns.push(new Minimatch('!.yarnrc.yml', { dot: true }))
  return patterns
}
