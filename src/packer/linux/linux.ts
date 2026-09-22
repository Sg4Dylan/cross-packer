/**
 * Linux .deb packer.
 */
import { existsSync, readFileSync, type Stats } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type ReadEntry, create as tarCreate } from 'tar'
import { type ArEntry, createArArchive } from '../../archive/ar.ts'
import { compress } from '../../archive/seven-za.ts'
import { collectDirectoryEntries, type TarEntry, writeTarFromEntries } from '../../archive/tar.ts'
import {
  getEntryBuffer,
  getSymlinkTarget,
  isDefaultAppEntry,
  isSymlink,
  type ZipEntry,
} from '../../archive/zip-reader.ts'
import type { NormalizedConfig } from '../../config/index.ts'
import { downloadAndReadElectron } from '../../electron/dist-zip.ts'
import type { PackerContext } from '../../pipeline/targets.ts'
import { logger } from '../../shared/logger.ts'
import { type Arch, NodePlatform } from '../../shared/platform.ts'
import { generateUpdateMetadata } from '../../update/metadata.ts'
import { isExtraResourcePathExcluded, resolveExtraResources } from '../common/extra-resources.ts'
import { createStagingDir, removeStagingDir } from '../common/staging.ts'
import { getTemplatesDir, renderTemplate } from '../common/template.ts'

const TEMPLATES_DIR = getTemplatesDir('linux')

export async function packLinux({
  config,
  arch,
  outputDir,
  asarPath,
  unpackedDir,
}: PackerContext): Promise<string> {
  if (asarPath === undefined) throw new Error('packLinux: asarPath is required')
  logger.info(`\n[Linux] ${arch} packaging started`)
  const stagingDir = await createStagingDir(outputDir, 'linux', arch)

  try {
    logger.info('  [1/5] Downloading and reading Linux Electron dist ...')
    const { entries } = await downloadAndReadElectron(NodePlatform.LINUX, arch, config)

    logger.info('  [2/5] Building data.tar.xz ...')
    const installPrefix = `opt/${config.linux.installDir}`
    const dataEntries = buildDataEntries(entries, { config, installPrefix, asarPath })
    await appendUnpackedEntries(dataEntries, unpackedDir, installPrefix)
    dataEntries.push(await createDesktopEntry(config))
    dataEntries.push(...(await collectIconEntries(config)))
    dataEntries.push(...(await collectExtraResourceEntries(config)))

    const dataTarPath = path.join(stagingDir, 'data.tar.xz')
    await writeDataTarXz(dataEntries, dataTarPath, stagingDir)

    const installedSize = Math.ceil((await stat(dataTarPath)).size / 1024)

    logger.info('  [3/5] Building control.tar.xz ...')
    const controlDir = path.join(stagingDir, 'control')
    await mkdir(controlDir, { recursive: true })
    await createControlFiles(controlDir, config, arch, installedSize)
    const controlTarPath = path.join(stagingDir, 'control.tar.xz')
    await writeControlTarXz(controlDir, controlTarPath, stagingDir)

    logger.info('  [4/5] Assembling .deb ...')
    const debFilename = `${config.artifactName}_${config.version}_${arch}.deb`
    const debPath = path.join(outputDir, debFilename)
    const arFiles: ArEntry[] = [
      { name: 'debian-binary', content: Buffer.from('2.0\n'), mode: 0o100644 },
      { name: 'control.tar.xz', content: await readFile(controlTarPath), mode: 0o100644 },
      { name: 'data.tar.xz', content: await readFile(dataTarPath), mode: 0o100644 },
    ]
    await writeFile(debPath, createArArchive(arFiles))

    if (config.update.generateMetadata) {
      logger.info('  [5/5] Generating update metadata ...')
      generateUpdateMetadata({
        filePath: debPath,
        version: config.version,
        outputDir,
        platform: NodePlatform.LINUX,
        channel: config.update.channel,
      })
    }

    logger.info(`  [Linux] ${arch} packaging complete: ${debPath}`)
    return debPath
  } finally {
    await removeStagingDir(stagingDir)
  }
}

function buildDataEntries(
  electronEntries: ZipEntry[],
  {
    config,
    installPrefix,
    asarPath,
  }: { config: NormalizedConfig; installPrefix: string; asarPath: string },
): TarEntry[] {
  const dataEntries: TarEntry[] = []

  for (const e of electronEntries) {
    // The default application is replaced by the user's asar.
    if (isDefaultAppEntry(e.path)) continue

    let destPath = e.path
    if (e.path === 'electron') destPath = config.name

    const fullDestPath = `${installPrefix}/${destPath}`

    if (e.dir) {
      dataEntries.push({ type: 'dir', path: fullDestPath, mode: Number(e.mode) || 0o40755 })
    } else if (isSymlink(e)) {
      dataEntries.push({
        type: 'link',
        path: fullDestPath,
        mode: Number(e.mode) || 0o120755,
        getTarget: () => getSymlinkTarget(e.entry),
      })
    } else {
      dataEntries.push({
        type: 'file',
        path: fullDestPath,
        mode: Number(e.mode) || 0o100644,
        getBuffer: () => getEntryBuffer(e.entry),
      })
    }
  }

  dataEntries.push({
    type: 'file',
    path: `${installPrefix}/resources/app.asar`,
    mode: 0o100644,
    filePath: asarPath,
  })

  return dataEntries
}

async function appendUnpackedEntries(
  dataEntries: TarEntry[],
  unpackedDir: string | undefined,
  installPrefix: string,
): Promise<void> {
  if (!unpackedDir || !existsSync(unpackedDir)) return
  dataEntries.push(
    ...(await collectDirectoryEntries(unpackedDir, `${installPrefix}/resources/app.asar.unpacked`)),
  )
}

/** Render the .desktop entry from the template and config. */
async function createDesktopEntry(config: NormalizedConfig): Promise<TarEntry> {
  const template = readFileSync(path.join(TEMPLATES_DIR, 'app.desktop'), 'utf8')
  const mimeType = config.linux.mimeType ? `MimeType=${config.linux.mimeType};\n` : ''

  let desktopExtra = ''
  if (config.linux.desktopExtraFile) {
    const fragment = readFileSync(
      path.join(config.projectDir, config.linux.desktopExtraFile),
      'utf8',
    )
    desktopExtra = `${renderTemplate(fragment, {
      productName: config.productName,
      description: config.description || config.productName,
      name: config.name,
      installDir: config.linux.installDir,
    }).trimEnd()}\n`
  }
  const content = renderTemplate(template, {
    productName: config.productName,
    description: config.description || config.productName,
    name: config.name,
    installDir: config.linux.installDir,
    mimeType,
    desktopExtra,
  })
  return {
    type: 'file',
    path: `usr/share/applications/${config.name}.desktop`,
    mode: 0o100644,
    content: Buffer.from(content),
  }
}

/** Collect hicolor icon entries for every configured icon size. */
async function collectIconEntries(config: NormalizedConfig): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  const iconDir = config.linux.iconDir

  for (const size of config.linux.iconSizes) {
    const iconSrc = path.join(config.projectDir, iconDir, `${size}x${size}.png`)
    if (!existsSync(iconSrc)) {
      throw new Error(`Missing Linux icon (${size}x${size}): ${iconSrc}`)
    }
    entries.push({
      type: 'file',
      path: `usr/share/icons/hicolor/${size}x${size}/apps/${config.name}.png`,
      mode: 0o100644,
      filePath: iconSrc,
    })
  }

  if (entries.length > 0) logger.info('    Collected Linux icons')
  return entries
}

/** Collect extra resource entries for the /opt install prefix. */
async function collectExtraResourceEntries(config: NormalizedConfig): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  const installPrefix = `opt/${config.linux.installDir}`

  for (const { res, srcPath, srcStat, destPath: resTo } of await resolveExtraResources(config)) {
    const destPrefix = `${installPrefix}/resources/${resTo}`
    if (srcStat.isDirectory()) {
      const dirEntries = await collectDirectoryEntries(srcPath, destPrefix, res.collectOptions)
      entries.push(
        ...dirEntries.filter(
          (entry) => !isExtraResourcePathExcluded(res, entry.path.slice(destPrefix.length + 1)),
        ),
      )
    } else {
      entries.push({ type: 'file', path: destPrefix, mode: 0o100644, filePath: srcPath })
    }
  }

  if (entries.length > 0) logger.info('    Collected Linux extra resources')
  return entries
}

async function createControlFiles(
  controlDir: string,
  config: NormalizedConfig,
  debArch: Arch,
  installedSize: number,
): Promise<void> {
  const depends = (config.linux.debDepends || []).join(', ')
  const recommends = config.linux.debRecommends ? `Recommends: ${config.linux.debRecommends}\n` : ''

  const controlTemplate = await readFile(path.join(TEMPLATES_DIR, 'control'), 'utf8')
  const controlContent = renderTemplate(controlTemplate, {
    name: config.name,
    version: config.version,
    debArch,
    maintainer: config.linux.maintainer || config.author || 'Unknown',
    depends,
    recommends,
    installedSize,
    description: config.description || config.productName,
  })
  await writeFile(path.join(controlDir, 'control'), controlContent)

  const scriptReplacements = {
    productName: config.productName,
    name: config.name,
    installDir: config.linux.installDir,
  }
  await writeMaintainerScript(
    controlDir,
    'preinst',
    path.join(TEMPLATES_DIR, 'preinst'),
    scriptReplacements,
  )
  await writeMaintainerScript(
    controlDir,
    'postinst',
    path.join(TEMPLATES_DIR, 'postinst'),
    scriptReplacements,
  )
  await writeMaintainerScript(
    controlDir,
    'prerm',
    path.join(TEMPLATES_DIR, 'prerm'),
    scriptReplacements,
  )
  await writeMaintainerScript(controlDir, 'postrm', path.join(TEMPLATES_DIR, 'postrm'), {
    installDir: config.linux.installDir,
  })
}

async function writeDataTarXz(
  entries: TarEntry[],
  destPath: string,
  stagingDir: string,
): Promise<void> {
  const tarPath = path.join(stagingDir, 'data.tar')
  await writeTarFromEntries(entries, tarPath)
  compress({ src: tarPath, dest: destPath, format: 'xz', level: 9 })
}

async function writeControlTarXz(
  controlDir: string,
  destPath: string,
  stagingDir: string,
): Promise<void> {
  const tarPath = path.join(stagingDir, 'control.tar')
  await tarCreate(
    {
      gzip: false,
      file: tarPath,
      cwd: controlDir,
      portable: true,
      noPax: true,
      filter: (entryPath: string, entryStat: ReadEntry | Stats) => {
        const p = entryPath.replace(/^\.\//, '')
        if (p === '.') return true
        entryStat.mode =
          p === 'preinst' || p === 'postinst' || p === 'prerm' || p === 'postrm'
            ? 0o100755
            : 0o100644
        return true
      },
    },
    ['.'],
  )
  compress({ src: tarPath, dest: destPath, format: 'xz', level: 9 })
}

/** Render a maintainer script template and write it into the deb control dir. */
async function writeMaintainerScript(
  controlDir: string,
  fileName: string,
  templatePath: string,
  replacements: Record<string, string | number>,
): Promise<void> {
  const template = await readFile(templatePath, 'utf8')
  const content = renderTemplate(template, replacements)
  await writeFile(path.join(controlDir, fileName), content, { encoding: 'utf8' })
}
