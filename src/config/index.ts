/**
 * Config loading and normalization.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrebuiltModuleRule } from '../asar/fileset/platform-fileset.ts'
import type { ExtraResourceEntry } from '../packer/common/extra-resources.ts'
import type { Arch, NodePlatform } from '../shared/platform.ts'
import type { FileVisitor, JsonObject } from '../shared/types.ts'

export const DEFAULT_CONFIG_FILENAME = 'cross-packer.config.mjs'

/**
 * Raw user configuration loaded from disk. This is an untyped trust
 * boundary: every field is validated and normalized before it reaches
 * NormalizedConfig.
 */
type RawConfig = Record<string, unknown>

const REQUIRED_FIELDS = ['name', 'productName', 'appId', 'electronVersion']

const CONFIG_FILENAME_CANDIDATES = [
  DEFAULT_CONFIG_FILENAME,
  'cross-packer.config.json',
  'cross-packer.json',
]

export interface NormalizedConfig {
  name: string
  productName: string
  artifactName: string
  appId: string
  version: string
  buildNumber?: number | string
  description: string
  author: string
  homepage: string
  electronVersion: string
  electronMirror: string
  copyright: string
  projectDir: string
  files?: JsonObject
  appDistDir: string
  asarUnpack: string[]
  smartUnpack: boolean
  extraResources: Array<ExtraResourceEntry>
  extraMetadata?: Record<string, unknown>
  onNodeModuleFile?: FileVisitor
  disableDefaultIgnoredFiles: boolean
  asar: { path?: string; unpackedDir?: string }
  nativeModules: {
    prebuiltRules?: (
      platform: NodePlatform,
      arch: Arch,
    ) => ReadonlyArray<PrebuiltModuleRule> | null | undefined
  }
  mac: {
    bundleName: string
    category: string
    iconFile?: string
    minimumSystemVersion: string
    urlSchemes: string[]
    /** Extra Info.plist entries merged on top of the generated keys. */
    plist: Record<string, unknown>
  }
  win: {
    iconFile?: string
    compressionLevel: number
    nsisVersion: string
    nsisResourcesVersion: string
    nsisCacheDir: string
    shortcutName: string
  }
  linux: {
    installDir: string
    iconDir: string
    iconSizes: number[]
    debDepends: string[]
    debRecommends: string
    maintainer: string
    mimeType: string
    desktopExtraFile?: string
  }
  update: { channel: string; generateMetadata: boolean; url: string; extraArtifacts?: string[] }
  sign: {
    enabled: boolean
    win?: {
      enabled?: boolean
      hook?: (
        target: string,
        ctx: { config: NormalizedConfig; arch: Arch; outputDir: string; singleFile?: boolean },
      ) => Promise<void> | void
    }
    mac?: {
      enabled?: boolean
      hook?: (
        target: string,
        ctx: { config: NormalizedConfig; arch: Arch; outputDir: string },
      ) => Promise<string> | string
    }
  }
}

/** Overrides applied on top of the raw config during normalization. */
export interface LoadConfigOverrides {
  channel?: string
  signEnabled?: boolean
}

/** Resolve the config path: an explicit path, or the first default candidate. */
export function resolveConfigPath(explicitPath = ''): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath)
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`)
    }
    return resolved
  }

  const candidates = CONFIG_FILENAME_CANDIDATES
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (existsSync(resolved)) return resolved
  }

  throw new Error(
    `No config found. Create ${DEFAULT_CONFIG_FILENAME} in the project root, or pass --config <path>.`,
  )
}

export async function loadConfig(
  configPath: string,
  overrides: LoadConfigOverrides = {},
): Promise<NormalizedConfig> {
  const raw = await importConfig(configPath)

  validateRawConfig(raw, configPath)

  const config = normalize(raw, {
    configDir: path.dirname(configPath),
    overrides,
  })

  return config
}

export function normalizeConfig(
  raw: Record<string, unknown>,
  overrides: LoadConfigOverrides = {},
): NormalizedConfig {
  validateRawConfig(raw, '<in-memory config>')
  return normalize(raw, { configDir: process.cwd(), overrides })
}

async function importConfig(configPath: string): Promise<RawConfig> {
  if (configPath.endsWith('.json')) {
    return JSON.parse(await readFile(configPath, 'utf8')) as RawConfig
  }

  const imported: Record<string, unknown> = await import(pathToFileURL(configPath).href)
  const raw = imported.default ?? imported
  if (typeof raw === 'function') {
    return (raw as (env: NodeJS.ProcessEnv) => RawConfig)(process.env)
  }
  return raw as RawConfig
}

function validateRawConfig(raw: RawConfig, configPath: string): void {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Config must export an object or a function returning one: ${configPath}`)
  }
  for (const field of REQUIRED_FIELDS) {
    const value = raw[field]
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Config is missing required string field "${field}": ${configPath}`)
    }
  }
}

/** Read a string field from a raw config, falling back to a default value. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Narrow an unknown value to a record for nested section access. */
function rec(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Read a string array field, falling back to a default. */
function strArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((it) => typeof it === 'string') ? value : fallback
}

/** Read a number array field, falling back to a default. */
function numArray(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value) && value.every((it) => typeof it === 'number') ? value : fallback
}

/** Read an optional string field (undefined passes through). */
function strOptional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalize(
  raw: RawConfig,
  {
    configDir,
    overrides,
  }: {
    configDir: string
    overrides: LoadConfigOverrides
  },
): NormalizedConfig {
  // Required string fields are validated by validateRawConfig before normalization.
  const required = raw as {
    name: string
    productName: string
    appId: string
    electronVersion: string
  }
  const pkgVersion = str(raw.version, '1.0.0')
  const buildNumber =
    typeof raw.buildNumber === 'number'
      ? raw.buildNumber
      : typeof raw.buildNumber === 'string' && raw.buildNumber.trim()
        ? raw.buildNumber.trim()
        : undefined
  const mac = rec(raw.mac)
  const win = rec(raw.win)
  const linux = rec(raw.linux)
  const update = rec(raw.update)
  const asar = rec(raw.asar)
  const files = rec(raw.files)

  return {
    name: required.name,
    productName: required.productName,
    artifactName: str(raw.artifactName, required.productName),
    appId: required.appId,
    version: pkgVersion,
    buildNumber,
    description: str(raw.description),
    author: str(raw.author),
    homepage: str(raw.homepage),

    electronVersion: required.electronVersion,
    // Default to the official download host; regional mirrors are configured via electronMirror.
    electronMirror: str(
      raw.electronMirror,
      'https://github.com/electron/electron/releases/download/',
    ),

    copyright:
      str(raw.copyright) || `Copyright © ${new Date().getFullYear()} ${str(raw.author)}`.trim(),

    projectDir:
      typeof raw.projectDir === 'string' ? path.resolve(configDir, raw.projectDir) : process.cwd(),

    // Application payload collected from the project directory.
    files,
    appDistDir: str(files.appDistDir, 'dist'),
    asarUnpack: strArray(raw.asarUnpack, ['**/*.node']),
    smartUnpack: raw.smartUnpack !== false,
    extraResources: (Array.isArray(raw.extraResources)
      ? raw.extraResources
      : []) as NormalizedConfig['extraResources'],
    extraMetadata: rec(raw.extraMetadata),
    onNodeModuleFile: raw.onNodeModuleFile as FileVisitor | undefined,
    disableDefaultIgnoredFiles: raw.disableDefaultIgnoredFiles === true,

    // Asar payload source: omit asar.path to build it from projectDir, or set it
    // to a pre-built asar produced by a bundler such as electron-vite or forge.
    asar: {
      path: strOptional(asar.path),
      unpackedDir: strOptional(asar.unpackedDir),
    },

    // Optional rules for projects that ship prebuilt native modules under a
    // custom directory. Signature: prebuiltRules(platform, arch) → rules.
    nativeModules: rec(raw.nativeModules) as NormalizedConfig['nativeModules'],

    mac: {
      bundleName: str(mac.bundleName, required.productName),
      category: str(mac.category, 'public.app-category.productivity'),
      iconFile: strOptional(mac.iconFile),
      minimumSystemVersion: str(mac.minimumSystemVersion, '10.13'),
      // URL schemes registered as CFBundleURLTypes entries in Info.plist.
      urlSchemes: strArray(mac.urlSchemes, []),
      plist: rec(mac.plist),
    },

    win: {
      iconFile: strOptional(win.iconFile),
      compressionLevel: typeof win.compressionLevel === 'number' ? win.compressionLevel : 5,
      nsisVersion: str(win.nsisVersion, '3.0.4.1'),
      nsisResourcesVersion: str(win.nsisResourcesVersion, '3.4.1'),
      nsisCacheDir: str(win.nsisCacheDir, '.nsis-cache'),
      shortcutName: str(win.shortcutName, required.productName),
    },

    linux: {
      installDir: str(linux.installDir, required.name),
      iconDir: str(linux.iconDir, 'build/icons'),
      iconSizes: numArray(linux.iconSizes, [16, 24, 32, 48, 64, 128, 256, 512]),
      debDepends: strArray(linux.debDepends, defaultDebDepends()),
      debRecommends: str(linux.debRecommends),
      maintainer: str(linux.maintainer, str(raw.author)),
      // MIME types for desktop integration; deep-link schemes use the
      // x-scheme-handler prefix.
      mimeType: str(linux.mimeType),
      desktopExtraFile: strOptional(linux.desktopExtraFile),
    },

    // Update metadata (electron-updater compatible); all fields are optional.
    update: {
      channel: overrides.channel ?? str(update.channel, 'latest'),
      generateMetadata: update.generateMetadata !== false,
      // Base URL written to the embedded app-update.yml; an empty value omits embedding.
      url: str(update.url),
      extraArtifacts: Array.isArray(update.extraArtifacts)
        ? (update.extraArtifacts as string[])
        : undefined,
    },

    sign: normalizeSign(raw.sign, overrides.signEnabled),
  }
}

function normalizeSign(
  rawSign: unknown,
  signEnabledOverride: boolean | undefined,
): NormalizedConfig['sign'] {
  const sign = rec(rawSign)
  const win = rec(sign.win)
  const mac = rec(sign.mac)
  return {
    ...(sign as NormalizedConfig['sign']),
    enabled: signEnabledOverride ?? sign.enabled === true,
    win: {
      ...(win as NormalizedConfig['sign']['win']),
      enabled: win.enabled !== false,
    },
    mac: {
      ...(mac as NormalizedConfig['sign']['mac']),
      enabled: mac.enabled !== false,
    },
  }
}

function defaultDebDepends(): string[] {
  return [
    'libgtk-3-0',
    'libnotify4',
    'libnss3',
    'libxss1',
    'libxtst6',
    'xdg-utils',
    'libatspi2.0-0',
    'libuuid1',
    'libsecret-1-0',
  ]
}
