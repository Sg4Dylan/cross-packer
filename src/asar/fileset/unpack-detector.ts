import type { FileStat } from '../../shared/types.ts'

/**
 * Check whether a file is a native binary library or executable that
 * should be unpacked from the asar archive by default.
 */
export function isLibOrExe(file: string): boolean {
  return (
    file.endsWith('.dll') ||
    file.endsWith('.exe') ||
    file.endsWith('.dylib') ||
    file.endsWith('.so') ||
    file.endsWith('.node')
  )
}

export function detectUnpackedDirs(
  fileSet: { files: string[]; metadata: Map<string, FileStat> },
  autoUnpackDirs: Set<string>,
): void {
  const metadata = fileSet.metadata
  for (let i = 0, n = fileSet.files.length; i < n; i++) {
    const file = fileSet.files[i]
    const stat = metadata.get(file)
    if (!stat?.moduleRootPath || autoUnpackDirs.has(stat.moduleRootPath)) continue
    if (stat.type !== 'file') continue

    let shouldUnpack = false
    const moduleName = stat.moduleName

    if (moduleName === 'ffprobe-static' || moduleName === 'ffmpeg-static' || isLibOrExe(file)) {
      shouldUnpack = true
    }

    if (!shouldUnpack) continue
    autoUnpackDirs.add(stat.moduleRootPath)
  }
}
