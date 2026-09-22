/**
 * electron-updater compatible metadata generation
 * (latest.yml / latest-mac.yml / latest-linux.yml).
 */
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hashFile } from '../shared/hash.ts'
import { NodePlatform } from '../shared/platform.ts'

export interface UpdateMetadataOptions {
  filePath: string
  version: string
  outputDir: string
  platform: NodePlatform
  blockMapSize?: number
  channel?: string
  extraFiles?: string[]
}

/**
 * Derive the update channel from a semver prerelease suffix
 * (for example, 1.2.3-beta.1 yields "beta").
 */
export function getUpdateChannel(
  version: string,
  explicitChannel?: string,
  defaultChannel = 'latest',
): string {
  if (explicitChannel) return explicitChannel
  const match = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-]+)\.\d+$/)
  return match ? match[1] : defaultChannel
}

export function getUpdateMetadataFileName(
  version: string,
  explicitChannel?: string,
  platform: NodePlatform = NodePlatform.WIN32,
  defaultChannel = 'latest',
): string {
  const channel = getUpdateChannel(version, explicitChannel, defaultChannel)
  if (platform === NodePlatform.DARWIN)
    return `${channel === 'latest' ? 'latest' : channel}-mac.yml`
  if (platform === NodePlatform.LINUX)
    return `${channel === 'latest' ? 'latest' : channel}-linux.yml`
  return `${channel}.yml`
}

/** Get a file's size in bytes, 0 when missing. */
function getFileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0
}

/** Describe one artifact for the files[] array, with an optional inline blockMapSize. */
function fileEntryYaml(url: string, sha512: string, size: number, blockMapSize?: number): string {
  const blockMapEntry = blockMapSize != null ? `\n    blockMapSize: ${blockMapSize}` : ''
  return `  - url: ${url}\n    sha512: ${sha512}\n    size: ${size}${blockMapEntry}`
}

export function generateUpdateMetadata({
  filePath,
  version,
  outputDir,
  platform,
  blockMapSize,
  channel,
  extraFiles = [],
}: UpdateMetadataOptions): { metadataPath: string; metadataFileName: string } | null {
  if (!existsSync(filePath)) return null

  const url = path.basename(filePath)
  const primaryHash = hashFile(filePath, 'sha512', 'base64')
  const primarySize = getFileSize(filePath)
  const filesYaml = [
    fileEntryYaml(url, primaryHash, primarySize, blockMapSize),
    ...extraFiles
      .filter((extra) => existsSync(extra) && extra !== filePath)
      .map((extra) =>
        fileEntryYaml(
          path.basename(extra),
          hashFile(extra, 'sha512', 'base64'),
          getFileSize(extra),
        ),
      ),
  ].join('\n')

  const metadataFileName = getUpdateMetadataFileName(version, channel, platform)
  const content = `version: ${version}
files:
${filesYaml}
path: ${url}
sha512: ${primaryHash}
releaseDate: ${new Date().toISOString()}
`
  const metadataPath = path.join(outputDir, metadataFileName)
  writeFileSync(metadataPath, content, 'utf8')
  return { metadataPath, metadataFileName }
}
