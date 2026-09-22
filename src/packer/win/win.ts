/**
 * Windows NSIS packer.
 * The NSIS build runs in two phases: phase 1 emits the uninstaller, and
 * phase 2 emits the installer.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compress, computeEstimatedSize, get7zaPath } from '../../archive/seven-za.ts'
import { getEntryBuffer, isDefaultAppEntry, type ZipEntry } from '../../archive/zip-reader.ts'
import type { NormalizedConfig } from '../../config/index.ts'
import { downloadAndReadElectron } from '../../electron/dist-zip.ts'
import type { PackerContext } from '../../pipeline/targets.ts'
import { hashFile } from '../../shared/hash.ts'
import { logger } from '../../shared/logger.ts'
import { Arch, NodePlatform } from '../../shared/platform.ts'
import { buildBlockMap } from '../../update/blockmap.ts'
import { generateUpdateMetadata } from '../../update/metadata.ts'
import { getBuildVersion } from '../../update/version.ts'
import { getUpdaterCacheDirName, renderAppUpdateYml } from '../common/app-update-yml.ts'
import { isExtraResourcePathExcluded, resolveExtraResources } from '../common/extra-resources.ts'
import { createStagingDir, removeStagingDir } from '../common/staging.ts'
import {
  buildNsisScriptHeader,
  executeMakensis,
  getNsisTemplatesDir,
  prepareNsisToolchain,
} from './nsis.ts'
import { editExeResources } from './resedit.ts'

export async function packWin({
  config,
  arch,
  outputDir,
  asarPath,
  unpackedDir,
}: PackerContext): Promise<string> {
  if (asarPath === undefined) throw new Error('packWin: asarPath is required')
  logger.info(`\n[Windows] ${arch} packaging started`)

  const stagingDir = await createStagingDir(outputDir, 'win', arch)

  try {
    logger.info('  [1/11] Downloading and reading Windows Electron dist ...')
    const { entries } = await downloadAndReadElectron(NodePlatform.WIN32, arch, config)

    logger.info('  [2/11] Assembling app directory ...')
    const appDir = path.join(stagingDir, 'app')
    await mkdir(appDir, { recursive: true })
    await assembleAppDir({ entries, appDir, asarPath, unpackedDir, config, arch })

    logger.info('  [3/11] Setting exe icon and version info ...')
    const productExePath = path.join(appDir, `${config.productName}.exe`)
    const iconSrc = config.win.iconFile ? path.join(config.projectDir, config.win.iconFile) : null
    const iconPath = iconSrc && existsSync(iconSrc) ? iconSrc : null
    await editExeResources(productExePath, { iconPath, config })

    if (config.sign.enabled && config.sign.win?.enabled && config.sign.win?.hook) {
      logger.info('  [4/11] Running sign hook on app directory ...')
      await config.sign.win.hook(appDir, { config, arch, outputDir })
    } else {
      logger.info('  [4/11] Signing disabled, skipping app directory binaries')
    }

    logger.info('  [5/11] Creating 7z archive ...')
    const sevenZipPath = get7zaPath()
    const archiveFile = path.join(stagingDir, `app-${arch}.7z`)
    const compression = compress({
      sevenZipPath,
      src: appDir,
      dest: archiveFile,
      format: '7z',
      level: config.win.compressionLevel,
    })
    logger.info(
      `  [5/11] app-${arch}.7z ready (mx=${compression.level}, mmt=${compression.threads})`,
    )

    logger.info('  [6/11] Preparing NSIS toolchain ...')
    const { nsisDir, nsisResourcesDir } = await prepareNsisToolchain(config.projectDir, config.win)

    logger.info('  [7/11] Building NSIS installer script ...')
    const exeFilename = buildWindowsInstallerFilename(config)
    const exePath = path.join(outputDir, exeFilename)

    const nsisTemplatesDir = getNsisTemplatesDir()
    const pluginArch = 'x86-unicode'
    const nsisPluginsDir = path.join(nsisResourcesDir, 'plugins', pluginArch)
    const nsisIncludeDir = path.join(nsisTemplatesDir, 'include')

    const guid = generateGuid(config.appId)
    const uninstallAppKey = guid.replace(/\\/g, ' - ')
    const identity = resolveWindowsPackageIdentity(config)
    const appPackageName = config.name.replace(/\//g, '\\')
    const updaterCacheDirName = identity.updaterCacheDirName

    const installerNsiPath = path.join(nsisTemplatesDir, 'installer.nsi')
    const installerNsiScript = await readFile(installerNsiPath, 'utf8')
    logger.info('  [8/11] Generating uninstaller ...')

    const uninstallerBuilderExe = path.join(stagingDir, `__uninstaller_builder_${Date.now()}.exe`)
    const uninstallerExePath = path.join(stagingDir, `${exeFilename}__uninstaller.exe`)

    const definesUninstaller: Record<string, string | null> = {
      APP_ID: config.appId,
      APP_GUID: guid,
      UNINSTALL_APP_KEY: uninstallAppKey,
      PRODUCT_NAME: config.productName,
      PRODUCT_FILENAME: identity.productFilename,
      APP_FILENAME: identity.appFilename,
      APP_DESCRIPTION: smarten(config.description || ''),
      APP_PACKAGE_NAME: appPackageName,
      VERSION: config.version,
      PROJECT_DIR: config.projectDir,
      BUILD_RESOURCES_DIR: path.join(config.projectDir, 'build'),
      COMPRESSION_METHOD: '7z',
      COMPRESS: 'auto',
      ONE_CLICK: null,
      RUN_AFTER_FINISH: null,
      BUILD_UNINSTALLER: null,
      UNINSTALLER_OUT_FILE: uninstallerExePath,
      SHORTCUT_NAME: identity.shortcutName,
      UNINSTALL_DISPLAY_NAME: `${config.productName} ${config.version}`,
      APP_INSTALLER_STORE_FILE: `${updaterCacheDirName}\\installer.exe`,
      ...(identity.appFilename !== identity.productFilename
        ? { APP_PRODUCT_FILENAME: identity.productFilename }
        : {}),
    }
    if (config.author) {
      definesUninstaller.COMPANY_NAME = config.author
    }
    if (uninstallAppKey !== guid) {
      definesUninstaller.UNINSTALL_REGISTRY_KEY_2 = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`
    }
    const archDefineKey = arch === Arch.ARM64 ? 'APP_ARM64' : 'APP_64'
    definesUninstaller[archDefineKey] = archiveFile

    const commandsUninstaller: Record<string, string | boolean | string[]> = {
      OutFile: `"${uninstallerBuilderExe}"`,
      VIProductVersion: getBuildVersion(config.version, config.buildNumber),
      VIAddVersionKey: computeVersionKey(config),
      Unicode: true,
      SetCompressor: 'zlib',
    }
    if (iconPath) {
      definesUninstaller.MUI_ICON = iconPath
      definesUninstaller.MUI_UNICON = iconPath
    }
    const headerUninstaller = await buildNsisScriptHeader({
      nsisIncludeDir,
      nsisPluginsDir,
      pluginArch,
      nsisTemplatesDir,
      stagingDir,
    })
    await executeMakensis({
      nsisDir,
      defines: definesUninstaller,
      commands: commandsUninstaller,
      script: headerUninstaller + installerNsiScript,
      cwd: nsisTemplatesDir,
    })

    if (!existsSync(uninstallerBuilderExe)) {
      throw new Error(`Phase 1 installer not found: ${uninstallerBuilderExe}`)
    }
    const runResult = spawnSync(uninstallerBuilderExe, [], {
      stdio: 'pipe',
      windowsHide: true,
      env: { __COMPAT_LAYER: 'RunAsInvoker' },
      timeout: 30000,
    })
    if (runResult.status !== 0) {
      console.warn(`    Warning: Phase 1 installer exited with code ${runResult.status}`)
    }
    if (!existsSync(uninstallerExePath)) {
      throw new Error(
        `Uninstaller not generated after running Phase 1 installer. Expected: ${uninstallerExePath}`,
      )
    }

    if (existsSync(uninstallerBuilderExe)) {
      await rm(uninstallerBuilderExe, { force: true })
    }

    if (config.sign.enabled && config.sign.win?.enabled && config.sign.win?.hook) {
      logger.info('  [9/11] Running sign hook on uninstaller ...')
      await config.sign.win.hook(uninstallerExePath, { config, arch, outputDir, singleFile: true })
    }

    logger.info('  [10/11] Compiling NSIS installer ...')

    const { BUILD_UNINSTALLER: _omit, ...definesRest } = definesUninstaller
    const defines: Record<string, string | null> = definesRest
    defines.UNINSTALLER_OUT_FILE = uninstallerExePath

    const commands = { ...commandsUninstaller }
    commands.OutFile = `"${exePath}"`

    const archiveHashHex = hashFile(archiveFile, 'sha512', 'hex').toUpperCase()
    defines[`${archDefineKey}_NAME`] = path.basename(archiveFile)
    defines[`${archDefineKey}_HASH`] = archiveHashHex

    const archiveStat = await stat(archiveFile)
    const estimatedUnpackedSize = Math.ceil((archiveStat.size * 3) / 1024).toString()
    defines[`${archDefineKey}_UNPACKED_SIZE`] = estimatedUnpackedSize

    const estimatedSize = computeEstimatedSize(sevenZipPath, archiveFile)
    if (estimatedSize > 0) {
      defines.ESTIMATED_SIZE = String(Math.round(estimatedSize / 1024))
    }

    const headerInstaller = await buildNsisScriptHeader({
      nsisIncludeDir,
      nsisPluginsDir,
      pluginArch,
      nsisTemplatesDir,
      stagingDir,
    })
    await executeMakensis({
      nsisDir,
      defines,
      commands,
      script: headerInstaller + installerNsiScript,
      cwd: nsisTemplatesDir,
    })

    if (existsSync(uninstallerExePath)) {
      await rm(uninstallerExePath, { force: true })
    }

    if (config.sign.enabled && config.sign.win?.enabled && config.sign.win?.hook) {
      logger.info('  [11/11] Running sign hook on installer ...')
      await config.sign.win.hook(exePath, { config, arch, outputDir, singleFile: true })
    } else {
      logger.info('  [11/11] Signing disabled')
    }

    const blockmapPath = `${exePath}.blockmap`
    const blockMapSize = (await buildBlockMap(exePath, 'gzip', blockmapPath)).blockMapSize
    logger.info(`  [Windows] ${arch} blockmap ready: ${blockmapPath}`)

    if (config.update.generateMetadata) {
      generateUpdateMetadata({
        filePath: exePath,
        version: config.version,
        outputDir,
        platform: NodePlatform.WIN32,
        blockMapSize,
        channel: config.update.channel,
      })
    }

    logger.info(`  [Windows] ${arch} packaging complete: ${exePath}`)
    return exePath
  } finally {
    await removeStagingDir(stagingDir)
  }
}

/** Derive the installer .exe filename from the distribution naming contract. */
export function buildWindowsInstallerFilename(config: NormalizedConfig): string {
  return `${config.artifactName}_${config.version}.exe`
}

/** Derive the Windows package identity (install dir, shortcut, updater cache). */
export function resolveWindowsPackageIdentity(config: NormalizedConfig): {
  appFilename: string
  productFilename: string
  shortcutName: string
  updaterCacheDirName: string
} {
  return {
    appFilename: getWindowsInstallationDirName(config),
    productFilename: config.productName,
    shortcutName: config.win.shortcutName || config.productName,
    updaterCacheDirName: getUpdaterCacheDirName(config),
  }
}

async function assembleAppDir({
  entries,
  appDir,
  asarPath,
  unpackedDir,
  config,
  arch,
}: {
  entries: ZipEntry[]
  appDir: string
  asarPath: string
  unpackedDir?: string
  config: NormalizedConfig
  arch: Arch
}): Promise<void> {
  const productExeName = `${config.productName}.exe`

  for (const e of entries) {
    if (isDefaultAppEntry(e.path)) continue

    if (e.dir) {
      await mkdir(path.join(appDir, e.path), { recursive: true })
      continue
    }

    let destPath = e.path
    if (e.path === 'electron.exe') {
      destPath = productExeName
    }

    const fullPath = path.join(appDir, destPath)
    const parentDir = path.dirname(fullPath)
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true })
    }

    const buffer = await getEntryBuffer(e.entry)
    await writeFile(fullPath, buffer)
  }

  const asarDest = path.join(appDir, 'resources', 'app.asar')
  if (existsSync(asarPath)) {
    await cp(asarPath, asarDest)
  }

  if (unpackedDir && existsSync(unpackedDir)) {
    const unpackedDest = path.join(appDir, 'resources', 'app.asar.unpacked')
    await cp(unpackedDir, unpackedDest, { recursive: true })
  }

  await injectExtraResources(appDir, config, arch)
  await writeAppUpdateYml(appDir, config)
}

async function writeAppUpdateYml(appDir: string, config: NormalizedConfig): Promise<void> {
  if (!config.update.url) return

  const updateYml = await renderAppUpdateYml(config)
  const destDir = path.join(appDir, 'resources')
  await mkdir(destDir, { recursive: true })
  await writeFile(path.join(destDir, 'app-update.yml'), updateYml, 'utf8')
}

async function injectExtraResources(
  appDir: string,
  config: NormalizedConfig,
  _arch: Arch,
): Promise<void> {
  for (const { res, srcPath, srcStat, destPath: resTo } of await resolveExtraResources(config)) {
    const destPath = path.join(appDir, 'resources', resTo)
    if (srcStat.isDirectory()) {
      await cp(srcPath, destPath, {
        recursive: true,
        filter: (entryPath) => !isExtraResourcePathExcluded(res, path.relative(srcPath, entryPath)),
      })
    } else {
      const destDir = path.dirname(destPath)
      if (!existsSync(destDir)) await mkdir(destDir, { recursive: true })
      await cp(srcPath, destPath)
    }
  }
}

/** Build the NSIS version-info keys (locale 1033) for the installer. */
function computeVersionKey(config: NormalizedConfig): string[] {
  const localeId = '1033'
  const keys = [
    `/LANG=${localeId} ProductName "${config.productName}"`,
    `/LANG=${localeId} ProductVersion "${config.version}"`,
    `/LANG=${localeId} LegalCopyright "${config.copyright}"`,
    `/LANG=${localeId} FileDescription "${config.description || ''}"`,
    `/LANG=${localeId} FileVersion "${config.version}"`,
  ]
  if (config.author) {
    keys.push(`/LANG=${localeId} CompanyName "${config.author}"`)
  }
  return keys
}

/** Derive a stable v5 UUID (sha1 name-based) from the appId. */
function generateGuid(appId: string): string {
  const NAMESPACE = Buffer.from([
    0x50, 0xe0, 0x65, 0xbc, 0x31, 0x34, 0x11, 0xe6, 0x9b, 0xab, 0x38, 0xc9, 0x86, 0x2b, 0xda, 0xf3,
  ])
  const hash = crypto.createHash('sha1')
  hash.update(NAMESPACE)
  hash.update(appId)
  const buffer = hash.digest()
  const byte2hex: string[] = []
  for (let i = 0; i < 256; i++) {
    byte2hex[i] = (i + 0x100).toString(16).substring(1)
  }
  // Map a byte offset to its lowercase hex digit.
  const h = (i: number): string => byte2hex[buffer[i]]
  return (
    `${h(0)}${h(1)}${h(2)}${h(3)}-` +
    `${h(4)}${h(5)}-` +
    `${byte2hex[(buffer[6] & 0x0f) | 0x50]}${h(7)}-` +
    `${byte2hex[(buffer[8] & 0x3f) | 0x80]}${h(9)}-` +
    `${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
  )
}

/** Derive a filesystem-safe installation directory name. */
function getWindowsInstallationDirName(config: NormalizedConfig): string {
  const productFilename = config.productName
  if (/^[-_+0-9a-zA-Z .]+$/.test(productFilename)) {
    return productFilename
  }
  return config.name
    .replace(/@/g, '')
    .replace(/\//g, '-')
    .replace(/[^-._+0-9a-zA-Z ]/g, '')
}

/** Replace ASCII quotes with a typographic quote for NSIS strings. */
function smarten(str: string): string {
  return str.replace(/"/g, '”')
}
