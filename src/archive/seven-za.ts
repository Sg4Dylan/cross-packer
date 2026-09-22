/**
 * 7za / xz compression wrapper.
 * 7za is provided by the `7zip-bin` npm package, which is available on
 * every host operating system. On Linux, xz compression uses the system
 * `xz` executable when available.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import os from 'node:os'
import { path7za } from '7zip-bin'

const DEFAULT_7Z_LEVEL = 5

export interface CompressOptions {
  src: string
  dest: string
  format?: '7z' | 'xz'
  level?: number
  threads?: number
  solid?: boolean
  sevenZipPath?: string
}

export interface CompressResult {
  level: number
  threads: number
  solid: boolean
}

export function get7zaPath(): string {
  if (existsSync(path7za)) return path7za
  throw new Error(`7za not found: ${path7za}`)
}

/**
 * Parses `7z l` output for the total uncompressed size, used for the
 * NSIS ESTIMATED_SIZE define. Returns 0 when listing fails.
 */
export function computeEstimatedSize(sevenZipPath: string, archiveFile: string): number {
  const result = spawnSync(sevenZipPath, ['l', archiveFile], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
  if (result.status !== 0) return 0
  const output = (result.stdout || '').trim()
  const match = /(\d+)\s+\d+\s+\d+\s+files/.exec(output)
  return match ? Number.parseInt(match[1], 10) : 0
}

export function compress({
  src,
  dest,
  format = '7z',
  level = DEFAULT_7Z_LEVEL,
  threads,
  solid = false,
  sevenZipPath: sevenZipPathOption,
}: CompressOptions): CompressResult {
  const resolved = resolveCompressionOptions({ level, threads, solid })

  if (format === 'xz' && process.platform === 'linux' && hasSystemXz()) {
    compressWithSystemXz({ src, dest, level: resolved.level })
    return resolved
  }

  const sevenZipPath = sevenZipPathOption ?? get7zaPath()
  const { args, cwd } = build7zaAddArgs({ src, dest, format, ...resolved })

  const result = spawnSync(sevenZipPath, args, { cwd, stdio: 'pipe', windowsHide: true })
  if (result.status !== 0) {
    throwCompressionError(format, result)
  }
  return resolved
}

function resolveCompressionOptions(options: {
  level?: number
  threads?: number
  solid?: boolean
}): CompressResult {
  const level = clampLevel(options.level ?? DEFAULT_7Z_LEVEL)
  const threads = Math.max(1, options.threads ?? os.cpus().length)
  const solid = options.solid ?? false

  return { level, threads, solid }
}

export function build7zaAddArgs({
  src,
  dest,
  format = '7z',
  level,
  threads,
  solid,
}: {
  src: string
  dest: string
  format?: '7z' | 'xz'
  level: number
  threads: number
  solid: boolean
}): { args: string[]; cwd: string | undefined } {
  const formatArg = format === '7z' ? [] : [`-t${format}`]
  const srcArg = format === '7z' ? '.' : src
  const args = ['a', '-bd', `-mx=${level}`, ...formatArg, dest, srcArg]

  if (format === '7z') {
    args.splice(3, 0, `-mmt=${threads}`)
    if (!solid) {
      args.splice(3, 0, '-ms=off')
    }
  }

  return { args, cwd: format === '7z' ? src : undefined }
}

/** Clamp a compression level to the valid 0-9 range of 7z. */
function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return DEFAULT_7Z_LEVEL
  }
  return Math.min(9, Math.max(0, Math.trunc(level)))
}

function hasSystemXz(): boolean {
  const result = spawnSync('xz', ['--version'], { stdio: 'ignore', windowsHide: true })
  return result.status === 0
}

function compressWithSystemXz({
  src,
  dest,
  level,
}: {
  src: string
  dest: string
  level: number
}): void {
  const result = spawnSync('xz', [`-${level}`, '-k', '-f', src], {
    stdio: 'pipe',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throwCompressionError('xz', result)
  }
  const defaultDest = `${src}.xz`
  if (dest !== defaultDest) {
    renameSync(defaultDest, dest)
  }
}

function throwCompressionError(format: string, result: SpawnSyncReturns<Buffer>): never {
  if (result.error) {
    throw new Error(`${format} compression failed to spawn: ${result.error.message}`)
  }
  const stderr = result.stderr?.toString().trim() || ''
  const signal = result.signal ? `, signal ${result.signal}` : ''
  throw new Error(`${format} compression failed (exit ${result.status}${signal}): ${stderr}`)
}
