import assert from 'node:assert/strict'
import { test } from 'node:test'
import { electronArchiveName } from '../src/electron/download.ts'
import { Arch, NodePlatform } from '../src/shared/platform.ts'
import { getUpdateChannel, getUpdateMetadataFileName } from '../src/update/metadata.ts'

test('getUpdateChannel returns default for stable versions', () => {
  assert.equal(getUpdateChannel('1.2.3'), 'latest')
})

test('getUpdateChannel derives channel from prerelease suffix', () => {
  assert.equal(getUpdateChannel('1.2.3-beta.1'), 'beta')
})

test('getUpdateChannel explicit channel wins', () => {
  assert.equal(getUpdateChannel('1.2.3-beta.1', 'nightly'), 'nightly')
})

test('getUpdateMetadataFileName per platform', () => {
  assert.equal(getUpdateMetadataFileName('1.0.0', undefined, NodePlatform.WIN32), 'latest.yml')
  assert.equal(getUpdateMetadataFileName('1.0.0', undefined, NodePlatform.DARWIN), 'latest-mac.yml')
  assert.equal(
    getUpdateMetadataFileName('1.0.0', undefined, NodePlatform.LINUX),
    'latest-linux.yml',
  )
  assert.equal(getUpdateMetadataFileName('1.0.0-beta.1', undefined, NodePlatform.WIN32), 'beta.yml')
})

test('electronArchiveName formats official archive names', () => {
  assert.equal(
    electronArchiveName('33.2.0', NodePlatform.WIN32, Arch.AMD64),
    'electron-v33.2.0-win32-x64.zip',
  )
  assert.equal(
    electronArchiveName('33.2.0', NodePlatform.DARWIN, Arch.ARM64),
    'electron-v33.2.0-darwin-arm64.zip',
  )
})
