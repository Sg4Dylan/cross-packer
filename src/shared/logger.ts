/**
 * Logging facade. All output is written through process.stdout.write or
 * process.stderr.write; quiet mode suppresses every channel.
 */
import type { Arch, Platform } from './platform.ts'

interface LoggerOptions {
  quiet?: boolean
}

interface BannerSummary {
  platforms: Platform[]
  arches: Arch[]
}

interface TargetResult {
  platform: Platform
  arch: Arch
  output?: string
  error?: string
}

interface SummaryResult {
  targets: TargetResult[]
}

/** Project identity fields shown in the banner; any config object with these fields works. */
export interface BannerInput {
  productName: string
  version: string
  electronVersion: string
}

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  step: (label: string, message: string) => void
  banner: (project: BannerInput, summary: BannerSummary) => void
  summary: (result: SummaryResult) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { quiet = false } = options

  const emit = (stream: NodeJS.WriteStream, prefix: string, message: string): void => {
    if (quiet) return
    stream.write(`${prefix ? `${prefix} ` : ''}${message}\n`)
  }

  return {
    info: (message) => emit(process.stdout, '', message),
    warn: (message) => emit(process.stderr, '[warn]', message),
    error: (message) => emit(process.stderr, '[error]', message),
    step: (label, message) => emit(process.stdout, `  [${label}]`, message),

    banner(project, summary) {
      if (quiet) return
      const targets = summary.platforms.join(' + ')
      const lines = [
        '=========================================',
        '  cross-packer — Cross-platform packaging',
        '=========================================',
        `  Project: ${project.productName} v${project.version}`,
        `  Electron: v${project.electronVersion}`,
        `  Targets: ${targets}`,
        `  Architectures: ${summary.arches.join(', ')}`,
        '=========================================',
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    },

    summary(result) {
      if (quiet) return
      const lines = [
        '\n=========================================',
        '  Packaging Results',
        '=========================================',
      ]
      for (const r of result.targets) {
        const status = r.error ? 'FAIL' : 'OK'
        lines.push(`  [${status}] ${r.platform}-${r.arch}: ${r.output || r.error}`)
      }
      lines.push('=========================================')
      process.stdout.write(`${lines.join('\n')}\n`)
    },
  }
}

/** Shared default logger instance, used by packer/collector/util modules. */
export const logger: Logger = createLogger()
