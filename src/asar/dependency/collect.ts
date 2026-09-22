import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../../shared/logger.ts'
import { detectPackageManager, PackageManager } from './detector.ts'
import {
  buildProductionGraphFromFlat,
  collectFromObjectTree,
  execCommand,
  extractJsonFromOutput,
  extractProdGraphFromObjectTree,
  type FlatDependency,
  type HoistedNodeModule,
  type RawDependencyInfo,
  readRootPkgJson,
  resolvePackageDir,
  runHoistPipeline,
} from './utils.ts'

interface PkgJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface CollectorResult {
  nodeModules: HoistedNodeModule[]
}

/** A "bun pm ls --json" tree node. */
interface BunDep {
  name?: string
  version?: string
  dependencies?: BunDep[]
}

/** A package.json on disk whose version field is required. */
interface VersionedPkgJson extends PkgJson {
  version: string
}

type ProductionGraph = Record<string, { dependencies: string[] }>

export async function collectProductionDeps(
  projectDir: string,
  workspaceRoot: string | undefined,
): Promise<HoistedNodeModule[]> {
  const searchDirectories = Array.from(new Set([projectDir, workspaceRoot].filter(Boolean)))

  for (const searchDir of searchDirectories) {
    if (!searchDir) continue
    const pm = await detectPackageManager(searchDir)
    logger.info(`    Detected package manager: ${pm} (searchDir: ${searchDir})`)

    let collectorResult: CollectorResult | null = null

    const collectorFor: Record<PackageManager, (dir: string) => Promise<CollectorResult>> = {
      [PackageManager.NPM]: collectFromNpm,
      [PackageManager.YARN]: (dir) => collectFromYarn(dir, false),
      [PackageManager.YARN_BERRY]: (dir) => collectFromYarn(dir, true),
      [PackageManager.PNPM]: collectFromPnpm,
      [PackageManager.BUN]: collectFromBun,
    }
    collectorResult = await tryCollect(pm, () => collectorFor[pm](searchDir))

    if (collectorResult && collectorResult.nodeModules.length > 0)
      return collectorResult.nodeModules

    logger.info(`    No node modules found in ${searchDir}, trying next search directory`)
  }

  logger.info('    Falling back to traversal-based dependency collection')
  const collectorResult = await collectFromTraversal(projectDir)
  return collectorResult.nodeModules
}

/** Run a package-manager collector with shared error handling. */
async function tryCollect(
  pm: string,
  collect: () => Promise<CollectorResult>,
): Promise<CollectorResult> {
  try {
    return await collect()
  } catch (e) {
    logger.info(`    ${pm} collection failed: ${e instanceof Error ? e.message : String(e)}`)
    return { nodeModules: [] }
  }
}

/** Collect production dependencies via `npm list --json`. */
async function collectFromNpm(projectDir: string): Promise<CollectorResult> {
  const { stdout, error } = await execCommand(
    'npm',
    [
      'list',
      '-a',
      '--include',
      'prod',
      '--include',
      'optional',
      '--omit',
      'dev',
      '--json',
      '--long',
      '--silent',
      '--loglevel=error',
    ],
    projectDir,
  )

  if (error && !stdout) {
    logger.info(`    npm list failed: ${error.message}`)
    return { nodeModules: [] }
  }

  const parsed = extractJsonFromOutput(stdout)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.info('    npm list returned no dependency tree')
    return { nodeModules: [] }
  }
  const tree = parsed as RawDependencyInfo & {
    dependencies?: Record<string, RawDependencyInfo>
    optionalDependencies?: Record<string, RawDependencyInfo>
  }
  const { rootKey } = await readRootPkgJson(projectDir)

  const allDependencies = new Map<string, FlatDependency>()
  collectFromObjectTree(tree.dependencies, allDependencies)

  const productionGraph: ProductionGraph = {}
  extractProdGraphFromObjectTree(tree, rootKey, productionGraph, allDependencies)

  return runHoistPipeline(allDependencies, productionGraph, rootKey)
}

/** Collect production dependencies via `pnpm list --json`. */
async function collectFromPnpm(projectDir: string): Promise<CollectorResult> {
  const { stdout, error } = await execCommand(
    'pnpm',
    ['list', '--prod', '--json', '--depth', 'Infinity', '--silent'],
    projectDir,
  )

  if (error && !stdout) {
    logger.info(`    pnpm list failed: ${error.message}`)
    return { nodeModules: [] }
  }

  const trees = extractJsonFromOutput(stdout)
  const arr = (Array.isArray(trees) ? trees : [trees]).filter(
    (
      it,
    ): it is RawDependencyInfo & {
      dependencies?: Record<string, RawDependencyInfo>
      optionalDependencies?: Record<string, RawDependencyInfo>
    } => !!it && typeof it === 'object',
  )
  const { rootKey } = await readRootPkgJson(projectDir)

  const allDependencies = new Map<string, FlatDependency>()
  const productionGraph: ProductionGraph = {}
  for (const tree of arr as (RawDependencyInfo & {
    dependencies?: Record<string, RawDependencyInfo>
    optionalDependencies?: Record<string, RawDependencyInfo>
  })[]) {
    collectFromObjectTree(tree.dependencies, allDependencies)
    extractProdGraphFromObjectTree(tree, rootKey, productionGraph, allDependencies)
  }

  return runHoistPipeline(allDependencies, productionGraph, rootKey)
}

async function collectFromYarn(projectDir: string, isBerry: boolean): Promise<CollectorResult> {
  const allDependencies = new Map<string, FlatDependency>()
  const productionGraph: ProductionGraph = {}

  if (isBerry) {
    const { stdout, error } = await execCommand(
      'yarn',
      ['workspaces', 'list', '--json'],
      projectDir,
    )
    if (error && !stdout) {
      logger.info(`    yarn workspaces list failed: ${error.message}`)
      return { nodeModules: [] }
    }
    const { rootKey } = await readRootPkgJson(projectDir)
    collectAllDependenciesFromYarnBerry(stdout, projectDir, allDependencies)
    const rootPkg = JSON.parse(
      readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
    ) as PkgJson
    extractProductionGraphForPackage(
      rootPkg,
      rootKey,
      productionGraph,
      allDependencies,
      path.join(projectDir, 'node_modules'),
    )
    return runHoistPipeline(allDependencies, productionGraph, rootKey)
  }

  const { stdout, error } = await execCommand(
    'yarn',
    ['list', '--production', '--json', '--silent'],
    projectDir,
  )
  if (error && !stdout) {
    logger.info(`    yarn list failed: ${error.message}`)
    return { nodeModules: [] }
  }
  const { rootKey } = await readRootPkgJson(projectDir)
  collectAllDependenciesFromYarnClassic(stdout, projectDir, allDependencies)
  buildProductionGraphFromFlat(allDependencies, productionGraph, rootKey)
  return runHoistPipeline(allDependencies, productionGraph, rootKey)
}

function collectAllDependenciesFromYarnClassic(
  stdout: string,
  projectDir: string,
  allDependencies: Map<string, FlatDependency>,
): void {
  const nmDir = path.join(projectDir, 'node_modules')
  try {
    const lines = stdout.trim().split('\n')
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        type?: string
        data?: { trees?: { name: string }[] }
      }
      if (entry.type !== 'tree') continue
      const trees = entry.data?.trees || []
      for (const tree of trees) {
        const name = tree.name
        const color = name.lastIndexOf('@')
        const pkgName = color > 0 ? name.substring(0, color) : name
        const version = color > 0 ? name.substring(color + 1) : ''
        const pkgDir = resolvePackageDir(nmDir, pkgName)
        if (pkgDir) {
          allDependencies.set(`${pkgName}@${version}`, { name: pkgName, version, path: pkgDir })
        }
      }
    }
  } catch {}
}

function collectAllDependenciesFromYarnBerry(
  stdout: string,
  projectDir: string,
  allDependencies: Map<string, FlatDependency>,
): void {
  try {
    const lines = stdout.trim().split('\n')
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        location?: string
        name?: string
        version?: string
      }
      if (entry.location && entry.name) {
        const pkgDir = path.resolve(projectDir, entry.location)
        if (existsSync(pkgDir)) {
          const key = `${entry.name}@${entry.version || 'unknown'}`
          allDependencies.set(key, {
            name: entry.name,
            version: entry.version || '',
            path: pkgDir,
          })
        }
      }
    }
  } catch {}
}

/**
 * Recursively build the production dependency graph for a package: walk
 * its production deps on disk, resolve each child's versioned key, and
 * recurse. Shared by the yarn-berry collector (root + transitive packages).
 */
function extractProductionGraphForPackage(
  pkg: PkgJson,
  dependencyId: string,
  productionGraph: ProductionGraph,
  allDependencies: Map<string, FlatDependency>,
  nmDir: string,
): void {
  if (productionGraph[dependencyId]) return
  productionGraph[dependencyId] = { dependencies: [] }
  const collectedDependencies: string[] = []
  const prodDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
  for (const name of Object.keys(prodDeps)) {
    const pkgDir = resolvePackageDir(nmDir, name)
    if (!pkgDir) continue
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    try {
      const childPkg = readVersionedPkgJson(pkgJsonPath)
      const childKey = `${name}@${childPkg.version}`
      if (!productionGraph[dependencyId] || allDependencies.has(childKey)) {
        extractProductionGraphForPackage(
          childPkg,
          childKey,
          productionGraph,
          allDependencies,
          nmDir,
        )
      }
      collectedDependencies.push(childKey)
    } catch {}
  }
  productionGraph[dependencyId] = { dependencies: collectedDependencies }
}

/** Collect production dependencies via `bun pm ls --json`. */
async function collectFromBun(projectDir: string): Promise<CollectorResult> {
  const { stdout, error } = await execCommand('bun', ['pm', 'ls', '--json'], projectDir)

  if (error && !stdout) {
    logger.info(`    bun pm ls failed: ${error.message}`)
    return { nodeModules: [] }
  }

  const tree = extractJsonFromOutput(stdout)
  const { rootKey } = await readRootPkgJson(projectDir)

  const allDependencies = new Map<string, FlatDependency>()
  collectAllDependenciesFromBunTree(tree, path.join(projectDir, 'node_modules'), allDependencies)

  const productionGraph: ProductionGraph = {}
  buildProductionGraphFromFlat(allDependencies, productionGraph, rootKey)

  return runHoistPipeline(allDependencies, productionGraph, rootKey)
}

function isBunDep(value: unknown): value is BunDep {
  return typeof value === 'object' && value !== null
}

function collectAllDependenciesFromBunTree(
  deps: unknown,
  nmDir: string,
  allDependencies: Map<string, FlatDependency>,
): void {
  if (!deps || !Array.isArray(deps)) return
  for (const dep of deps) {
    if (!isBunDep(dep) || !dep.name) continue
    const pkgDir = resolvePackageDir(nmDir, dep.name)
    if (pkgDir) {
      const key = `${dep.name}@${dep.version || 'unknown'}`
      allDependencies.set(key, { name: dep.name, version: dep.version || '', path: pkgDir })
    }
    if (dep.dependencies) {
      collectAllDependenciesFromBunTree(dep.dependencies, nmDir, allDependencies)
    }
  }
}

/** Fallback: collect dependencies by traversing node_modules on disk. */
async function collectFromTraversal(projectDir: string): Promise<CollectorResult> {
  const nmDir = path.join(projectDir, 'node_modules')
  if (!existsSync(nmDir)) {
    return { nodeModules: [] }
  }

  const allDependencies = new Map<string, FlatDependency>()
  const productionGraph: ProductionGraph = {}
  const visited = new Set<string>()
  const queue: string[] = []

  const rootPkg = readVersionedPkgJson(path.join(projectDir, 'package.json'))
  const rootKey = `${rootPkg.name}@${rootPkg.version}`
  const rootProdDeps: string[] = []
  const rootDeps = { ...(rootPkg.dependencies || {}), ...(rootPkg.optionalDependencies || {}) }

  for (const name of Object.keys(rootDeps)) {
    queue.push(name)
  }

  while (queue.length > 0) {
    const name = queue.shift()
    if (!name || visited.has(name)) continue
    visited.add(name)

    const pkgDir = resolvePackageDir(nmDir, name)
    if (!pkgDir || !existsSync(pkgDir)) continue

    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue

    try {
      const pkg = readVersionedPkgJson(pkgJsonPath)
      const key = `${name}@${pkg.version}`
      allDependencies.set(key, { name, version: pkg.version, path: pkgDir })

      const prodDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
      for (const dep of Object.keys(prodDeps)) {
        if (!visited.has(dep)) queue.push(dep)
      }
      productionGraph[key] = { dependencies: [] }

      if (rootDeps[name] !== undefined) {
        rootProdDeps.push(key)
      }
    } catch {}
  }

  for (const [key, info] of allDependencies) {
    if (!productionGraph[key]) continue
    const pkgJsonPath = path.join(info.path, 'package.json')
    try {
      const pkg = readVersionedPkgJson(pkgJsonPath)
      const childKeys: string[] = []
      const prodDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
      for (const depName of Object.keys(prodDeps)) {
        const childDir = resolvePackageDir(nmDir, depName)
        if (!childDir) continue
        const childPkgJsonPath = path.join(childDir, 'package.json')
        if (!existsSync(childPkgJsonPath)) continue
        const childPkg = readVersionedPkgJson(childPkgJsonPath)
        childKeys.push(`${depName}@${childPkg.version}`)
      }
      productionGraph[key] = { dependencies: childKeys }
    } catch {}
  }

  productionGraph[rootKey] = { dependencies: rootProdDeps }

  return runHoistPipeline(allDependencies, productionGraph, rootKey)
}

/** Read and parse a package.json, requiring the version field. */
function readVersionedPkgJson(pkgJsonPath: string): VersionedPkgJson {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PkgJson
  if (!pkg.version) {
    throw new Error(`package.json missing version: ${pkgJsonPath}`)
  }
  return pkg as VersionedPkgJson
}
