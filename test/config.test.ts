import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveConfigPath } from '../src/config/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

test('resolveConfigPath picks up an explicit config file', () => {
  const resolved = resolveConfigPath(path.join(here, '..', 'examples', 'basic.config.ts'))
  assert.ok(resolved.endsWith('basic.config.ts'))
})

test('resolveConfigPath rejects a missing explicit config', () => {
  assert.throws(() => resolveConfigPath('does-not-exist.config.mjs'), /Config file not found/)
})

test('loadConfig normalizes the example config', async () => {
  const config = await loadConfig(path.join(here, '..', 'examples', 'basic.config.ts'))
  assert.equal(config.name, 'my-app')
  assert.equal(config.productName, 'My App')
  assert.equal(config.appId, 'com.example.my-app')
  assert.equal(config.electronVersion, '33.2.0')
  assert.equal(config.update.channel, 'latest')
  assert.equal(config.sign.enabled, false)
  assert.equal(config.sign.win?.enabled, true)
  assert.equal(config.sign.mac?.enabled, true)
  assert.ok(Array.isArray(config.linux.debDepends) && config.linux.debDepends.length > 0)
})

test('loadConfig rejects configs missing required fields', async () => {
  const broken = path.join(here, 'fixtures', 'broken.config.ts')
  await assert.rejects(loadConfig(broken), /missing required string field/)
})

test('loadConfig applies cli channel override', async () => {
  const config = await loadConfig(path.join(here, '..', 'examples', 'basic.config.ts'), {
    channel: 'beta',
  })
  assert.equal(config.update.channel, 'beta')
})
