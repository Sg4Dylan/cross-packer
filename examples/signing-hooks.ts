/**
 * Reference signing hook implementations for cross-packer.
 *
 * Usage — import into your cross-packer.config.ts:
 *
 *   import { osslsigncodeHook, rcodesignHook } from './signing-hooks.ts'
 *   export default {
 *     // ...
 *     sign: {
 *       enabled: true,
 *       win: { hook: osslsigncodeHook },
 *       mac: { hook: rcodesignHook },
 *     },
 *   }
 *
 * Hook contract (reference implementations below):
 *   win: (target, ctx) => Promise<void>
 *     - target: app directory path, or a single .exe path when ctx.singleFile
 *   mac: (target, ctx) => Promise<string>
 *     - target: unsigned .zip path; the hook signs it into a new file and
 *       returns the signed artifact path (e.g. *_unsigned.zip → *.zip)
 *   ctx: { config, arch, outputDir, singleFile? }
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NormalizedConfig } from '../src/config/index.ts'
import type { Arch } from '../src/shared/platform.ts'

/** Shared context passed to every signing hook. */
export interface SignHookContext {
  config: NormalizedConfig
  arch: Arch
  outputDir: string
  singleFile?: boolean
}

/** Run a command, throwing on non-zero exit. */
function run(cmd: string, args: string[], options?: { cwd?: string }): void {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (res.error) throw new Error(`Failed to launch ${cmd}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`)
}

/**
 * Windows signing via osslsigncode (https://github.com/mtrojnar/osslsigncode),
 * a cross-platform open-source tool — works on Linux/macOS build agents
 * without signtool.exe.
 *
 * Env inputs:
 *   - CROSS_PACKER_CERT_FILE / CROSS_PACKER_CERT_PASSWORD (PFX),
 *     or a token URI via PKCS#11 engine
 */
export async function osslsigncodeHook(target: string, ctx: SignHookContext): Promise<void> {
  const certFile = process.env.CROSS_PACKER_CERT_FILE
  const certPassword = process.env.CROSS_PACKER_CERT_PASSWORD
  if (!certFile || !existsSync(certFile)) {
    throw new Error('CROSS_PACKER_CERT_FILE is not set or does not exist')
  }

  const timestampUrl = process.env.CROSS_PACKER_TIMESTAMP_URL ?? 'http://timestamp.digicert.com'

  // Sign a single file: write to a temp file, then atomically replace the original.
  // The p12 password is passed via a temporary file (-readpass), never as a
  // command-line argument, so it stays invisible to other local processes.
  const signFile = (filePath: string): void => {
    const tmp = `${filePath}.signed`
    const passFile = `${filePath}.pass`
    writeFileSync(passFile, `${certPassword ?? ''}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      run('osslsigncode', [
        'sign',
        '-pkcs12',
        certFile,
        '-readpass',
        passFile,
        '-t',
        timestampUrl,
        '-in',
        filePath,
        '-out',
        tmp,
      ])
    } finally {
      rmSync(passFile, { force: true })
    }
    // Atomic replace: remove original, rename signed output in its place.
    rmSync(filePath, { force: true })
    renameSync(tmp, filePath)
  }

  if (ctx.singleFile) {
    signFile(target)
    return
  }

  // Recursively sign every .exe / .dll under the app directory. The
  // installer and uninstaller are signed separately via ctx.singleFile.
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (name.endsWith('.exe') || name.endsWith('.dll')) {
        signFile(full)
      }
    }
  }
  walk(target)
}

/**
 * macOS signing/notarization via the CUSTOMIZED rcodesign fork:
 *   https://github.com/Sg4Dylan/apple-platform-rs
 *
 * NOTE: this is NOT the upstream indygreg/apple-platform-rs rcodesign.
 * The fork extends `rcodesign sign` with direct p12 arguments
 * (`--p12-file` / `--p12-password-file` / `--for-notarization`),
 * enabling unattended zip signing on any host OS without a keychain
 * or interactive identity lookup.
 *
 * Required when building macOS artifacts (.zip) on a non-macOS
 * host: Apple's codesign exists only on macOS, and the upstream
 * rcodesign lacks the p12 flags this hook relies on.
 *
 * Env inputs:
 *   - RCODESIGN_EXE: path to the customized rcodesign binary
 *     (fallback: rcodesign.exe on PATH; RCODESIGN_* vars are stripped from
 *     the child process env — the fork consumes RCODESIGN_* as its own
 *     config and would fail schema validation otherwise)
 *   - MAC_SIGN_P12_FILE: path to Developer ID p12 (default <certDir>/sign.p12)
 *   - MAC_SIGN_PASSWORD_FILE: file containing the p12 password
 *   - MAC_SIGN_ENTITLEMENTS_FILE: entitlements.plist
 *   - MAC_SIGN_NOTARIZE: 'true' enables notary-submit + staple via key.json
 *   - MAC_SIGN_API_KEY_FILE: App Store Connect API key (key.json) for notarization
 *
 * @returns signed artifact path (*_unsigned.zip → *.zip)
 */
export async function rcodesignHook(target: string, _ctx: SignHookContext): Promise<string> {
  const resolvedTarget = path.resolve(target)

  const rcodesignExe = resolveRcodesignExecutable()
  const assets = resolveMacSignAssets()

  for (const [label, filePath] of Object.entries(assets)) {
    if (!existsSync(filePath)) {
      throw new Error(`Missing mac sign ${label}: ${filePath}`)
    }
  }

  // <name>_unsigned.zip → <name>.zip (keeps electron-updater artifact naming
  // stable: the signed zip replaces the unsigned one).
  const signedZipPath = resolvedTarget.replace(/_unsigned\.zip$/i, '.zip')

  // 1. Sign the zip: direct p12 signing with hardened runtime + entitlements,
  //    `--for-notarization` records digests accepted by Apple's notary service.
  runRcodesign(
    rcodesignExe,
    [
      'sign',
      '--p12-file',
      assets.p12File,
      '--p12-password-file',
      assets.passwordFile,
      '-e',
      assets.entitlementsFile,
      '--for-notarization',
      resolvedTarget,
      signedZipPath,
    ],
    'Signing zip',
  )

  if (!existsSync(signedZipPath)) {
    throw new Error(`rcodesign sign did not create output: ${signedZipPath}`)
  }

  // 2. Optional notarization + stapling (key.json from App Store Connect).
  if (String(process.env.MAC_SIGN_NOTARIZE ?? '').toLowerCase() === 'true') {
    const apiKeyFile = process.env.MAC_SIGN_API_KEY_FILE
    if (!apiKeyFile || !existsSync(apiKeyFile)) {
      throw new Error('MAC_SIGN_NOTARIZE=true but MAC_SIGN_API_KEY_FILE (key.json) is not set')
    }
    runRcodesign(
      rcodesignExe,
      ['notary-submit', '--api-key-file', apiKeyFile, '--staple', signedZipPath],
      'Notarizing zip',
    )
  }

  console.info(`  [macOS] Signed zip created: ${signedZipPath}`)
  return signedZipPath
}

/** Resolve the customized rcodesign binary: RCODESIGN_EXE env → PATH. */
function resolveRcodesignExecutable(): string {
  const configured = String(process.env.RCODESIGN_EXE || '').trim()
  if (configured) return configured
  return 'rcodesign.exe'
}

/** Resolve p12 / password / entitlements file paths. */
function resolveMacSignAssets(): {
  p12File: string
  passwordFile: string
  entitlementsFile: string
} {
  const certDir = String(process.env.MAC_SIGN_CERT_DIR || '').trim()
  return {
    p12File: path.resolve(String(process.env.MAC_SIGN_P12_FILE || path.join(certDir, 'sign.p12'))),
    passwordFile: path.resolve(
      String(process.env.MAC_SIGN_PASSWORD_FILE || path.join(certDir, 'password')),
    ),
    entitlementsFile: path.resolve(
      String(process.env.MAC_SIGN_ENTITLEMENTS_FILE || path.join(certDir, 'entitlements.plist')),
    ),
  }
}

/**
 * Spawn the customized rcodesign with a sanitized env: RCODESIGN_* variables
 * are stripped because the fork itself consumes RCODESIGN_* as config
 * (same pitfall as upstream) and would fail schema validation.
 */
function runRcodesign(exe: string, args: string[], label: string): void {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('RCODESIGN_')) delete env[key]
  }

  console.info(`  [macOS] ${label} via ${exe}`)
  const res = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true, env })
  if (res.error) throw new Error(`Failed to launch ${exe}: ${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`rcodesign ${label.toLowerCase()} failed with exit code ${res.status}`)
  }
}
