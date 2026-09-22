/**
 * NSIS toolchain management: download, cache, script header assembly, makensis execution.
 *
 * Third-party notice: NSIS binaries come from electron-userland/electron-builder-binaries
 * (MIT licensed). The nsis templates under templates/win/nsis originate from
 * electron-builder's app-builder-lib and keep their upstream license headers.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { NormalizedConfig } from '../../config/index.ts'
import { logger } from '../../shared/logger.ts'
import { getTemplatesDir } from '../common/template.ts'
import { downloadAndExtract7z } from './toolchain.ts'

export function getNsisTemplatesDir(): string {
  return getTemplatesDir('win', 'nsis')
}

export async function prepareNsisToolchain(projectDir: string, winConfig: NormalizedConfig['win']) {
  const NSIS_VERSION = winConfig.nsisVersion
  const NSIS_RESOURCES_VERSION = winConfig.nsisResourcesVersion

  const cacheDir = getNsisCacheDir(projectDir, winConfig.nsisCacheDir)

  const nsisDir = await ensureNsisComponent({
    cacheDir,
    name: 'nsis',
    version: NSIS_VERSION,
    validate: (dir) => existsSync(path.join(dir, 'Bin', 'makensis.exe')),
    sha512:
      'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==',
  })
  logger.info(`    NSIS: ${nsisDir}`)

  const nsisResourcesDir = await ensureNsisComponent({
    cacheDir,
    name: 'nsis-resources',
    version: NSIS_RESOURCES_VERSION,
    validate: (dir) => existsSync(path.join(dir, 'plugins')),
    sha512:
      'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==',
  })

  return { nsisDir, nsisResourcesDir }
}

/**
 * Assemble the NSIS script header: include paths, plugin directories,
 * and localized messages.
 */
export async function buildNsisScriptHeader({
  nsisIncludeDir,
  nsisPluginsDir,
  pluginArch,
  nsisTemplatesDir,
  stagingDir,
}: {
  nsisIncludeDir: string
  nsisPluginsDir: string
  pluginArch: string
  nsisTemplatesDir: string
  stagingDir: string
}): Promise<string> {
  const headerTemplatePath = getTemplatesDir('win', 'nsis-header.nsh')
  let header = await readFile(headerTemplatePath, 'utf8')

  const stdUtilsNshPath = path.join(nsisIncludeDir, 'StdUtils.nsh').replace(/\//g, '\\')
  const replacements: Record<string, string> = {
    NSIS_STDLIBS_NSH_PATH: stdUtilsNshPath,
    NSIS_INCLUDE_DIR: nsisIncludeDir.replace(/\//g, '\\'),
    NSIS_TEMPLATES_DIR: nsisTemplatesDir.replace(/\//g, '\\'),
    NSIS_PLUGIN_ARCH: pluginArch,
    NSIS_PLUGINS_DIR: nsisPluginsDir.replace(/\//g, '\\'),
  }

  for (const [key, value] of Object.entries(replacements)) {
    header = header.replaceAll(`\${${key}}`, () => value)
  }

  const messagesNshPath = path.join(stagingDir, 'messages.nsh')
  await generateMessagesNsh(nsisTemplatesDir, messagesNshPath)
  header = header.replaceAll(`\${NSIS_MESSAGES_NSH}`, () => messagesNshPath.replace(/\//g, '\\'))

  return header
}

export async function executeMakensis({
  nsisDir,
  defines,
  commands,
  script,
  cwd,
}: {
  nsisDir: string
  defines: Record<string, string | null>
  commands: Record<string, unknown>
  script: string
  cwd: string
}): Promise<void> {
  const makensisPath = path.join(nsisDir, 'Bin', 'makensis.exe')
  if (!existsSync(makensisPath)) {
    throw new Error(`makensis.exe not found: ${makensisPath}`)
  }

  const tmpScriptPath = path.join(cwd, `_cross_packer_installer_${Date.now()}.nsi`)
  await writeFile(tmpScriptPath, script, 'utf8')

  const args = ['-WX', '-InputCHARSET', 'UTF8']

  for (const [name, value] of Object.entries(defines)) {
    if (value == null) {
      args.push(`-D${name}`)
    } else {
      args.push(`-D${name}=${value}`)
    }
  }

  for (const [name, value] of Object.entries(commands)) {
    if (Array.isArray(value)) {
      for (const c of value) {
        args.push(`-X${name} ${c}`)
      }
    } else {
      args.push(`-X${name} ${value}`)
    }
  }

  args.push(tmpScriptPath)

  const child = spawnSync(makensisPath, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NSISDIR: nsisDir },
    cwd,
  })

  if (child.status !== 0) {
    const stderr = child.stderr || ''
    const stdout = child.stdout || ''
    throw new Error(`makensis compilation failed (exit ${child.status}):\n${stderr}\n${stdout}`)
  }

  await rm(tmpScriptPath, { force: true })
}

/**
 * Ensure a NSIS toolchain component is available in the local cache:
 * reuse a completed extraction, copy from an electron-builder cache, or
 * download from electron-builder-binaries.
 */
async function ensureNsisComponent({
  cacheDir,
  name,
  version,
  validate,
  sha512,
}: {
  cacheDir: string
  name: string
  version: string
  validate: (dir: string) => boolean
  sha512: string
}): Promise<string> {
  const localDir = path.join(cacheDir, `${name}-${version}`)
  const completeMarker = `${localDir}.complete`

  if (existsSync(completeMarker) && validate(localDir)) {
    return localDir
  }

  const builderDir = path.join(
    getElectronBuilderCacheDir(),
    'nsis',
    `${name}-${version}-${name}-${version}`,
  )
  if (validate(builderDir)) {
    logger.info(`    Copying ${name} from electron-builder cache ...`)
    mkdirSync(localDir, { recursive: true })
    await cp(builderDir, localDir, { recursive: true })
    writeFileSync(completeMarker, '')
    return localDir
  }

  logger.info(`    Downloading ${name} ...`)
  mkdirSync(cacheDir, { recursive: true })
  await downloadAndExtract7z({
    url: `https://github.com/electron-userland/electron-builder-binaries/releases/download/${name}-${version}/${name}-${version}.7z`,
    sha512,
    name: `${name}-${version}`,
    cacheDir,
    targetDir: localDir,
    validateExtracted: validate,
  })
  logger.info(`    ${name} download complete`)
  return localDir
}

function getNsisCacheDir(projectDir: string, nsisCacheDir?: string): string {
  return path.join(projectDir, nsisCacheDir || '.nsis-cache')
}

function getElectronBuilderCacheDir(): string {
  const env = process.env.ELECTRON_BUILDER_CACHE?.trim()
  if (env) return env

  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData) {
    return path.join(localAppData, 'electron-builder', 'Cache')
  }
  return path.join(os.tmpdir(), 'electron-builder-cache')
}

async function generateMessagesNsh(nsisTemplatesDir: string, outputPath: string): Promise<void> {
  const messagesYmlPath = path.join(nsisTemplatesDir, 'messages.yml')
  if (!existsSync(messagesYmlPath)) {
    await writeFile(outputPath, '', 'utf8')
    return
  }

  // Localized message strings keyed by message id. yaml.load returns unknown;
  // the shape is asserted once at this boundary.
  const messagesData = yamlLoad(await readFile(messagesYmlPath, 'utf8')) as Record<
    string,
    { en?: string; zh_CN?: string }
  >
  const LCID_EN_US = 1033
  const LCID_ZH_CN = 2052

  const lines: string[] = []
  for (const [messageId, translations] of Object.entries(messagesData)) {
    const enValue = (translations.en || '').replace(/\n/g, '$\\r$\\n')
    const zhRaw = translations.zh_CN || translations.en || ''
    const zhValue = zhRaw.replace(/\n/g, '$\\r$\\n')
    lines.push(`LangString ${messageId} ${LCID_EN_US} "${enValue}"`)
    lines.push(`LangString ${messageId} ${LCID_ZH_CN} "${zhValue}"`)
  }

  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8')
}
