import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createArArchive } from '../src/archive/ar.ts'
import type { NormalizedConfig } from '../src/config/index.ts'
import { renderTemplate } from '../src/packer/common/template.ts'
import { resolveMacBundleIdentity } from '../src/packer/mac/mac.ts'
import {
  buildWindowsInstallerFilename,
  resolveWindowsPackageIdentity,
} from '../src/packer/win/win.ts'
import { getBuildVersion } from '../src/update/version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Partial config stub used by identity helpers (only the fields they read). */
function configStub(stub: Record<string, unknown>): NormalizedConfig {
  return stub as unknown as NormalizedConfig
}

test('createArArchive produces valid deb ar format', () => {
  const buf = createArArchive([
    { name: 'debian-binary', content: Buffer.from('2.0\n'), mode: 0o100644 },
    { name: 'odd-size', content: Buffer.from('abc'), mode: 0o100644 },
  ])
  assert.ok(buf.subarray(0, 8).equals(Buffer.from('!<arch>\n')))
  // header: name padded to 16
  const nameField = buf.subarray(8, 24).toString('ascii').trim()
  assert.equal(nameField, 'debian-binary')
  // odd-size member gets a padding newline
  assert.equal(buf.length, 8 + 60 + 4 + 60 + 3 + 1)
})

test('getBuildVersion converts semver with prerelease', () => {
  assert.equal(getBuildVersion('1.2.3'), '1.2.3.0')
  assert.equal(getBuildVersion('1.2.3-beta.4'), '1.2.3.4')
  assert.equal(getBuildVersion('1.2.3-rc.2'), '1.2.3.2')
})

test('renderTemplate replaces placeholders and normalizes line endings', () => {
  const out = renderTemplate('Name={{name}}\r\nDir={{installDir}}', {
    name: 'app',
    installDir: 'opt/app',
  })
  assert.equal(out, 'Name=app\nDir=opt/app')
  assert.ok(!out.includes('\r'))
})

test('resolveMacBundleIdentity derives stable bundle names', () => {
  const id = resolveMacBundleIdentity(
    configStub({
      productName: 'My App',
      mac: { bundleName: 'MyApp' },
    }),
  )
  assert.equal(id.appName, 'MyApp.app')
  assert.equal(id.executableName, 'MyApp')
  assert.equal(id.displayName, 'My App')
  assert.equal(id.sanitizedHelperName, 'My App')
})

test('resolveMacBundleIdentity sanitizes helper names', () => {
  const id = resolveMacBundleIdentity(
    configStub({ productName: 'App!@# Name', mac: { bundleName: 'App Name' } }),
  )
  assert.equal(id.sanitizedHelperName, 'App Name')
})

test('resolveWindowsPackageIdentity derives updater cache dir', () => {
  const id = resolveWindowsPackageIdentity(
    configStub({ name: 'my-app', productName: 'My App', win: {} }),
  )
  assert.equal(id.appFilename, 'My App')
  assert.equal(id.shortcutName, 'My App')
  assert.equal(id.updaterCacheDirName, 'my-app-updater')
})

test('resolveWindowsPackageIdentity falls back for non-filesystem-safe names', () => {
  const id = resolveWindowsPackageIdentity(
    configStub({ name: '@scope/pkg', productName: '我的应用', win: {} }),
  )
  assert.equal(id.appFilename, 'scope-pkg')
})

test('buildWindowsInstallerFilename formats exe name', () => {
  assert.equal(
    buildWindowsInstallerFilename(configStub({ productName: 'My App', version: '1.2.3' })),
    'My App_1.2.3.exe',
  )
})

test('desktop template renders fully from config', () => {
  const template = readFileSync(path.join(here, '..', 'templates', 'linux', 'app.desktop'), 'utf8')
  const out = renderTemplate(template, {
    productName: 'My App',
    description: 'desc',
    name: 'my-app',
    installDir: 'my-app',
    mimeType: 'x-scheme-handler/myapp;\n',
  })
  assert.ok(out.includes('Name=My App'))
  assert.ok(out.includes('Exec="/opt/my-app/my-app"'))
  assert.ok(!out.includes('{{'))
})
