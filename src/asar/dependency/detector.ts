import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export enum PackageManager {
  NPM = 'npm',
  YARN = 'yarn',
  YARN_BERRY = 'yarn-berry',
  PNPM = 'pnpm',
  BUN = 'bun',
}

export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  const pkgJsonPath = path.join(projectDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as {
        packageManager?: string
      }
      if (pkg.packageManager) {
        const [pm, version] = pkg.packageManager.split('@')
        if (pm === PackageManager.YARN && version && isYarnBerry(version)) {
          return PackageManager.YARN_BERRY
        }
        if (
          pm === PackageManager.NPM ||
          pm === PackageManager.YARN ||
          pm === PackageManager.PNPM ||
          pm === PackageManager.BUN
        ) {
          return pm
        }
      }
    } catch {}
  }

  if (existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return PackageManager.PNPM
  if (existsSync(path.join(projectDir, 'yarn.lock'))) {
    if (await isYarnBerryByLockfile(projectDir)) return PackageManager.YARN_BERRY
    return PackageManager.YARN
  }
  if (
    existsSync(path.join(projectDir, 'bun.lockb')) ||
    existsSync(path.join(projectDir, 'bun.lock'))
  )
    return PackageManager.BUN
  if (existsSync(path.join(projectDir, 'package-lock.json'))) return PackageManager.NPM

  const userAgent = process.env.npm_config_user_agent || ''
  if (userAgent.includes('pnpm')) return PackageManager.PNPM
  if (userAgent.includes('yarn')) return PackageManager.YARN
  if (userAgent.includes('bun')) return PackageManager.BUN

  return PackageManager.NPM
}

/** Check whether a yarn version is Berry (v2+). */
function isYarnBerry(version: string): boolean {
  if (!version) return false
  const major = Number.parseInt(version.split('.')[0], 10)
  return major >= 2
}

/** Check the yarn.lock content for Berry's __metadata header. */
async function isYarnBerryByLockfile(projectDir: string): Promise<boolean> {
  const lockPath = path.join(projectDir, 'yarn.lock')
  try {
    const content = await readFile(lockPath, 'utf8')
    return content.includes('__metadata:')
  } catch {
    return false
  }
}
