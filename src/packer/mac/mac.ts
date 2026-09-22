/**
 * macOS .app/zip packer.
 */
import { createWriteStream, existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { Archiver, ArchiverOptions } from 'archiver'
import { build as buildPlist, type PlistValue, parse as parsePlist } from 'plist'
import {
  getEntryBuffer,
  getSymlinkTarget,
  isDefaultAppEntry,
  isSymlink,
  type ZipEntry,
} from '../../archive/zip-reader.ts'
import { hashHeader } from '../../asar/packer/integrity.ts'
import type { NormalizedConfig } from '../../config/index.ts'
import { downloadAndReadElectron } from '../../electron/dist-zip.ts'
import type { PackerContext } from '../../pipeline/targets.ts'
import { logger } from '../../shared/logger.ts'
import { NodePlatform, nodeArchName } from '../../shared/platform.ts'
import { buildBlockMap } from '../../update/blockmap.ts'
import { generateUpdateMetadata } from '../../update/metadata.ts'
import { renderAppUpdateYml } from '../common/app-update-yml.ts'
import {
  type ExtraResourceEntry,
  isExtraResourcePathExcluded,
  resolveExtraResources,
} from '../common/extra-resources.ts'
import { createStagingDir, removeStagingDir } from '../common/staging.ts'
import { getTemplatesDir } from '../common/template.ts'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver') as {
  ZipArchive: new (options: ArchiverOptions) => Archiver
}

const TEMPLATES_DIR = getTemplatesDir('mac')

interface MacBundleIdentity {
  /** Bundle directory name, for example "MyApp.app". */
  appName: string
  /** On-disk bundle base name. */
  bundleName: string
  /** User-visible product name. */
  displayName: string
  executableName: string
  helperName: string
  /** Helper name with unsafe characters removed. */
  sanitizedHelperName: string
}

interface HelperPlistEntry {
  executable: string
  displayName: string
  name: string
  bundleId: string
  version: string
}

export async function packMac({
  config,
  arch,
  outputDir,
  asarPath,
  unpackedDir,
}: PackerContext): Promise<string> {
  if (asarPath === undefined) throw new Error('packMac: asarPath is required')
  logger.info(`\n[macOS] ${arch} packaging started`)

  const stagingDir = await createStagingDir(outputDir, 'mac', arch)

  try {
    logger.info('  [1/6] Downloading and reading macOS Electron dist ...')
    const { entries } = await downloadAndReadElectron(NodePlatform.DARWIN, arch, config)

    logger.info('  [2/6] Generating Info.plist and computing asar integrity ...')
    const identity = resolveMacBundleIdentity(config)
    const asarHash = await computeAsarHash(asarPath)
    const defaultAppAsarHash = await computeDefaultAppAsarHash(entries)
    const mainPlist = await generateMainPlist(config, identity, { asarHash, defaultAppAsarHash })
    const helperPlistMap = buildHelperPlistMap(config, identity)

    logger.info('  [3/6] Writing zip (in-memory assembly) ...')
    const zipFilename = `${config.artifactName}_${config.version}_${nodeArchName(arch)}_unsigned.zip`
    const zipPath = path.join(outputDir, zipFilename)
    await writeMacZip({
      entries,
      identity,
      mainPlist,
      helperPlistMap,
      asarPath,
      unpackedDir,
      zipPath,
      config,
    })
    logger.info(`  [macOS] ${arch} zip complete: ${zipPath}`)

    let distributablePath = zipPath

    if (config.sign.enabled && config.sign.mac?.enabled && config.sign.mac?.hook) {
      logger.info('  [4/6] Running sign hook ...')
      distributablePath =
        (await config.sign.mac.hook(zipPath, { config, arch, outputDir })) || zipPath
    }

    if (config.update.generateMetadata) {
      logger.info('  [6/6] Generating update metadata ...')
      const zipBlockmapPath = `${distributablePath}.blockmap`
      let blockMapSize: number | undefined
      try {
        blockMapSize = (await buildBlockMap(distributablePath, 'gzip', zipBlockmapPath))
          .blockMapSize
      } catch (e) {
        console.warn(
          `  [macOS] Warning: blockmap generation failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      generateUpdateMetadata({
        filePath: distributablePath,
        version: config.version,
        outputDir,
        platform: NodePlatform.DARWIN,
        blockMapSize,
        channel: config.update.channel,
        extraFiles: config.update.extraArtifacts,
      })
    }

    logger.info(`  [macOS] ${arch} packaging complete: ${distributablePath}`)
    return distributablePath
  } finally {
    await removeStagingDir(stagingDir)
  }
}

/** Derive bundle identity (app name, executable, helper names) from config. */
export function resolveMacBundleIdentity(config: NormalizedConfig): MacBundleIdentity {
  const displayName = config.productName.trim()
  const bundleName = config.mac.bundleName.trim() || displayName
  const executableName = bundleName
  const helperName = displayName

  return {
    appName: `${bundleName}.app`,
    bundleName,
    displayName,
    executableName,
    helperName,
    sanitizedHelperName: helperName.replace(/[^\w()\- ]/g, ''),
  }
}

/** Normalize an archive entry mode to executable / regular file bits. */
export function normalizeMacArchiveFileMode(sourceMode: string | number): number {
  return Number(sourceMode) & 0o111 ? 0o100755 : 0o100644
}

export function addDirectoryToArchive(
  archive: Archiver,
  dirPath: string,
  archivePath: string,
  resource: ExtraResourceEntry = {},
  relativePath = '',
): void {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    const entryArchivePath = `${archivePath}/${entry.name}`
    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name

    if (isExtraResourcePathExcluded(resource, entryRelativePath)) continue

    if (entry.isDirectory()) {
      archive.append('', { name: `${entryArchivePath}/`, mode: 0o40755 })
      addDirectoryToArchive(archive, fullPath, entryArchivePath, resource, entryRelativePath)
    } else if (entry.isSymbolicLink()) {
      archive.symlink(entryArchivePath, readlinkSync(fullPath), 0o120755)
    } else if (entry.isFile()) {
      archive.file(fullPath, {
        name: entryArchivePath,
        mode: normalizeMacArchiveFileMode(lstatSync(fullPath).mode),
      })
    }
  }
}

/** Build Electron helper-process rename rules for the sanitized helper name. */
function buildRenameRules(sanitizedHelperName: string): { from: string; to: string }[] {
  const rules: { from: string; to: string }[] = []
  const helperSuffixes = [
    ' Helper (Renderer)',
    ' Helper (Plugin)',
    ' Helper (GPU)',
    ' Helper EH',
    ' Helper NP',
    ' Helper',
  ]
  for (const suffix of helperSuffixes) {
    rules.push({ from: `Electron${suffix}`, to: `${sanitizedHelperName}${suffix}` })
  }
  rules.push({ from: 'Electron Login Helper', to: `${sanitizedHelperName} Login Helper` })
  return rules
}

function applyRenameRules(pathStr: string, rules: { from: string; to: string }[]): string {
  const sorted = [...rules].sort((a, b) => b.from.length - a.from.length)
  let result = pathStr
  for (const { from, to } of sorted) {
    if (result.includes(from)) {
      result = result.split(from).join(to)
    }
  }
  return result
}

async function writeMacZip({
  entries,
  identity,
  mainPlist,
  helperPlistMap,
  asarPath,
  unpackedDir,
  zipPath,
  config,
}: {
  entries: ZipEntry[]
  identity: MacBundleIdentity
  mainPlist: string
  helperPlistMap: Record<string, HelperPlistEntry>
  asarPath: string
  unpackedDir?: string
  zipPath: string
  config: NormalizedConfig
}): Promise<void> {
  const oldAppPrefix = 'Electron.app/'
  const finalAppName = identity.appName
  const productFilename = identity.executableName
  const sanitizedHelperName = identity.sanitizedHelperName
  const renameRules = buildRenameRules(sanitizedHelperName)

  const iconSrc = config.mac.iconFile ? path.join(config.projectDir, config.mac.iconFile) : null
  const iconBuffer = iconSrc && existsSync(iconSrc) ? await readFile(iconSrc) : null

  const output = createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })

  const writePromise = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(output)

  const writtenDirs = new Set<string>()

  function ensureDir(archiveDirPath: string, mode: string | number): void {
    if (!writtenDirs.has(archiveDirPath)) {
      writtenDirs.add(archiveDirPath)
      archive.append('', { name: `${archiveDirPath}/`, mode: Number(mode) || 0o40755 })
    }
  }

  for (const e of entries) {
    const oldPath = e.path
    if (!oldPath.startsWith(oldAppPrefix)) continue

    if (isDefaultAppEntry(oldPath)) continue
    if (oldPath === `${oldAppPrefix}Contents/Resources/electron.icns`) continue
    if (/^Electron\.app\/Contents\/Resources\/[^/]+\.lproj\/?$/.test(oldPath)) continue

    let newPath = oldPath.replace(oldAppPrefix, `${finalAppName}/`)

    const mainExeOldPath = `${finalAppName}/Contents/MacOS/Electron`
    if (newPath === mainExeOldPath) {
      newPath = `${finalAppName}/Contents/MacOS/${productFilename}`
    } else if (newPath.includes('/Electron Helper') || newPath.includes('/Electron Login Helper')) {
      newPath = applyRenameRules(newPath, renameRules)
    }

    const pathParts = newPath.split('/')
    for (let i = 1; i < pathParts.length; i++) {
      ensureDir(pathParts.slice(0, i).join('/'), e.mode)
    }

    if (isSymlink(e)) {
      const target = await getSymlinkTarget(e.entry)
      let newTarget = target
      const isHelper =
        newPath.includes(`/${sanitizedHelperName} Helper`) ||
        newPath.includes(`/${sanitizedHelperName} Login Helper`)
      if (isHelper) {
        newTarget = applyRenameRules(newTarget, renameRules)
      }
      archive.symlink(newPath, newTarget, 0o120755)
      continue
    }

    if (e.dir) {
      ensureDir(newPath.replace(/\/$/, ''), e.mode)
      continue
    }

    if (newPath === `${finalAppName}/Contents/Info.plist`) {
      archive.append(mainPlist, { name: newPath, mode: 0o100644 })
      continue
    }

    const helperPlistEntry = helperPlistMap[newPath]
    if (helperPlistEntry) {
      const helperInfo = parsePlist(await e.entry.async('text')) as Record<string, PlistValue>
      helperInfo.CFBundleExecutable = helperPlistEntry.executable
      helperInfo.CFBundleDisplayName = helperPlistEntry.displayName
      helperInfo.CFBundleName = helperPlistEntry.name
      helperInfo.CFBundleIdentifier = helperPlistEntry.bundleId
      helperInfo.CFBundleVersion = helperPlistEntry.version
      archive.append(buildPlist(helperInfo), { name: newPath, mode: 0o100644 })
      continue
    }

    const buffer = await getEntryBuffer(e.entry)
    archive.append(buffer, { name: newPath, mode: Number(e.mode) })
  }

  if (iconBuffer) {
    archive.append(iconBuffer, {
      name: `${finalAppName}/Contents/Resources/icon.icns`,
      mode: 0o100644,
    })
  }

  if (existsSync(asarPath)) {
    const asarStat = await stat(asarPath)
    if (asarStat.size > 2 * 1024 * 1024 * 1024) {
      archive.file(asarPath, {
        name: `${finalAppName}/Contents/Resources/app.asar`,
        mode: 0o100644,
      })
    } else {
      archive.append(await readFile(asarPath), {
        name: `${finalAppName}/Contents/Resources/app.asar`,
        mode: 0o100644,
      })
    }
  }

  if (unpackedDir && existsSync(unpackedDir)) {
    archive.append('', {
      name: `${finalAppName}/Contents/Resources/app.asar.unpacked/`,
      mode: 0o40755,
    })
    addDirectoryToArchive(
      archive,
      unpackedDir,
      `${finalAppName}/Contents/Resources/app.asar.unpacked`,
    )
  }

  await injectExtraResourcesToZip(archive, finalAppName, config)

  if (config.update.generateMetadata && config.update.url) {
    const updateYml = await renderAppUpdateYml(config)
    archive.append(updateYml, {
      name: `${finalAppName}/Contents/Resources/app-update.yml`,
      mode: 0o100644,
    })
  }

  await archive.finalize()
  await writePromise
}

function buildHelperPlistMap(
  config: NormalizedConfig,
  identity: MacBundleIdentity,
): Record<string, HelperPlistEntry> {
  const map: Record<string, HelperPlistEntry> = {}
  const helperBundleId = `${config.appId}.helper`
  const finalAppName = identity.appName
  const helpers = [
    { suffix: ' Helper', bundleSuffix: '' },
    { suffix: ' Helper (Renderer)', bundleSuffix: '.(Renderer)' },
    { suffix: ' Helper (Plugin)', bundleSuffix: '.(Plugin)' },
    { suffix: ' Helper (GPU)', bundleSuffix: '.(GPU)' },
    { suffix: ' Helper EH', bundleSuffix: '.EH' },
    { suffix: ' Helper NP', bundleSuffix: '.NP' },
  ]

  for (const h of helpers) {
    const plistPath = `${finalAppName}/Contents/Frameworks/${identity.sanitizedHelperName}${h.suffix}.app/Contents/Info.plist`
    map[plistPath] = {
      executable: `${identity.sanitizedHelperName}${h.suffix}`,
      displayName: `${identity.displayName}${h.suffix}`,
      name: `${identity.displayName}${h.suffix}`,
      bundleId: `${helperBundleId}${h.bundleSuffix}`,
      version: config.version,
    }
  }

  const loginPlistPath = `${finalAppName}/Contents/Library/LoginItems/${identity.sanitizedHelperName} Login Helper.app/Contents/Info.plist`
  map[loginPlistPath] = {
    executable: `${identity.sanitizedHelperName} Login Helper`,
    displayName: `${identity.displayName} Login Helper`,
    name: `${identity.displayName} Login Helper`,
    bundleId: `${config.appId}.loginhelper`,
    version: config.version,
  }

  return map
}

async function generateMainPlist(
  config: NormalizedConfig,
  identity: MacBundleIdentity,
  { asarHash, defaultAppAsarHash }: { asarHash: string; defaultAppAsarHash: string },
): Promise<string> {
  const buildVersion = config.version.includes('.') ? config.version : `${config.version}.0`
  const year = new Date().getFullYear()

  const templateXml = await readFile(path.join(TEMPLATES_DIR, 'Info.plist'), 'utf8')
  const info = parsePlist(templateXml) as Record<string, PlistValue>

  info.CFBundleDisplayName = identity.displayName
  info.CFBundleExecutable = identity.executableName
  info.CFBundleIconFile = config.mac.iconFile ? 'icon.icns' : 'electron.icns'
  info.CFBundleIdentifier = config.appId
  info.CFBundleName = identity.bundleName
  info.CFBundleShortVersionString = config.version
  info.CFBundleVersion = buildVersion
  info.ElectronAsarIntegrity = {
    'Resources/app.asar': { algorithm: 'SHA256', hash: asarHash },
    'Resources/default_app.asar': { algorithm: 'SHA256', hash: defaultAppAsarHash },
  }
  info.LSApplicationCategoryType = config.mac.category
  info.LSMinimumSystemVersion = config.mac.minimumSystemVersion
  info.NSHumanReadableCopyright = `Copyright © ${year} ${config.author}`.trim()

  if (config.mac.urlSchemes?.length) {
    info.CFBundleURLTypes = config.mac.urlSchemes.map((scheme) => ({
      CFBundleTypeRole: 'Editor',
      CFBundleURLName: config.productName,
      CFBundleURLSchemes: [scheme],
    }))
  }

  if (config.mac.plist && Object.keys(config.mac.plist).length > 0) {
    Object.assign(info, config.mac.plist)
  }

  return buildPlist(info)
}

async function computeAsarHash(asarPath: string): Promise<string> {
  const { hash } = await hashHeader(asarPath)
  return hash
}

async function computeDefaultAppAsarHash(entries: ZipEntry[]): Promise<string> {
  // Find the default_app.asar entry inside the Electron distribution zip.
  const entry = entries.find((e) => e.path === 'Electron.app/Contents/Resources/default_app.asar')
  if (!entry) {
    throw new Error('default_app.asar not found in Electron zip')
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cross-packer-asar-'))
  const tmpAsar = path.join(tmpDir, 'default_app.asar')
  try {
    await writeFile(tmpAsar, await getEntryBuffer(entry.entry))
    const { hash } = await hashHeader(tmpAsar)
    return hash
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

async function injectExtraResourcesToZip(
  archive: Archiver,
  finalAppName: string,
  config: NormalizedConfig,
): Promise<void> {
  const resourcesPrefix = `${finalAppName}/Contents/Resources`

  for (const { res, srcPath, srcStat, destPath: resTo } of await resolveExtraResources(config)) {
    const archivePath = `${resourcesPrefix}/${resTo}`
    if (srcStat.isDirectory()) {
      archive.append('', { name: `${archivePath}/`, mode: 0o40755 })
      addDirectoryToArchive(archive, srcPath, archivePath, res)
    } else {
      archive.append(await readFile(srcPath), {
        name: archivePath,
        mode: normalizeMacArchiveFileMode(srcStat.mode),
      })
    }
  }
}
