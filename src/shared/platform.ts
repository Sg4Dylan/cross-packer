/**
 * Cross-layer platform vocabulary: target platforms, architectures, and
 * Node.js host platforms. Zero project dependencies; both config and the
 * asar domain consume these enums.
 */
export enum Platform {
  WIN = 'win',
  MAC = 'mac',
  LINUX = 'linux',
}

export enum Arch {
  AMD64 = 'amd64',
  ARM64 = 'arm64',
}

export enum NodePlatform {
  WIN32 = 'win32',
  DARWIN = 'darwin',
  LINUX = 'linux',
}

export function nodeArchName(arch: Arch): 'x64' | 'arm64' {
  return arch === Arch.AMD64 ? 'x64' : 'arm64'
}

/** All runtime values of NodePlatform, used for narrowing `process.platform`. */
const NODE_PLATFORMS: readonly NodePlatform[] = Object.values(NodePlatform)

/**
 * Narrow the host's `process.platform` to NodePlatform.
 * Throws on unsupported hosts (node_modules collection is only defined
 * for win32 / darwin / linux).
 */
export function nodePlatformOf(host: NodeJS.Platform): NodePlatform {
  const narrow = NODE_PLATFORMS.find((p) => p === host)
  if (narrow === undefined) {
    throw new Error(`Unsupported host platform: ${host}`)
  }
  return narrow
}
