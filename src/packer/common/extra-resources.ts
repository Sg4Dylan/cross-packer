/**
 * Extra-resource entry filtering, shared by the win/mac/linux packers.
 */
import { existsSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { CollectDirectoryOptions } from '../../archive/tar.ts'
import type { NormalizedConfig } from '../../config/index.ts'

export interface ExtraResourceEntry {
  from?: string
  to?: string
  required?: boolean
  exclude?: string[]
  collectOptions?: CollectDirectoryOptions
}

/** A resolved extra resource: source path, stat, and in-archive destination. */
export interface ResolvedExtraResource {
  res: ExtraResourceEntry
  srcPath: string
  srcStat: Stats
  destPath: string
}

/**
 * Resolve every configured extra resource into a source path plus stat.
 * Missing optional sources are skipped; required sources throw via
 * assertRequiredExtraResource.
 */
export async function resolveExtraResources(
  config: NormalizedConfig,
): Promise<ResolvedExtraResource[]> {
  const resolved: ResolvedExtraResource[] = []
  for (const res of config.extraResources) {
    if (!res.from || !res.to) continue
    assertRequiredExtraResource(config.projectDir, res)
    const srcPath = path.join(config.projectDir, res.from)
    if (!existsSync(srcPath)) continue
    resolved.push({ res, srcPath, srcStat: await stat(srcPath), destPath: res.to })
  }
  return resolved
}

/**
 * Check whether a directory entry (relative to the resource root) matches
 * the resource's exclude list. A matched path or any path under it is excluded.
 */
export function isExtraResourcePathExcluded(
  resource: ExtraResourceEntry,
  relativePath: string,
): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
  return (resource.exclude || []).some(
    (excludedPath) =>
      normalized === excludedPath || normalized.startsWith(`${excludedPath.replace(/\/$/, '')}/`),
  )
}

/**
 * Ensures required extra resources exist before packaging.
 * The optional hint callback returns an appended instruction telling the
 * user how to obtain the missing resource (e.g. a project-specific
 * download command); returning undefined falls back to the plain message.
 * @throws when a required resource path is missing
 */
export function assertRequiredExtraResource(
  projectDir: string,
  res: ExtraResourceEntry,
  missingHint?: (from: string) => string | undefined,
): void {
  if (!res.required) return

  const srcPath = path.join(projectDir, res.from ?? '')
  if (!existsSync(srcPath)) {
    const hint = missingHint?.(res.from ?? '')
    throw new Error(
      hint
        ? `Required extra resource not found: ${res.from}. ${hint}`
        : `Required extra resource not found: ${res.from}`,
    )
  }
}
