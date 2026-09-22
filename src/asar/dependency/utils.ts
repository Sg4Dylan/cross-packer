import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath as realpathAsync } from 'node:fs/promises'
import path from 'node:path'
import { hoist, type ShrunkNode, transformToHoisterTree } from './hoister.ts'

/** Raw dependency info extracted from a package manager's dependency graph. */
export interface RawDependencyInfo {
  name: string
  version: string
  path?: string
  _dependencies?: Record<string, string>
  dependencies?: Record<string, RawDependencyInfo>
  optionalDependencies?: Record<string, RawDependencyInfo>
}

/** Flattened dependency entry stored in allDependencies. */
export interface FlatDependency {
  name: string
  version: string
  path: string
  _dependencies?: Record<string, string>
  dependencies?: Record<string, RawDependencyInfo>
  optionalDependencies?: Record<string, RawDependencyInfo>
}

/** Node in the hoisted node_modules output tree. */
export interface HoistedNodeModule {
  name: string
  version: string
  dir: string
  dependencies?: HoistedNodeModule[]
}

export function execCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        shell: true,
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', error })
      },
    )
  })
}

/** Parse JSON from a command output, tolerating surrounding log noise. */
export function extractJsonFromOutput(output: string): unknown {
  const trimmed = output.trim()
  try {
    return JSON.parse(trimmed)
  } catch {}

  const bracketOpen = Math.max(trimmed.indexOf('{'), 0)
  const bracketOpenSquare = Math.max(trimmed.indexOf('['), 0)
  const start = Math.min(bracketOpen, bracketOpenSquare)
  for (let i = start; i < trimmed.length; i++) {
    const slice = trimmed.slice(start, i + 1)
    try {
      return JSON.parse(slice)
    } catch {}
  }
  throw new Error('No JSON content found in output')
}

export function resolvePackageDir(nmDir: string, pkgName: string): string | null {
  if (pkgName.startsWith('@')) {
    const parts = pkgName.split('/')
    if (parts.length < 2) return null
    const dir = path.join(nmDir, parts[0], parts[1])
    return existsSync(dir) ? dir : null
  }
  const dir = path.join(nmDir, pkgName)
  return existsSync(dir) ? dir : null
}

export function isProdDependency(
  depName: string,
  pkg: Pick<RawDependencyInfo, '_dependencies' | 'dependencies' | 'optionalDependencies'>,
): boolean {
  const _deps = pkg._dependencies
  if (_deps) return _deps[depName] != null
  // Optional dependencies count as production deps when packing.
  const prodDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
  return prodDeps[depName] != null
}

/** Read the root package.json and derive its locator key. */
export async function readRootPkgJson(
  projectDir: string,
): Promise<{ name: string; version: string; rootKey: string }> {
  const pkgJson = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  return {
    name: pkgJson.name,
    version: pkgJson.version,
    rootKey: `${pkgJson.name}@${pkgJson.version}`,
  }
}

export async function runHoistPipeline(
  allDependencies: Map<string, FlatDependency>,
  productionGraph: Record<string, { dependencies: string[] }>,
  rootKey: string,
): Promise<{ nodeModules: HoistedNodeModule[] }> {
  const hoisterTree = transformToHoisterTree(productionGraph, rootKey)
  const hoistedResult = hoist(hoisterTree)
  const nodeModules = await getNodeModulesFromHoisted(hoistedResult.dependencies, allDependencies)
  return { nodeModules }
}

/** Detect npm's duplicated-dependency marker entries (no deps of their own). */
export function isDuplicatedNpmDependency(info: RawDependencyInfo | FlatDependency): boolean {
  const _deps = info._dependencies || {}
  const deps = info.dependencies || {}
  return Object.keys(_deps).length > 0 && Object.keys(deps).length === 0
}

export function collectFromObjectTree(
  deps: Record<string, RawDependencyInfo> | undefined,
  allDependencies: Map<string, FlatDependency>,
): void {
  if (!deps) return
  for (const [name, info] of Object.entries(deps)) {
    if (!info?.path) continue
    const pkgDir = path.resolve(info.path)
    const key = `${name}@${info.version}`
    const entry: FlatDependency = {
      name,
      version: info.version,
      path: pkgDir,
      _dependencies: info._dependencies,
      dependencies: info.dependencies,
      optionalDependencies: info.optionalDependencies,
    }
    if (!isDuplicatedNpmDependency(info) || !allDependencies.has(key)) {
      allDependencies.set(key, entry)
    }
    if (info.dependencies) {
      collectFromObjectTree(info.dependencies, allDependencies)
    }
  }
}

export function extractProdGraphFromObjectTree(
  tree: RawDependencyInfo | undefined,
  dependencyId: string,
  productionGraph: Record<string, { dependencies: string[] }>,
  allDependencies: Map<string, FlatDependency>,
): void {
  if (productionGraph[dependencyId]) return
  const isDuplicateDep = tree ? isDuplicatedNpmDependency(tree) : false
  const targetTree = isDuplicateDep ? allDependencies.get(dependencyId) : tree
  productionGraph[dependencyId] = { dependencies: [] }
  const collectedDependencies: string[] = []
  const deps = targetTree?.dependencies || {}
  for (const name of Object.keys(deps)) {
    const depInfo = deps[name]
    if (!depInfo || Object.keys(depInfo).length === 0) continue
    if (!targetTree || !isProdDependency(name, targetTree)) continue
    const childDependencyId = `${name}@${depInfo.version}`
    if (allDependencies.has(childDependencyId)) {
      extractProdGraphFromObjectTree(depInfo, childDependencyId, productionGraph, allDependencies)
    }
    collectedDependencies.push(childDependencyId)
  }
  productionGraph[dependencyId] = { dependencies: collectedDependencies }
}

export function buildProductionGraphFromFlat(
  allDependencies: Map<string, FlatDependency>,
  productionGraph: Record<string, { dependencies: string[] }>,
  rootKey: string,
): void {
  productionGraph[rootKey] = { dependencies: Array.from(allDependencies.keys()) }
  for (const [key] of allDependencies) {
    if (!productionGraph[key]) {
      productionGraph[key] = { dependencies: [] }
    }
  }
}

/** Split a "name@version" identifier into its parts. */
export function parseNameVersion(identifier: string): { name: string; version: string } {
  const lastAt = identifier.lastIndexOf('@')
  if (lastAt <= 0) return { name: identifier, version: 'unknown' }
  const name = identifier.slice(0, lastAt)
  const version = identifier.slice(lastAt + 1)
  return { name, version }
}

async function getNodeModulesFromHoisted(
  dependencies: Set<ShrunkNode>,
  allDependencies: Map<string, FlatDependency>,
  result: HoistedNodeModule[] = [],
): Promise<HoistedNodeModule[]> {
  if (dependencies.size === 0) return result
  for (const d of dependencies) {
    const reference = [...d.references][0]
    const key = `${d.name}@${reference}`
    const depInfo = allDependencies.get(key)
    if (depInfo === undefined || depInfo.path === undefined) continue
    const resolvedPath = await realpathAsync(depInfo.path).catch(() => depInfo.path)
    if (!existsSync(resolvedPath)) continue
    const node: HoistedNodeModule = { name: d.name, version: reference, dir: resolvedPath }
    result.push(node)
    if (d.dependencies.size > 0) {
      node.dependencies = []
      await getNodeModulesFromHoisted(d.dependencies, allDependencies, node.dependencies)
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}
