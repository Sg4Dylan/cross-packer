#!/usr/bin/env node
/**
 * cross-packer CLI entry.
 *
 * Usage:
 *   cross-packer --win --amd64
 *   cross-packer --mac --arm64
 *   cross-packer --linux --all-arch
 *   cross-packer --config ./cross-packer.config.mjs --win --mac --linux
 */
import { parseArgs } from 'node:util'
import { setPrebuiltDirResolver } from './asar/fileset/platform-fileset.ts'
import { loadConfig, resolveConfigPath } from './config/index.ts'
import { runPack } from './pipeline/pipeline.ts'
import { createLogger } from './shared/logger.ts'
import { Arch, Platform } from './shared/platform.ts'

const SUPPORTED_PLATFORMS: Platform[] = [Platform.WIN, Platform.MAC, Platform.LINUX]
const SUPPORTED_ARCHES: Arch[] = [Arch.AMD64, Arch.ARM64]

interface CliOptions {
  platforms: Platform[]
  arches: Arch[]
  configPath: string
  output: string
  channel: string
  signEnabled: boolean | undefined
  dryRun: boolean
}

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    options: {
      win: { type: 'boolean', default: false },
      mac: { type: 'boolean', default: false },
      linux: { type: 'boolean', default: false },
      'all-platforms': { type: 'boolean', default: false },
      amd64: { type: 'boolean', default: false },
      x64: { type: 'boolean', default: false },
      arm64: { type: 'boolean', default: false },
      'all-arch': { type: 'boolean', default: false },
      arch: { type: 'string', default: '' },
      config: { type: 'string', default: '' },
      output: { type: 'string', default: '' },
      channel: { type: 'string', default: '' },
      sign: { type: 'boolean' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    argv,
  })

  const platformFlags: Record<Platform, boolean> = {
    win: values.win,
    mac: values.mac,
    linux: values.linux,
  }

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  if (values['all-platforms']) {
    platformFlags.win = true
    platformFlags.mac = true
    platformFlags.linux = true
  }

  const platforms = SUPPORTED_PLATFORMS.filter((p) => platformFlags[p])
  if (platforms.length === 0) {
    fail('Missing target platform: expected --win, --mac, --linux, or --all-platforms')
  }

  let arches: Arch[] = []
  if (values['all-arch']) {
    arches = [...SUPPORTED_ARCHES]
  } else if (values.arch) {
    const requested = values.arch
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    const invalid = requested.filter((a) => !SUPPORTED_ARCHES.includes(a as Arch))
    if (invalid.length > 0) {
      fail(
        `Unsupported architecture(s): ${invalid.join(', ')} (supported: ${SUPPORTED_ARCHES.join(', ')})`,
      )
    }
    arches = requested as Arch[]
  } else {
    if (values.amd64 || values.x64) arches.push(Arch.AMD64)
    if (values.arm64) arches.push(Arch.ARM64)
  }

  if (arches.length === 0) {
    // No arch flags given: use the platform's default for a single target,
    // or all supported architectures when multiple platforms are requested.
    arches = platforms.length === 1 ? defaultArchFor(platforms[0]) : [...SUPPORTED_ARCHES]
  }

  return {
    platforms,
    arches: [...new Set(arches)],
    configPath: values.config,
    output: values.output,
    channel: values.channel,
    signEnabled: values.sign,
    dryRun: values['dry-run'],
  }
}

function defaultArchFor(platform: Platform): Arch[] {
  if (platform === Platform.MAC) return [Arch.ARM64]
  return [Arch.AMD64]
}

/** Print an error message and exit with a non-zero code. */
function fail(message: string): never {
  console.error(`cross-packer: ${message}`)
  process.exit(1)
}

function printHelp(): void {
  process.stdout.write(`cross-packer — cross-platform Electron app packager

Usage:
  cross-packer [options]

Platforms:
  --win                  Build Windows NSIS installer
  --mac                  Build macOS .app (zipped)
  --linux                Build Linux .deb package
  --all-platforms        Equivalent to --win --mac --linux

Architectures:
  --amd64                Target amd64 (x86-64, legacy alias: --x64)
  --arm64                Target arm64
  --all-arch             Target both amd64 and arm64
  --arch <list>          Comma-separated list, e.g. --arch amd64,arm64

Options:
  --config <path>        Path to config file (.mjs or .json), defaults to cross-packer.config.mjs
  --output <path>        Output directory (default: dist-<timestamp>)
  --channel <name>       Update channel override (e.g. latest, beta)
  --sign                 Enable code signing hooks (see config.sign)
  --dry-run              Validate config and targets without building
  -h, --help             Show this help
`)
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const logger = createLogger()

  const configPath = resolveConfigPath(cli.configPath)
  const config = await loadConfig(configPath, {
    channel: cli.channel,
    signEnabled: cli.signEnabled,
  })

  // Install the prebuilt native-module replacement rules (see platform-fileset.ts).
  if (config.nativeModules?.prebuiltRules) {
    setPrebuiltDirResolver(config.nativeModules.prebuiltRules)
  }

  logger.banner(config, cli)

  const result = await runPack(config, cli)

  if (!result.ok) {
    process.exitCode = 1
  }

  logger.summary(result)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err)
  console.error('cross-packer: fatal error:', message)
  process.exit(1)
})
