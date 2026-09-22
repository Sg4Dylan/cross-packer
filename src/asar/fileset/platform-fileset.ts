import { existsSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../../shared/logger.ts'
import { type Arch, NodePlatform } from '../../shared/platform.ts'
import { EntryKind, type FileSet, type FileStat } from '../../shared/types.ts'
import { isLibOrExe } from './unpack-detector.ts'
import { walkDirectory } from './walker.ts'

/**
 * A prebuilt native-module replacement rule: replace the node_modules copy
 * of `moduleName` with files from `<projectDir>/<from>` in the packed fileset,
 * optionally renaming the module directory.
 */
export interface PrebuiltModuleRule {
  /** Module name as it appears in node_modules (may be scoped). */
  moduleName: string
  /** Source directory (relative to projectDir) holding the prebuilt files. */
  from: string
  /**
   * Rename the module directory in the packed fileset (e.g. `@napi-rs/canvas-darwin-arm64`
   * → `@napi-rs/canvas-<suffix>`); omit to keep the original name.
   */
  renameTo?: string
}

/**
 * Resolver producing the replacement rules for a platform/arch. Returning
 * undefined/null skips prebuilt replacement and node_modules copies are
 * used as-is.
 */
export type PrebuiltModuleRuleResolver = (
  platform: NodePlatform,
  arch: Arch,
) => ReadonlyArray<PrebuiltModuleRule> | null | undefined

let prebuiltRuleResolver: PrebuiltModuleRuleResolver | null = null

/**
 * Install the resolver used to derive prebuilt module replacement rules.
 * Hosts inject their own rules through config.nativeModules.prebuiltRules.
 */
export function setPrebuiltDirResolver(resolver: PrebuiltModuleRuleResolver | null): void {
  prebuiltRuleResolver = typeof resolver === 'function' ? resolver : null
}

/** Compare module names independent of the host path separator. */
function normalizeModuleName(name: string): string {
  return path.toNamespacedPath(name).split(path.sep).join('/')
}

export function derivePlatformFileSet(
  fileSet: FileSet,
  platform: NodePlatform,
  arch: Arch,
  projectDir: string,
): FileSet {
  const { files, metadata, src, destination } = fileSet

  // Rules from the host-injected resolver; moduleName may end with "-*" to
  // match a family of platform-variant modules (e.g. "@napi-rs/canvas-*").
  const rules = (prebuiltRuleResolver?.(platform, arch) ?? []).filter((r) => r.from)
  const exactRules = rules.filter((r) => !r.moduleName.endsWith('-*'))
  const prefixRules = rules.filter((r) => r.moduleName.endsWith('-*'))
  const prefixes = prefixRules.map((r) => ({
    rule: r,
    prefix: normalizeModuleName(r.moduleName.slice(0, -1)),
  }))

  // First pass: find module roots to replace.
  const exactModuleRoots = new Map<string, PrebuiltModuleRule[]>()
  let prefixMatch: {
    rule: PrebuiltModuleRule
    moduleRootDir: string
    originalModuleName: string
    originalSegment: string
  } | null = null

  const seenModuleNames = new Set<string>()

  for (const file of files) {
    const info = parseModuleInfo(file)
    if (!info) continue
    const normalizedModuleName = normalizeModuleName(info.moduleName)
    seenModuleNames.add(normalizedModuleName)

    const exact = exactRules.filter(
      (r) => normalizeModuleName(r.moduleName) === normalizedModuleName,
    )
    if (exact.length > 0) {
      const list = exactModuleRoots.get(info.moduleRootPath) ?? []
      list.push(...exact)
      exactModuleRoots.set(info.moduleRootPath, list)
      continue
    }
    for (const { rule, prefix } of prefixes) {
      if (normalizedModuleName.startsWith(prefix)) {
        // Only the first platform variant encountered drives the rename.
        if (!prefixMatch) {
          const segments = normalizedModuleName.split('/')
          prefixMatch = {
            rule,
            moduleRootDir: path.dirname(info.moduleRootPath),
            originalModuleName: info.moduleName,
            originalSegment: segments[segments.length - 1] ?? info.moduleName,
          }
        }
        break
      }
    }
  }

  for (const rule of exactRules) {
    const normalizedRuleName = normalizeModuleName(rule.moduleName)
    if (
      [...seenModuleNames].some(
        (name) => name !== normalizedRuleName && name.startsWith(`${normalizedRuleName}-`),
      )
    ) {
      logger.warn(
        `prebuiltRules: rule "${rule.moduleName}" is exact, but platform variants of the same family exist in node_modules; consider "${rule.moduleName}-*"`,
      )
    }
  }

  const exactReplacements = new Map<
    string,
    {
      entries: Array<{ rule: PrebuiltModuleRule; content: PrebuiltContent }>
      replacedRelPaths: Set<string>
    }
  >()
  for (const [moduleRootPath, ruleList] of exactModuleRoots) {
    const entries: Array<{ rule: PrebuiltModuleRule; content: PrebuiltContent }> = []
    const replacedRelPaths = new Set<string>()
    for (const rule of ruleList) {
      const content = collectPrebuiltContent(projectDir, rule)
      if (!content) continue
      entries.push({ rule, content })
      for (const pf of content.files) {
        replacedRelPaths.add(path.relative(content.prebuiltBase, pf))
      }
    }
    if (entries.length > 0) exactReplacements.set(moduleRootPath, { entries, replacedRelPaths })
  }

  // Second pass: drop files belonging to replaced modules, keep the rest.
  const newFiles: string[] = []
  const newMetadata = new Map<string, FileStat>()
  for (const file of files) {
    const meta = metadata.get(file)
    if (!meta) continue

    const info = parseModuleInfo(file)
    if (info) {
      const replacement = exactReplacements.get(info.moduleRootPath)
      if (replacement) {
        const relPath = path.relative(info.moduleRootPath, file)
        if (replacement.replacedRelPaths.has(relPath) || isLibOrExe(file)) continue
      }
      const normalizedModuleName = normalizeModuleName(info.moduleName)
      let matchedPrefix = false
      for (const { prefix } of prefixes) {
        if (normalizedModuleName.startsWith(prefix)) {
          matchedPrefix = true
          break
        }
      }
      if (matchedPrefix) continue
    }

    if (info && isExcludedPlatformPath(file, info.moduleRootPath, platform, info.moduleName)) {
      continue
    }

    newFiles.push(file)
    newMetadata.set(file, meta)
  }

  let adjustedSrc = src
  let adjustedDestination = destination

  // Emit prebuilt files for exact-name rules into each original module root.
  for (const [moduleRootPath, { entries }] of exactReplacements) {
    for (const { rule, content } of entries) {
      emitPrebuiltContent({
        platform,
        content,
        targetModuleRoot: moduleRootPath,
        targetModuleName: rule.moduleName,
        newFiles,
        newMetadata,
      })
    }
  }

  // Emit prebuilt files for the platform-variant rule, renaming the module
  // directory in the packed fileset.
  if (prefixMatch) {
    const { rule, moduleRootDir, originalModuleName, originalSegment } = prefixMatch
    const renamedSegment = rule.renameTo ?? originalSegment
    const renamedModuleName = rule.renameTo
      ? originalModuleName.replace(originalSegment, rule.renameTo)
      : originalModuleName
    const targetRoot = path.join(moduleRootDir, renamedSegment)

    const content = collectPrebuiltContent(projectDir, rule)
    if (content) {
      emitPrebuiltContent({
        platform,
        content,
        targetModuleRoot: targetRoot,
        targetModuleName: renamedModuleName,
        newFiles,
        newMetadata,
      })

      // When the whole fileset src was the renamed module (sub-fileset case),
      // rebase src/destination onto the renamed directory.
      if (newFiles.length > 0 && !newFiles.some((f) => f.startsWith(src))) {
        adjustedSrc = targetRoot
        adjustedDestination = destination.replace(originalSegment, renamedSegment)
      }
    }
  }

  newFiles.sort()
  return {
    src: adjustedSrc,
    destination: adjustedDestination,
    files: newFiles,
    metadata: newMetadata,
  }
}

/** Walked content of one prebuilt source directory. */
interface PrebuiltContent {
  prebuiltBase: string
  files: string[]
  metadata: Map<string, FileStat>
}

function collectPrebuiltContent(
  projectDir: string,
  rule: PrebuiltModuleRule,
): PrebuiltContent | null {
  const prebuiltBase = path.join(projectDir, rule.from)
  if (!existsSync(prebuiltBase)) return null
  const files: string[] = []
  const metadata = new Map<string, FileStat>()
  walkDirectory(prebuiltBase, files, metadata, prebuiltBase)
  return { prebuiltBase, files, metadata }
}

/** Copy prebuilt directory files into a target module root with override metadata. */
function emitPrebuiltContent({
  platform,
  content,
  targetModuleRoot,
  targetModuleName,
  newFiles,
  newMetadata,
}: {
  platform: NodePlatform
  content: PrebuiltContent
  targetModuleRoot: string
  targetModuleName: string
  newFiles: string[]
  newMetadata: Map<string, FileStat>
}): void {
  for (const pf of content.files) {
    const pm = content.metadata.get(pf)
    if (!pm) continue

    const relFromPrebuilt = path.relative(content.prebuiltBase, pf)
    const targetPath = path.join(targetModuleRoot, relFromPrebuilt)

    const overrideMeta: FileStat = {
      ...pm,
      realFilePath: pf,
      moduleRootPath: targetModuleRoot,
      moduleName: targetModuleName,
    }
    if (pm.type === EntryKind.FILE && pf.endsWith('.node')) {
      if (platform === NodePlatform.DARWIN || platform === NodePlatform.LINUX) {
        overrideMeta.mode = 0o100755
      }
    }
    newFiles.push(targetPath)
    newMetadata.set(targetPath, overrideMeta)
  }
}

/** Parse a file path inside node_modules into module name / subpath info. */
export function parseModuleInfo(
  filePath: string,
): { moduleName: string; moduleRootPath: string } | null {
  const nmIdx = filePath.indexOf(`${path.sep}node_modules${path.sep}`)
  if (nmIdx !== -1) {
    const after = filePath.slice(nmIdx + path.sep.length + 'node_modules'.length + path.sep.length)
    const parts = after.split(path.sep)
    if (parts[0].startsWith('@') && parts.length >= 2) {
      const moduleName = parts[0] + path.sep + parts[1]
      const moduleRootPath = filePath.slice(
        0,
        nmIdx + path.sep.length + 'node_modules'.length + path.sep.length + moduleName.length,
      )
      return { moduleName, moduleRootPath }
    }
    if (parts.length >= 1) {
      const moduleName = parts[0]
      const moduleRootPath = filePath.slice(
        0,
        nmIdx + path.sep.length + 'node_modules'.length + path.sep.length + moduleName.length,
      )
      return { moduleName, moduleRootPath }
    }
  }

  if (filePath.startsWith(`node_modules${path.sep}`) || filePath.startsWith('node_modules/')) {
    const after = filePath.slice('node_modules/'.length)
    const parts = after.split(/[/\\]/)
    if (parts[0].startsWith('@') && parts.length >= 2) {
      const moduleName = `${parts[0]}/${parts[1]}`
      const moduleRootPath = `node_modules/${moduleName}`
      return { moduleName, moduleRootPath }
    }
    if (parts.length >= 1) {
      const moduleName = parts[0]
      const moduleRootPath = `node_modules/${moduleName}`
      return { moduleName, moduleRootPath }
    }
  }

  return null
}

/**
 * Directory segments that mark a path as platform-specific, per platform.
 * Used to drop node_modules entries that only apply to other platforms.
 */
const PLATFORM_DIR_SEGMENTS: Record<NodePlatform, string[]> = {
  darwin: ['mac', 'darwin'],
  linux: ['linux'],
  win32: ['win', 'win32'],
}

/** Module name prefixes that mark a module as platform-specific, per platform. */
const PLATFORM_MODULE_NAMES: Record<NodePlatform, RegExp[]> = {
  darwin: [/^mac-/, /^darwin-/],
  linux: [/^linux-/],
  win32: [/^win-/, /^windows-/],
}

/** Path segment prefixes that mark a part as platform-specific, per platform. */
const PLATFORM_PREFIX_PATTERNS: Record<NodePlatform, RegExp> = {
  darwin: /^darwin-/,
  linux: /^linux-/,
  win32: /^win32-/,
}

const PLATFORM_TRIPLE_RE = /-(win32|darwin|linux)-(x64|arm64|ia32|arm)(?:-|$)/

const TRIPLE_PLATFORMS: Record<string, NodePlatform> = {
  win32: NodePlatform.WIN32,
  darwin: NodePlatform.DARWIN,
  linux: NodePlatform.LINUX,
}

export function isExcludedPlatformPath(
  filePath: string,
  moduleRootPath: string,
  targetPlatform: NodePlatform,
  moduleName: string,
): boolean {
  const relFromModuleRoot = path.relative(moduleRootPath, filePath)
  if (!relFromModuleRoot) return false

  const parts = relFromModuleRoot.split(/[/\\]/)

  for (const [platform, segments] of Object.entries(PLATFORM_DIR_SEGMENTS)) {
    if (platform === targetPlatform) continue
    for (const segment of segments) {
      if (parts.includes(segment)) return true
    }
  }

  if (moduleName) {
    const segments = moduleName.split(path.sep)
    const shortName = segments.length > 1 ? (segments[segments.length - 1] as string) : moduleName
    const triple = PLATFORM_TRIPLE_RE.exec(shortName)
    if (triple) {
      const variantPlatform = TRIPLE_PLATFORMS[triple[1] as string]
      if (variantPlatform !== undefined && variantPlatform !== targetPlatform) return true
    }
  }

  for (const [platform, pattern] of Object.entries(PLATFORM_PREFIX_PATTERNS)) {
    if (platform === targetPlatform) continue
    for (const part of parts) {
      if (pattern.test(part)) return true
    }
  }

  if (moduleName) {
    const segments = moduleName.split(path.sep)
    const shortName = segments.length > 1 ? (segments[segments.length - 1] as string) : moduleName
    for (const [platform, patterns] of Object.entries(PLATFORM_MODULE_NAMES)) {
      if (platform === targetPlatform) continue
      for (const pattern of patterns) {
        if (pattern.test(shortName)) return true
      }
    }
  }

  return false
}
