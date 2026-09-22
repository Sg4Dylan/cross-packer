/**
 * Target resolution: maps (platform, arch) pairs to packer implementations.
 */

import type { NormalizedConfig } from '../config/index.ts'
import { packLinux } from '../packer/linux/linux.ts'
import { packMac } from '../packer/mac/mac.ts'
import { packWin } from '../packer/win/win.ts'
import type { Arch, Platform } from '../shared/platform.ts'
import type { PipelineOptions, TargetSpec } from './pipeline.ts'

const PACKERS: Record<Platform, (ctx: PackerContext) => Promise<string>> = {
  win: packWin,
  mac: packMac,
  linux: packLinux,
}

export interface PackerContext {
  config: NormalizedConfig
  arch: Arch
  outputDir: string
  asarPath?: string
  unpackedDir?: string
}

/** A single (platform, arch) packaging unit. */
export interface PackTarget {
  platform: Platform
  arch: Arch
  run: (asar: { asarPath?: string; unpackedDir?: string }) => Promise<string>
}

export function runPlatformPackers({
  config,
  options,
  outputDir,
  targetSpecs,
}: {
  config: NormalizedConfig
  options: PipelineOptions
  outputDir: string
  targetSpecs?: TargetSpec[]
}) {
  const specs: TargetSpec[] =
    targetSpecs && targetSpecs.length > 0
      ? targetSpecs
      : options.platforms.map((platform) => ({ platform, arches: options.arches }))

  const targets: PackTarget[] = []
  for (const spec of specs) {
    const packer = PACKERS[spec.platform]
    if (!packer) {
      throw new Error(`No packer registered for platform "${spec.platform}"`)
    }
    const arches = spec.arches ?? options.arches
    const targetConfig = spec.config ? spec.config(config) : config
    for (const arch of arches) {
      targets.push({
        platform: spec.platform,
        arch,
        run: (asar: { asarPath?: string; unpackedDir?: string }) =>
          packer({ config: targetConfig, arch, outputDir, ...asar }),
      })
    }
  }
  return targets
}
