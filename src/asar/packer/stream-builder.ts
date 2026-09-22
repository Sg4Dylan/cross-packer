import crypto from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import {
  access,
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  readlink as readlinkAsync,
  realpath as realpathAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { EntryKind, type FileFilter, type FileSet, type FileStat } from '../../shared/types.ts'
import { detectUnpackedDirs } from '../fileset/unpack-detector.ts'
import { mapWithConcurrency } from './concurrency.ts'

const SYSTEM_DENYLIST = [
  '/usr',
  '/lib',
  '/bin',
  '/sbin',
  '/etc',
  '/tmp',
  '/var',
  '/System',
  '/Library',
  '/private',
]
const SMALL_FILE_THRESHOLD = Number(
  process.env.CROSS_PACKER_ASAR_SMALL_FILE_THRESHOLD ?? 512 * 1024,
)
const INTEGRITY_CONCURRENCY = Number(
  process.env.CROSS_PACKER_ASAR_INTEGRITY_CONCURRENCY ?? Math.max(4, os.cpus().length),
)

/** A fileSet plus transformed contents collected during packing. */
interface PackedFileSet extends FileSet {
  transformedFiles?: Map<number, string>
}

interface IntegrityInfo {
  algorithm: 'SHA256'
  hash: string
  blockSize: number
  blocks: string[]
}

interface HeaderDirNode {
  files: Record<string, HeaderNode>
  unpacked?: boolean
}

interface HeaderFileNode {
  size: number
  offset?: string
  unpacked?: boolean
  integrity?: IntegrityInfo
}

interface HeaderLinkNode {
  link: string
}

type HeaderNode = HeaderDirNode | HeaderFileNode | HeaderLinkNode

type DirectoryStream = { type: EntryKind.DIRECTORY; path: string; unpacked: boolean }
type FileStream = {
  type: EntryKind.FILE
  path: string
  unpacked: boolean
  file?: string
  data?: Buffer
  stat: FileStat
}
type LinkStream = {
  type: EntryKind.LINK
  path: string
  unpacked: boolean
  file: string
  symlink: string
  stat: FileStat
}
type FileStreamEntry = DirectoryStream | FileStream | LinkStream

interface DataEntry {
  type: 'buffer' | 'file'
  data?: Buffer
  path?: string
  size: number
  pending?: boolean
}

interface PendingFileIntegrity {
  fileEntry: HeaderFileNode
  dataEntry: DataEntry
}

// Module-level cache for the resolved workspace root, keyed by its raw path.
let cachedWorkspaceRootPath: string | null | undefined = null
let cachedResolvedWorkspaceRoot: string | undefined

const DENYLIST: Promise<string[]> = resolvePaths([
  ...SYSTEM_DENYLIST,
  process.env.SystemRoot,
  process.env.WINDIR,
])

const ALLOWLIST: Promise<string[]> = resolvePaths([os.tmpdir(), os.homedir()])

export interface PackAsarOptions {
  outputPath: string
  unpackPattern?: FileFilter
  smartUnpack?: boolean
  unpackDirs?: string[]
  defaultDestination?: string
  workspaceRoot?: string
}

export async function packAsarFromFileSets(
  fileSets: PackedFileSet[],
  options: PackAsarOptions,
): Promise<{ asarPath: string; unpackedDir: string | undefined }> {
  const {
    outputPath,
    unpackPattern,
    smartUnpack = true,
    unpackDirs = [],
    defaultDestination,
    workspaceRoot,
  } = options

  const autoUnpackDirs = new Set<string>(unpackDirs)
  if (smartUnpack) {
    for (const fileSet of fileSets) {
      detectUnpackedDirs({ files: fileSet.files, metadata: fileSet.metadata }, autoUnpackDirs)
    }
  }

  const normalizedUnpackedPaths = Array.from(autoUnpackDirs).map((p) =>
    defaultDestination ? path.normalize(path.relative(defaultDestination, p)) : path.normalize(p),
  )
  const streams = await buildStreamsFromSets(
    fileSets,
    normalizedUnpackedPaths,
    unpackPattern,
    defaultDestination,
    workspaceRoot,
  )

  await executeElectronAsar(outputPath, streams)

  const unpackedDir = existsSync(`${outputPath}.unpacked`) ? `${outputPath}.unpacked` : undefined
  return { asarPath: outputPath, unpackedDir }
}

function getDestinationPath(file: string, fileSet: { src: string; destination: string }): string {
  if (file === fileSet.src) return fileSet.destination
  if (file.startsWith(fileSet.src)) {
    return path.join(fileSet.destination, path.relative(fileSet.src, file))
  }
  return fileSet.destination
}

async function buildStreamsFromSets(
  fileSets: PackedFileSet[],
  normalizedUnpackedPaths: string[],
  unpackPattern: FileFilter | undefined,
  defaultDestination: string | undefined,
  workspaceRoot: string | undefined,
): Promise<FileStreamEntry[]> {
  const orderedFileSets = [...fileSets.slice(1), fileSets[0]].map((set) => orderFileSetInSet(set))

  const resultsMap = new Map<string, FileStreamEntry>()
  const streamOrdering: string[] = []

  // Check whether a destination file should be packed outside the asar.
  const isUnpacked = (
    destination: string,
    file: string | undefined,
    stat: FileStat | undefined,
  ): boolean => {
    const normalizedDir = path.normalize(destination)

    if (
      file != null &&
      !isEmptyOrSpaces(file) &&
      stat &&
      stat.type === EntryKind.FILE &&
      typeof unpackPattern === 'function' &&
      unpackPattern(file, stat)
    ) {
      return true
    }

    for (const unpackedPath of normalizedUnpackedPaths) {
      if (normalizedDir === unpackedPath || normalizedDir.startsWith(unpackedPath + path.sep)) {
        return true
      }
    }
    return false
  }

  for (const fileSet of orderedFileSets) {
    const { files, metadata, transformedFiles, src, destination } = fileSet
    const orderedFiles = files

    for (let index = 0; index < orderedFiles.length; index++) {
      const file = orderedFiles[index]
      const stat = metadata.get(file)
      if (!stat) continue

      const dest = getDestinationPath(file, { src, destination })
      const relativeDest = defaultDestination
        ? path.relative(defaultDestination, dest)
        : path.relative(destination, dest)

      ensureParentDirectories(relativeDest, resultsMap, streamOrdering)

      const transformedData = transformedFiles ? transformedFiles.get(index) : undefined

      const result = await processFileOrSymlink({
        file,
        destination: relativeDest,
        stat,
        isUnpacked,
        workspaceRoot,
        transformedData,
      })

      if (result && !resultsMap.has(result.path)) {
        resultsMap.set(result.path, result)
        streamOrdering.push(result.path)
      }
    }
  }

  for (const entry of resultsMap.values()) {
    if (entry.unpacked) {
      markParentDirectoriesAsUnpacked(entry.path, resultsMap, isUnpacked)
    }
  }

  return streamOrdering.reduce((streams: FileStreamEntry[], p) => {
    const stream = resultsMap.get(p)
    if (stream != null) {
      streams.push(stream)
    }
    return streams
  }, [])
}

function orderFileSetInSet(fileSet: PackedFileSet): PackedFileSet {
  const sortedFileEntries = Array.from(fileSet.files.entries())
  sortedFileEntries.sort(([, a], [, b]) => {
    if (a === b) return 0
    const isAAddon = a.endsWith('.node')
    const isBAddon = b.endsWith('.node')
    if (isAAddon && !isBAddon) return 1
    if (isBAddon && !isAAddon) return -1
    return a < b ? -1 : 1
  })

  let transformedFiles: Map<number, string> | undefined
  if (fileSet.transformedFiles) {
    transformedFiles = new Map()
    const indexMap = new Map<number, number>()
    for (const [newIndex, [oldIndex]] of sortedFileEntries.entries()) {
      indexMap.set(oldIndex, newIndex)
    }
    for (const [oldIndex, value] of fileSet.transformedFiles) {
      const newIndex = indexMap.get(oldIndex)
      if (newIndex === undefined) {
        throw new Error(`Internal error: ${fileSet.files[oldIndex]} was lost while ordering asar`)
      }
      transformedFiles.set(newIndex, value)
    }
  }

  return {
    src: fileSet.src,
    destination: fileSet.destination,
    metadata: fileSet.metadata,
    files: sortedFileEntries.map(([, file]) => file),
    transformedFiles,
  }
}

async function processFileOrSymlink({
  file,
  destination,
  stat,
  isUnpacked,
  workspaceRoot,
  transformedData,
}: {
  file: string
  destination: string
  stat: FileStat
  isUnpacked: (destination: string, file: string | undefined, stat: FileStat | undefined) => boolean
  workspaceRoot: string | undefined
  transformedData?: string
}): Promise<FileStreamEntry | undefined> {
  const unpacked = isUnpacked(destination, file, stat)

  if (stat.type !== EntryKind.FILE && stat.type !== EntryKind.LINK) {
    return { path: destination, unpacked, type: EntryKind.DIRECTORY }
  }

  if (transformedData != null) {
    const buf = Buffer.from(transformedData, 'utf8')
    const size = buf.length
    return {
      path: destination,
      data: buf,
      unpacked,
      type: EntryKind.FILE,
      stat: { type: EntryKind.FILE, mode: stat.mode, size },
    }
  }

  await protectSystemAndUnsafePaths(file, workspaceRoot, stat)

  if (stat.type !== EntryKind.LINK) {
    const realFile = stat.realFilePath || file
    return {
      path: destination,
      file: realFile,
      unpacked,
      type: EntryKind.FILE,
      stat,
    }
  }

  let link: string
  try {
    link = await readlinkAsync(file)
  } catch (e) {
    throw new Error(`Cannot read symlink "${file}": ${e instanceof Error ? e.message : String(e)}`)
  }
  if (path.isAbsolute(link)) {
    link = path.relative(path.dirname(file), link)
  }

  return {
    path: destination,
    file,
    unpacked,
    type: EntryKind.LINK,
    symlink: link,
    stat,
  }
}

function ensureParentDirectories(
  destination: string,
  resultsMap: Map<string, FileStreamEntry>,
  streamOrdering: string[],
): void {
  const parents: string[] = []
  let current = path.dirname(path.normalize(destination))

  while (current !== '.') {
    parents.unshift(current)
    current = path.dirname(current)
  }

  for (const parentPath of parents) {
    if (!resultsMap.has(parentPath)) {
      const dir: DirectoryStream = {
        type: EntryKind.DIRECTORY,
        path: parentPath,
        unpacked: false,
      }
      resultsMap.set(parentPath, dir)
      streamOrdering.push(parentPath)
    }
  }
}

function markParentDirectoriesAsUnpacked(
  destination: string,
  resultsMap: Map<string, FileStreamEntry>,
  isUnpacked: (destination: string, file?: string, stat?: FileStat) => boolean,
): void {
  let current = path.dirname(path.normalize(destination))
  while (current !== '.') {
    const entry = resultsMap.get(current)
    if (entry && isUnpacked(current)) {
      entry.unpacked = true
    }
    current = path.dirname(current)
  }
}

async function executeElectronAsar(outFile: string, streams: FileStreamEntry[]): Promise<void> {
  await mkdirAsync(path.dirname(outFile), { recursive: true })

  const header: HeaderDirNode = { files: Object.create(null) }
  let dataOffset = BigInt(0)
  const dataEntries: DataEntry[] = []
  const pendingFileIntegrities: PendingFileIntegrity[] = []
  const unpackedDir = `${outFile}.unpacked`
  const unpackedStreams: { stream: FileStream; segments: string[] }[] = []

  for (const stream of streams) {
    const filename = path.normalize(stream.path)
    const segments = filename.split(/[/\\]/).filter(Boolean)

    if (stream.type === EntryKind.DIRECTORY) {
      let node: HeaderDirNode = header
      for (const seg of segments) {
        const existing = node.files[seg]
        if (!existing || !isDirNode(existing)) {
          node.files[seg] = { files: Object.create(null) }
        }
        const next = node.files[seg]
        if (isDirNode(next)) node = next
      }
      if (stream.unpacked) {
        node.unpacked = true
      }
      continue
    }

    let node: HeaderDirNode = header
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const existing = node.files[seg]
      if (!existing || !isDirNode(existing)) {
        node.files[seg] = { files: Object.create(null) }
      }
      const next = node.files[seg]
      if (isDirNode(next)) node = next
    }
    const name = segments[segments.length - 1]

    if (stream.type === EntryKind.LINK) {
      node.files[name] = { link: stream.symlink }
      continue
    }

    const size = stream.stat.size

    if (stream.unpacked) {
      node.files[name] = { size, unpacked: true }
      unpackedStreams.push({ stream, segments })
      continue
    }

    const offsetStr = dataOffset.toString()
    dataOffset += BigInt(size)

    const fileEntry: HeaderFileNode = { size, offset: offsetStr }

    if (stream.data) {
      const integrity = computeIntegrityFromBuffer(stream.data)
      fileEntry.integrity = integrity
      dataEntries.push({ type: 'buffer', data: stream.data, size })
    } else {
      const realFile = stream.stat.realFilePath || stream.file || stream.path
      const dataEntry: DataEntry = { type: 'file', path: realFile, size, pending: true }
      pendingFileIntegrities.push({ fileEntry, dataEntry })
      dataEntries.push(dataEntry)
    }

    node.files[name] = fileEntry
  }

  await assignFileIntegrities(pendingFileIntegrities)

  const headerJson = JSON.stringify(header)
  const headerBuf = createAsarHeader(headerJson)

  const out = createWriteStream(outFile)
  out.setMaxListeners(0)
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.write(headerBuf, () => resolve())
  })

  for (const entry of dataEntries) {
    if (entry.data) {
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject)
        out.write(entry.data, () => resolve())
      })
    } else if (entry.path) {
      const readStream = createReadStream(entry.path)
      await pipeline(readStream, out, { end: false })
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.on('close', () => resolve())
    out.end()
  })

  if (unpackedStreams.length > 0) {
    await mkdirAsync(unpackedDir, { recursive: true })
    await mapWithConcurrency(
      unpackedStreams,
      INTEGRITY_CONCURRENCY,
      async ({ stream, segments }) => {
        const destPath = path.join(unpackedDir, ...segments)
        await mkdirAsync(path.dirname(destPath), { recursive: true })
        if (stream.data) {
          await writeFileAsync(destPath, stream.data)
          return
        }
        const realFile = stream.stat.realFilePath || stream.file || stream.path
        const srcStream = createReadStream(realFile)
        const destStream = createWriteStream(destPath)
        await pipeline(srcStream, destStream)
      },
    )
  }
}

function isDirNode(node: HeaderNode): node is HeaderDirNode {
  return 'files' in node && node.files !== undefined
}

async function assignFileIntegrities(
  pendingFileIntegrities: PendingFileIntegrity[],
): Promise<void> {
  if (pendingFileIntegrities.length === 0) {
    return
  }

  const smallFiles = pendingFileIntegrities.filter(
    (item) => item.dataEntry.size <= SMALL_FILE_THRESHOLD,
  )
  const largeFiles = pendingFileIntegrities.filter(
    (item) => item.dataEntry.size > SMALL_FILE_THRESHOLD,
  )

  await mapWithConcurrency(smallFiles, INTEGRITY_CONCURRENCY, async (item) => {
    const data = await readFileAsync(requireDataPath(item.dataEntry))
    item.fileEntry.integrity = computeIntegrityFromBuffer(data)
    item.dataEntry.data = data
    item.dataEntry.pending = false
  })

  await mapWithConcurrency(largeFiles, INTEGRITY_CONCURRENCY, async (item) => {
    item.fileEntry.integrity = await computeIntegrityFromFile(requireDataPath(item.dataEntry))
    item.dataEntry.pending = false
  })
}

/** Assert that a pending file data entry carries its source path. */
function requireDataPath(entry: DataEntry): string {
  if (!entry.path) {
    throw new Error(`Internal error: file data entry missing path (size=${entry.size})`)
  }
  return entry.path
}

function createAsarHeader(headerJson: string): Buffer {
  const headerData = Buffer.from(headerJson, 'utf8')
  const headerDataAligned = alignInt(headerData.length, 4)
  const headerPayloadSize = 4 + headerDataAligned
  const headerPickleSize = 4 + headerPayloadSize
  const headerPickleBuf = Buffer.alloc(headerPickleSize)
  headerPickleBuf.writeUInt32LE(headerPayloadSize, 0)
  headerPickleBuf.writeUInt32LE(headerData.length, 4)
  headerPickleBuf.fill(0, 8, 8 + headerDataAligned)
  headerData.copy(headerPickleBuf, 8)

  const sizePickleBuf = Buffer.alloc(8)
  sizePickleBuf.writeUInt32LE(4, 0)
  sizePickleBuf.writeUInt32LE(headerPickleBuf.length, 4)

  return Buffer.concat([sizePickleBuf, headerPickleBuf])
}

function alignInt(i: number, alignment: number): number {
  return i + ((alignment - (i % alignment)) % alignment)
}

function computeIntegrityFromBuffer(buf: Buffer): IntegrityInfo {
  const blockSize = 4194304
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const blocks: string[] = []
  for (let i = 0; i < buf.length; i += blockSize) {
    const chunk = buf.slice(i, Math.min(i + blockSize, buf.length))
    blocks.push(crypto.createHash('sha256').update(chunk).digest('hex'))
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize,
    blocks,
  }
}

async function computeIntegrityFromFile(filePath: string): Promise<IntegrityInfo> {
  const blockSize = 4194304
  const blocks: string[] = []
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let blockHash = crypto.createHash('sha256')
    let blockOffset = 0
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buf)
      let offset = 0
      while (offset < buf.length) {
        const remaining = blockSize - blockOffset
        const end = Math.min(offset + remaining, buf.length)
        blockHash.update(buf.slice(offset, end))
        blockOffset += end - offset
        offset = end
        if (blockOffset >= blockSize) {
          blocks.push(blockHash.digest('hex'))
          blockHash = crypto.createHash('sha256')
          blockOffset = 0
        }
      }
    })
    stream.on('end', () => {
      if (blockOffset > 0) {
        blocks.push(blockHash.digest('hex'))
      }
      resolve({
        algorithm: 'SHA256',
        hash: hash.digest('hex'),
        blockSize,
        blocks,
      })
    })
    stream.on('error', reject)
  })
}

async function protectSystemAndUnsafePaths(
  file: string,
  workspaceRoot: string | undefined,
  stat: FileStat,
): Promise<void> {
  if (stat.type !== EntryKind.LINK && isPathInsideWorkspace(file, workspaceRoot)) {
    return
  }

  const resolved = await resolvePath(file)
  if (resolved == null || isEmptyOrSpaces(resolved)) {
    return
  }

  const workspace = await getResolvedWorkspaceRoot(workspaceRoot)
  if (workspace && (resolved === workspace || resolved.startsWith(workspace + path.sep))) {
    return
  }

  if (await checkAgainstRoots(file, await ALLOWLIST)) {
    return
  }

  if (await checkAgainstRoots(file, await DENYLIST)) {
    throw new Error(
      `Cannot copy file [${file}] symlinked to file [${resolved}] outside the package to a system or unsafe path`,
    )
  }
}

function isPathInsideWorkspace(file: string, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) {
    return false
  }
  const normalizedFile = path.normalize(file)
  const normalizedWorkspace = path.normalize(workspaceRoot)
  return (
    normalizedFile === normalizedWorkspace ||
    normalizedFile.startsWith(normalizedWorkspace + path.sep)
  )
}

async function getResolvedWorkspaceRoot(
  workspaceRoot: string | undefined,
): Promise<string | undefined> {
  if (cachedWorkspaceRootPath !== workspaceRoot) {
    cachedWorkspaceRootPath = workspaceRoot ?? null
    cachedResolvedWorkspaceRoot = workspaceRoot ? await resolvePath(workspaceRoot) : undefined
  }
  return cachedResolvedWorkspaceRoot
}

async function resolvePath(target: string | undefined | null): Promise<string | undefined> {
  if (!target) return undefined
  try {
    const exists = await access(target)
      .then(() => true)
      .catch(() => false)
    if (!exists) return undefined
    return await realpathAsync(target)
  } catch {
    return path.resolve(target)
  }
}

async function checkAgainstRoots(target: string, roots: string[]): Promise<boolean> {
  const resolved = await resolvePath(target)
  if (resolved == null || isEmptyOrSpaces(resolved)) {
    return false
  }
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return true
    }
  }
  return false
}

async function resolvePaths(filepaths: (string | undefined)[]): Promise<string[]> {
  const results = await Promise.all(filepaths.map(resolvePath))
  return results.filter((it): it is string => it != null)
}

function isEmptyOrSpaces(s: string | undefined | null): boolean {
  return s == null || s.trim().length === 0
}
