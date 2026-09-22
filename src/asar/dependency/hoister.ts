import { parseNameVersion } from './utils.ts'

const HoisterDependencyKind = { REGULAR: 0, WORKSPACE: 1, EXTERNAL_SOFT_LINK: 2 } as const
const Hoistable = { YES: 0, NO: 1, DEPENDS: 2 } as const
const DebugLevel = { NONE: -1, PERF: 0, CHECK: 1, REASONS: 2, INTENSIVE_CHECK: 9 } as const

/** Compose a locator string from name and reference. */
const makeLocator = (name: string, reference: string): string => `${name}@${reference}`

/** Compose an ident string, stripping any hash portion from the reference. */
const makeIdent = (name: string, reference: string): string => {
  const hashIdx = reference.indexOf('#')
  const realReference = hashIdx >= 0 ? reference.substring(hashIdx + 1) : reference
  return makeLocator(name, realReference)
}

/** Input tree produced by transformToHoisterTree. */
export interface HoisterTreeNode {
  name: string
  identName: string
  reference: string
  peerNames: Set<string>
  dependencies: Set<HoisterTreeNode>
  hoistPriority?: number
  dependencyKind?: number
}

/** Mutable work node used during hoisting rounds. */
interface WorkNode {
  name: string
  references: Set<string>
  ident: string
  locator: string
  dependencies: Map<string, WorkNode>
  originalDependencies: Map<string, WorkNode>
  hoistedDependencies: Map<string, WorkNode>
  peerNames: Set<string>
  reasons: Map<string, string | null>
  decoupled: boolean
  isHoistBorder: boolean
  hoistPriority: number
  dependencyKind: number
  hoistedFrom: Map<string, Set<string>>
  hoistedTo: Map<string, Set<string>>
}

/** Immutable shrunk tree returned by hoist. */
export interface ShrunkNode {
  name: string
  identName: string
  references: Set<string>
  dependencies: Set<ShrunkNode>
}

interface PreferenceEntry {
  dependents: Set<string>
  peerDependents: Set<string>
  hoistPriority: number
}

interface HoistInfo {
  isHoistable: (typeof Hoistable)[keyof typeof Hoistable]
  dependsOn?: Set<WorkNode> | null
  reason: string | null
}

interface HoistOptions {
  debugLevel?: number
  check?: boolean
  hoistingLimits?: Map<string, Set<string>>
}

interface HoistToOptions {
  check: boolean
  debugLevel: number
  hoistingLimits: Map<string, Set<string>>
  fastLookupPossible: boolean
}

interface RoundResult {
  anotherRoundNeeded: boolean
  isGraphChanged: boolean
}

export function hoist(tree: HoisterTreeNode, opts: HoistOptions = {}): ShrunkNode {
  const debugLevel = opts.debugLevel || DebugLevel.NONE
  const check = opts.check || debugLevel >= DebugLevel.INTENSIVE_CHECK
  const hoistingLimits = opts.hoistingLimits || new Map<string, Set<string>>()
  const options: HoistToOptions = { check, debugLevel, hoistingLimits, fastLookupPossible: true }

  const treeCopy = cloneTree(tree, options)
  let anotherRoundNeeded = false
  do {
    const result = hoistTo(treeCopy, [treeCopy], new Set([treeCopy.locator]), new Map(), options)
    anotherRoundNeeded = result.anotherRoundNeeded || result.isGraphChanged
    options.fastLookupPossible = false
  } while (anotherRoundNeeded)

  return shrinkTree(treeCopy)
}

export function transformToHoisterTree(
  productionGraph: Record<string, { dependencies?: string[] }>,
  key: string,
  nodes: Map<string, HoisterTreeNode> = new Map(),
): HoisterTreeNode {
  let node = nodes.get(key)
  const { name, version } = parseNameVersion(key)
  if (!node) {
    node = {
      name,
      identName: name,
      reference: version,
      peerNames: new Set(),
      dependencies: new Set(),
    }
    nodes.set(key, node)
    const deps = productionGraph[key]?.dependencies || []
    for (const dep of deps) {
      const child = transformToHoisterTree(productionGraph, dep, nodes)
      node.dependencies.add(child)
    }
  }
  return node
}
/** Collect dependencies used before the first hoisting round. */
const getZeroRoundUsedDependencies = (rootNodePath: WorkNode[]): Map<string, WorkNode> => {
  const rootNode = rootNodePath[rootNodePath.length - 1]
  const usedDependencies = new Map<string, WorkNode>()
  const seenNodes = new Set<WorkNode>()
  // Collect the zero-round reachable dependencies of the root node.
  const addUsedDependencies = (node: WorkNode): void => {
    if (seenNodes.has(node)) return
    seenNodes.add(node)
    for (const dep of node.hoistedDependencies.values()) usedDependencies.set(dep.name, dep)
    for (const dep of node.dependencies.values()) {
      if (!node.peerNames.has(dep.name)) addUsedDependencies(dep)
    }
  }
  addUsedDependencies(rootNode)
  return usedDependencies
}

/** Collect the dependencies reachable from the root node path. */
const getUsedDependencies = (rootNodePath: WorkNode[]): Map<string, WorkNode> => {
  const rootNode = rootNodePath[rootNodePath.length - 1]
  const usedDependencies = new Map<string, WorkNode>()
  const seenNodes = new Set<WorkNode>()
  // Collect reachable dependencies, skipping names in hiddenDependencies.
  const addUsedDependencies = (node: WorkNode, hiddenDependencies: Set<string>): void => {
    if (seenNodes.has(node)) return
    seenNodes.add(node)
    for (const dep of node.hoistedDependencies.values()) {
      if (!hiddenDependencies.has(dep.name)) {
        for (const pathNode of rootNodePath) {
          const reachableDependency = pathNode.dependencies.get(dep.name)
          if (reachableDependency)
            usedDependencies.set(reachableDependency.name, reachableDependency)
        }
      }
    }
    const childrenHiddenDependencies = new Set<string>()
    for (const dep of node.dependencies.values()) childrenHiddenDependencies.add(dep.name)
    for (const dep of node.dependencies.values()) {
      if (!node.peerNames.has(dep.name)) addUsedDependencies(dep, childrenHiddenDependencies)
    }
  }
  addUsedDependencies(rootNode, new Set())
  return usedDependencies
}

/** Clone a graph node so it can be re-parented without side effects. */
const decoupleGraphNode = (parent: WorkNode, node: WorkNode): WorkNode => {
  if (node.decoupled) return node
  const clone: WorkNode = {
    name: node.name,
    references: new Set(node.references),
    ident: node.ident,
    locator: node.locator,
    dependencies: new Map(node.dependencies),
    originalDependencies: new Map(node.originalDependencies),
    hoistedDependencies: new Map(node.hoistedDependencies),
    peerNames: new Set(node.peerNames),
    reasons: new Map(node.reasons),
    decoupled: true,
    isHoistBorder: node.isHoistBorder,
    hoistPriority: node.hoistPriority,
    dependencyKind: node.dependencyKind,
    hoistedFrom: new Map(node.hoistedFrom),
    hoistedTo: new Map(node.hoistedTo),
  }
  const selfDep = clone.dependencies.get(node.name)
  if (selfDep && selfDep.ident === clone.ident) clone.dependencies.set(node.name, clone)
  parent.dependencies.set(clone.name, clone)
  return clone
}

/** Map each dependency name to its list of acceptable idents, ordered by hoist priority. */
const getHoistIdentMap = (
  rootNode: WorkNode,
  preferenceMap: Map<string, PreferenceEntry>,
): Map<string, string[]> => {
  const identMap = new Map<string, string[]>([[rootNode.name, [rootNode.ident]]])
  for (const dep of rootNode.dependencies.values()) {
    if (!rootNode.peerNames.has(dep.name)) identMap.set(dep.name, [dep.ident])
  }
  const keyList = Array.from(preferenceMap.keys())
  keyList.sort((key1, key2) => {
    const entry1 = preferenceMap.get(key1)
    const entry2 = preferenceMap.get(key2)
    if (!entry1 || !entry2) return 0
    if (entry2.hoistPriority !== entry1.hoistPriority)
      return entry2.hoistPriority - entry1.hoistPriority
    const entry1Usages = entry1.dependents.size + entry1.peerDependents.size
    const entry2Usages = entry2.dependents.size + entry2.peerDependents.size
    return entry2Usages - entry1Usages
  })
  for (const key of keyList) {
    const name = key.substring(0, key.indexOf('@', 1))
    const ident = key.substring(name.length + 1)
    if (!rootNode.peerNames.has(name)) {
      let idents = identMap.get(name)
      if (!idents) {
        idents = []
        identMap.set(name, idents)
      }
      if (idents.indexOf(ident) < 0) idents.push(ident)
    }
  }
  return identMap
}

/** Sort the regular (non-peer) dependencies of a node into a Set. */
const getSortedRegularDependencies = (node: WorkNode): Set<WorkNode> => {
  const dependencies = new Set<WorkNode>()
  // Add a dependency and its transitive non-shadowed peers.
  const addDep = (dep: WorkNode, seenDeps: Set<WorkNode> = new Set()): void => {
    if (seenDeps.has(dep)) return
    seenDeps.add(dep)
    for (const peerName of dep.peerNames) {
      if (!node.peerNames.has(peerName)) {
        const peerDep = node.dependencies.get(peerName)
        if (peerDep && !dependencies.has(peerDep)) addDep(peerDep, seenDeps)
      }
    }
    dependencies.add(dep)
  }
  for (const dep of node.dependencies.values()) {
    if (!node.peerNames.has(dep.name)) addDep(dep)
  }
  return dependencies
}

const hoistTo = (
  tree: WorkNode,
  rootNodePath: WorkNode[],
  rootNodePathLocators: Set<string>,
  parentShadowedNodes: Map<WorkNode, Set<string>>,
  options: HoistToOptions,
  seenNodes: Set<WorkNode> = new Set(),
): RoundResult => {
  const rootNode = rootNodePath[rootNodePath.length - 1]
  if (seenNodes.has(rootNode)) return { anotherRoundNeeded: false, isGraphChanged: false }
  seenNodes.add(rootNode)
  const preferenceMap = buildPreferenceMap(rootNode)
  const hoistIdentMap = getHoistIdentMap(rootNode, preferenceMap)
  const usedDependencies =
    tree === rootNode
      ? new Map<string, WorkNode>()
      : options.fastLookupPossible
        ? getZeroRoundUsedDependencies(rootNodePath)
        : getUsedDependencies(rootNodePath)
  let wasStateChanged: boolean
  let anotherRoundNeeded = false
  let isGraphChanged = false
  const hoistIdents = new Map(
    Array.from(hoistIdentMap.entries()).map(([k, v]) => [k, v[0]] as const),
  )
  const shadowedNodes = new Map<WorkNode, Set<string>>()
  do {
    const result = hoistGraph(
      tree,
      rootNodePath,
      rootNodePathLocators,
      usedDependencies,
      hoistIdents,
      hoistIdentMap,
      parentShadowedNodes,
      shadowedNodes,
      options,
    )
    if (result.isGraphChanged) isGraphChanged = true
    if (result.anotherRoundNeeded) anotherRoundNeeded = true
    wasStateChanged = false
    for (const [name, idents] of hoistIdentMap) {
      if (idents.length > 1 && !rootNode.dependencies.has(name)) {
        hoistIdents.delete(name)
        idents.shift()
        hoistIdents.set(name, idents[0])
        wasStateChanged = true
      }
    }
  } while (wasStateChanged)
  for (const dependency of rootNode.dependencies.values()) {
    if (!rootNode.peerNames.has(dependency.name) && !rootNodePathLocators.has(dependency.locator)) {
      rootNodePathLocators.add(dependency.locator)
      const result = hoistTo(
        tree,
        [...rootNodePath, dependency],
        rootNodePathLocators,
        shadowedNodes,
        options,
      )
      if (result.isGraphChanged) isGraphChanged = true
      if (result.anotherRoundNeeded) anotherRoundNeeded = true
      rootNodePathLocators.delete(dependency.locator)
    }
  }
  return { anotherRoundNeeded, isGraphChanged }
}

/** Check whether a node still has unhoisted non-peer dependencies. */
const hasUnhoistedDependencies = (node: WorkNode): boolean => {
  for (const [subName, subDependency] of node.dependencies) {
    if (!node.peerNames.has(subName) && subDependency.ident !== node.ident) return true
  }
  return false
}

const getNodeHoistInfo = (
  rootNode: WorkNode,
  _rootNodePathLocators: Set<string>,
  nodePath: WorkNode[],
  node: WorkNode,
  usedDependencies: Map<string, WorkNode>,
  hoistIdents: Map<string, string>,
  _hoistIdentMap: Map<string, string[]>,
  shadowedNodes: Map<WorkNode, Set<string>>,
  { fastLookupPossible }: { fastLookupPossible: boolean },
): HoistInfo => {
  const reason: string | null = null
  let dependsOn: Set<WorkNode> | null = new Set()
  const parentNode = nodePath[nodePath.length - 1]
  const isSelfReference = node.ident === parentNode.ident
  let isHoistable = !isSelfReference
  if (isHoistable) isHoistable = node.dependencyKind !== HoisterDependencyKind.WORKSPACE
  if (isHoistable && node.dependencyKind === HoisterDependencyKind.EXTERNAL_SOFT_LINK) {
    isHoistable = !hasUnhoistedDependencies(node)
  }
  if (isHoistable) isHoistable = !rootNode.peerNames.has(node.name)
  if (isHoistable) {
    const usedDep = usedDependencies.get(node.name)
    const isNameAvailable = !usedDep || usedDep.ident === node.ident
    isHoistable = isNameAvailable
  }
  if (isHoistable && isNameShadowed(node, nodePath, shadowedNodes)) {
    isHoistable = false
  }
  if (isHoistable) {
    const hoistedIdent = hoistIdents.get(node.name)
    isHoistable = hoistedIdent === node.ident
  }
  if (isHoistable) {
    const peerCheck = checkPeerDeps(node, rootNode, nodePath)
    dependsOn = peerCheck.dependsOn
    isHoistable = peerCheck.arePeerDepsSatisfied
  }
  if (isHoistable && !fastLookupPossible) {
    for (const origDep of node.hoistedDependencies.values()) {
      const usedDep = usedDependencies.get(origDep.name) || rootNode.dependencies.get(origDep.name)
      if (!usedDep || origDep.ident !== usedDep.ident) {
        isHoistable = false
        break
      }
    }
  }
  if (dependsOn !== null && dependsOn.size > 0)
    return { isHoistable: Hoistable.DEPENDS, dependsOn, reason }
  return { isHoistable: isHoistable ? Hoistable.YES : Hoistable.NO, reason }
}

/** Compose the alias locator for a node (name@locator). */
const getAliasedLocator = (node: WorkNode): string => `${node.name}@${node.locator}`

const hoistGraph = (
  _tree: WorkNode,
  rootNodePath: WorkNode[],
  rootNodePathLocators: Set<string>,
  usedDependencies: Map<string, WorkNode>,
  hoistIdents: Map<string, string>,
  hoistIdentMap: Map<string, string[]>,
  parentShadowedNodes: Map<WorkNode, Set<string>>,
  shadowedNodes: Map<WorkNode, Set<string>>,
  options: HoistToOptions,
): RoundResult => {
  const rootNode = rootNodePath[rootNodePath.length - 1]
  const seenNodes = new Set<WorkNode>()
  let anotherRoundNeeded = false
  let isGraphChanged = false
  const hoistNodeDependencies = (
    nodePath: WorkNode[],
    locatorPath: string[],
    aliasedLocatorPath: string[],
    parentNode: WorkNode,
    newNodes: Set<WorkNode>,
  ): void => {
    if (seenNodes.has(parentNode)) return
    const nextLocatorPath = [...locatorPath, getAliasedLocator(parentNode)]
    const nextAliasedLocatorPath = [...aliasedLocatorPath, getAliasedLocator(parentNode)]
    const dependantTree = new Map<string, Set<string>>()
    const hoistInfos = new Map<WorkNode, HoistInfo>()
    for (const subDependency of getSortedRegularDependencies(parentNode)) {
      const hoistInfo = getNodeHoistInfo(
        rootNode,
        rootNodePathLocators,
        [rootNode, ...nodePath, parentNode],
        subDependency,
        usedDependencies,
        hoistIdents,
        hoistIdentMap,
        shadowedNodes,
        { fastLookupPossible: options.fastLookupPossible },
      )
      hoistInfos.set(subDependency, hoistInfo)
      if (hoistInfo.isHoistable === Hoistable.DEPENDS) {
        for (const node of hoistInfo.dependsOn || []) {
          const nodeDependants = dependantTree.get(node.name) || new Set<string>()
          nodeDependants.add(subDependency.name)
          dependantTree.set(node.name, nodeDependants)
        }
      }
    }
    const unhoistableNodes = new Set<WorkNode>()
    // Mark a node unhoistable and cascade to its dependants.
    const addUnhoistableNode = (node: WorkNode | undefined, hoistInfo: HoistInfo): void => {
      if (!node || unhoistableNodes.has(node)) return
      unhoistableNodes.add(node)
      hoistInfos.set(node, { isHoistable: Hoistable.NO, reason: hoistInfo.reason })
      for (const dependantName of dependantTree.get(node.name) || []) {
        addUnhoistableNode(parentNode.dependencies.get(dependantName), hoistInfo)
      }
    }
    for (const [node, hoistInfo] of hoistInfos)
      if (hoistInfo.isHoistable === Hoistable.NO) addUnhoistableNode(node, hoistInfo)
    let wereNodesHoisted = false
    for (const node of hoistInfos.keys()) {
      if (!unhoistableNodes.has(node)) {
        isGraphChanged = true
        const shadowedNames = parentShadowedNodes.get(parentNode)
        if (shadowedNames?.has(node.name)) anotherRoundNeeded = true
        wereNodesHoisted = true
        parentNode.dependencies.delete(node.name)
        parentNode.hoistedDependencies.set(node.name, node)
        parentNode.reasons.delete(node.name)
        const hoistedNode = rootNode.dependencies.get(node.name)
        if (!hoistedNode) {
          if (rootNode.ident !== node.ident) {
            rootNode.dependencies.set(node.name, node)
            newNodes.add(node)
          }
        } else {
          for (const reference of node.references) hoistedNode.references.add(reference)
        }
      }
    }
    if (parentNode.dependencyKind === HoisterDependencyKind.EXTERNAL_SOFT_LINK && wereNodesHoisted)
      anotherRoundNeeded = true
    const children = getSortedRegularDependencies(parentNode)
    for (const node of children) {
      if (unhoistableNodes.has(node)) {
        const hoistInfo = hoistInfos.get(node)
        if (!hoistInfo) continue
        const hoistableIdent = hoistIdents.get(node.name)
        if (
          (hoistableIdent === node.ident || !parentNode.reasons.has(node.name)) &&
          hoistInfo.isHoistable !== Hoistable.YES
        )
          parentNode.reasons.set(node.name, hoistInfo.reason)
        if (!node.isHoistBorder && nextAliasedLocatorPath.indexOf(getAliasedLocator(node)) < 0) {
          seenNodes.add(parentNode)
          const decoupledNode = decoupleGraphNode(parentNode, node)
          hoistNodeDependencies(
            [...nodePath, parentNode],
            nextLocatorPath,
            nextAliasedLocatorPath,
            decoupledNode,
            nextNewNodes,
          )
          seenNodes.delete(parentNode)
        }
      }
    }
  }
  let newNodes: Set<WorkNode>
  let nextNewNodes = new Set<WorkNode>(getSortedRegularDependencies(rootNode))
  const aliasedRootNodePathLocators = Array.from(rootNodePath).map((x) => getAliasedLocator(x))
  do {
    newNodes = nextNewNodes
    nextNewNodes = new Set<WorkNode>()
    for (const dep of newNodes) {
      if (dep.locator === rootNode.locator || dep.isHoistBorder) continue
      const decoupledDependency = decoupleGraphNode(rootNode, dep)
      hoistNodeDependencies(
        [],
        Array.from(rootNodePathLocators),
        aliasedRootNodePathLocators,
        decoupledDependency,
        nextNewNodes,
      )
    }
  } while (nextNewNodes.size > 0)
  return { anotherRoundNeeded, isGraphChanged }
}

const cloneTree = (tree: HoisterTreeNode, options: HoistToOptions): WorkNode => {
  const treeCopy: WorkNode = {
    name: tree.name,
    references: new Set([tree.reference]),
    locator: makeLocator(tree.identName, tree.reference),
    ident: makeIdent(tree.identName, tree.reference),
    dependencies: new Map(),
    originalDependencies: new Map(),
    hoistedDependencies: new Map(),
    peerNames: new Set(tree.peerNames),
    reasons: new Map(),
    decoupled: true,
    isHoistBorder: true,
    hoistPriority: 0,
    dependencyKind: HoisterDependencyKind.WORKSPACE,
    hoistedFrom: new Map(),
    hoistedTo: new Map(),
  }
  const seenNodes = new Map<HoisterTreeNode, WorkNode>([[tree, treeCopy]])
  // Recursively copy a node and its dependencies into work nodes.
  const addNode = (node: HoisterTreeNode, parentNode: WorkNode): void => {
    const existing = seenNodes.get(node)
    const isSeen = existing !== undefined
    let workNode: WorkNode
    if (!isSeen) {
      const dependenciesNmHoistingLimits = options.hoistingLimits.get(parentNode.locator)
      workNode = {
        name: node.name,
        references: new Set([node.reference]),
        locator: makeLocator(node.identName, node.reference),
        ident: makeIdent(node.identName, node.reference),
        dependencies: new Map(),
        originalDependencies: new Map(),
        hoistedDependencies: new Map(),
        peerNames: new Set(node.peerNames),
        reasons: new Map(),
        decoupled: true,
        isHoistBorder: dependenciesNmHoistingLimits
          ? dependenciesNmHoistingLimits.has(node.name)
          : false,
        hoistPriority: node.hoistPriority || 0,
        dependencyKind: node.dependencyKind || HoisterDependencyKind.REGULAR,
        hoistedFrom: new Map(),
        hoistedTo: new Map(),
      }
      seenNodes.set(node, workNode)
    } else {
      workNode = existing
    }
    parentNode.dependencies.set(node.name, workNode)
    parentNode.originalDependencies.set(node.name, workNode)
    if (!isSeen) {
      for (const dep of node.dependencies) addNode(dep, workNode)
    } else {
      const seenCoupledNodes = new Set<WorkNode>()
      // Mark a work node and its dependencies as coupled (not decoupled).
      const markNodeCoupled = (node: WorkNode): void => {
        if (seenCoupledNodes.has(node)) return
        seenCoupledNodes.add(node)
        node.decoupled = false
        for (const dep of node.dependencies.values()) {
          if (!node.peerNames.has(dep.name)) markNodeCoupled(dep)
        }
      }
      markNodeCoupled(workNode)
    }
  }
  for (const dep of tree.dependencies) addNode(dep, treeCopy)
  return treeCopy
}

/** Extract the ident name from a locator string. */
const getIdentName = (locator: string): string => locator.substring(0, locator.indexOf('@', 1))

/** Build a shrunk copy of the dependency tree for hoisting. */
const shrinkTree = (tree: WorkNode): ShrunkNode => {
  const treeCopy: ShrunkNode = {
    name: tree.name,
    identName: getIdentName(tree.locator),
    references: new Set(tree.references),
    dependencies: new Set(),
  }
  const seenNodes = new Set<WorkNode>([tree])
  // Recursively add a node to the shrunk tree, reusing parent on self-reference.
  const addNode = (node: WorkNode, parentWorkNode: WorkNode, parentNode: ShrunkNode): void => {
    const isSeen = seenNodes.has(node)
    let resultNode: ShrunkNode
    if (parentWorkNode === node) {
      resultNode = parentNode
    } else {
      resultNode = {
        name: node.name,
        identName: getIdentName(node.locator),
        references: node.references,
        dependencies: new Set(),
      }
    }
    parentNode.dependencies.add(resultNode)
    if (!isSeen) {
      seenNodes.add(node)
      for (const dep of node.dependencies.values()) {
        if (!node.peerNames.has(dep.name)) addNode(dep, node, resultNode)
      }
      seenNodes.delete(node)
    }
  }
  for (const dep of tree.dependencies.values()) addNode(dep, tree, treeCopy)
  return treeCopy
}

/** Build a preference map (dependents / peer dependents / hoist priority). */
const buildPreferenceMap = (rootNode: WorkNode): Map<string, PreferenceEntry> => {
  const preferenceMap = new Map<string, PreferenceEntry>()
  const seenNodes = new Set<WorkNode>([rootNode])
  // Derive the preference map key for a node.
  const getPreferenceKey = (node: WorkNode): string => `${node.name}@${node.ident}`
  // Get or create the preference entry for a node.
  const getOrCreatePreferenceEntry = (node: WorkNode): PreferenceEntry => {
    const key = getPreferenceKey(node)
    let entry = preferenceMap.get(key)
    if (!entry) {
      entry = { dependents: new Set(), peerDependents: new Set(), hoistPriority: 0 }
      preferenceMap.set(key, entry)
    }
    return entry
  }
  // Register a dependent and recurse into the node's dependencies.
  const addDependent = (dependent: WorkNode, node: WorkNode): void => {
    const isSeen = !!seenNodes.has(node)
    const entry = getOrCreatePreferenceEntry(node)
    entry.dependents.add(dependent.ident)
    if (!isSeen) {
      seenNodes.add(node)
      for (const dep of node.dependencies.values()) {
        const depEntry = getOrCreatePreferenceEntry(dep)
        depEntry.hoistPriority = Math.max(depEntry.hoistPriority, dep.hoistPriority)
        if (node.peerNames.has(dep.name)) {
          depEntry.peerDependents.add(node.ident)
        } else {
          addDependent(node, dep)
        }
      }
    }
  }
  for (const dep of rootNode.dependencies.values())
    if (!rootNode.peerNames.has(dep.name)) addDependent(rootNode, dep)
  return preferenceMap
}

/** Check whether the node name is shadowed by an ancestor's different-ident dependency. */
function isNameShadowed(
  node: WorkNode,
  nodePath: WorkNode[],
  shadowedNodes: Map<WorkNode, Set<string>>,
): boolean {
  for (let idx = nodePath.length - 1; idx >= 1; idx--) {
    const parent = nodePath[idx]
    const parentDep = parent.dependencies.get(node.name)
    if (parentDep && parentDep.ident !== node.ident) {
      const parentNode = nodePath[nodePath.length - 1]
      let shadowedNames = shadowedNodes.get(parentNode)
      if (!shadowedNames) {
        shadowedNames = new Set<string>()
        shadowedNodes.set(parentNode, shadowedNames)
      }
      shadowedNames.add(node.name)
      return true
    }
  }
  return false
}

/** Check peer-dependency satisfaction along the node path. */
function checkPeerDeps(
  node: WorkNode,
  rootNode: WorkNode,
  nodePath: WorkNode[],
): { dependsOn: Set<WorkNode> | null; arePeerDepsSatisfied: boolean } {
  let dependsOn: Set<WorkNode> | null = new Set()
  let arePeerDepsSatisfied = true
  const checkList = new Set(node.peerNames)
  for (let idx = nodePath.length - 1; idx >= 1; idx--) {
    const parent = nodePath[idx]
    for (const name of checkList) {
      if (parent.peerNames.has(name) && parent.originalDependencies.has(name)) continue
      const parentDepNode = parent.dependencies.get(name)
      if (parentDepNode && rootNode.dependencies.get(name) !== parentDepNode) {
        if (idx === nodePath.length - 1) {
          if (dependsOn) dependsOn.add(parentDepNode)
        } else {
          dependsOn = null
          arePeerDepsSatisfied = false
        }
      }
      checkList.delete(name)
    }
    if (!arePeerDepsSatisfied) break
  }
  return { dependsOn, arePeerDepsSatisfied }
}
