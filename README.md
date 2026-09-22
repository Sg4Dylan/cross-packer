# cross-packer

[**English**](README.md) | [**简体中文**](README.zh-CN.md)

Cross-platform Electron app packager: assemble **Windows (NSIS)**, **macOS (.app/.zip)**, and **Linux (.deb)** artifacts on any host operating system, with no dependency on `electron-builder`, `app-builder-bin`, or platform-specific toolchains.

## How It Works

`cross-packer` is a Node.js command-line tool and library that turns a built Electron app payload into distributable artifacts:

```
cross-packer.config.mjs
   │  load & normalize config
   ▼
Project file collection
   │  app dist + package.json + pruned production node_modules,
   │  smart-unpack detection, prebuilt native module substitution
   ▼
Asar archive
   │  packed per-target with integrity hashes and optional unpacked dir
   ▼
Platform packers (run concurrently)
   ├─ Windows: NSIS installer / portable exe (auto-acquired NSIS toolchain, rcedit-style icon & metadata)
   ├─ macOS:   renamed .app bundle in a zip, generated Info.plist, asar integrity, electron-updater metadata
   └─ Linux:   .deb package from templates (control, desktop entry, maintainer scripts)
   ▼
Update artifacts (optional)
      latest.yml + *.blockmap, electron-updater compatible
```

Key design points:

- **Host-OS independent**: Windows, macOS, and Linux artifacts can all be built from any host operating system; the Electron distribution for each target is downloaded on demand, and the download mirror is configurable.
- **No electron-builder**: the NSIS toolchain is acquired automatically, .deb assembly is template-driven, and Info.plist generation uses structured `plist` data instead of string templating.
- **Pluggable signing**: signing is opt-in via hooks (`sign.win` / `sign.mac`); the packer itself never signs artifacts. Reference implementations for [osslsigncode](https://github.com/mtrojnar/osslsigncode) and a customized `rcodesign` fork are provided in `examples/signing-hooks.ts`.
- **Cross-platform macOS tooling**: macOS artifacts can be signed and packaged on any host operating system; cross-platform signing uses the customized [rcodesign](https://github.com/Sg4Dylan/zip2dmg) fork, and `.dmg` images are generated with [zip2dmg](https://github.com/Sg4Dylan/zip2dmg).
- **Prebuilt native modules**: projects shipping prebuilt native modules (such as `better-sqlite3` and `@napi-rs/canvas-*`) can declare substitution rules per platform and architecture without rebuilding from source.

## Basic Usage

Create a config file at your project root (see `examples/basic.config.ts`):

```js
// cross-packer.config.mjs
export default {
  name: 'my-app',
  productName: 'My App',
  appId: 'com.example.my-app',
  version: '1.0.0',
  author: 'Example Team',
  electronVersion: '33.2.0',

  files: {
    appDistDir: 'dist', // built app payload, collected together with package.json
  },
  asarUnpack: ['**/*.node'],

  mac: {
    bundleName: 'MyApp',
    iconFile: 'build/icon.icns',
    // Extra Info.plist entries merged on top of the generated keys
    // plist: { NSCameraUsageDescription: 'Camera access is required' },
    // urlSchemes: ['my-app'],
  },
  win: { iconFile: 'build/icon.ico' },
  linux: { maintainer: 'Example Team <dev@example.com>' },

  update: { channel: 'latest', generateMetadata: true },
}
```

Build artifacts:

```bash
# Windows NSIS installer (amd64)
npx cross-packer --win

# macOS .app zip (arm64)
npx cross-packer --mac --arm64

# All platforms, both architectures
npx cross-packer --all-platforms --all-arch

# Validate config and targets without building
npx cross-packer --linux --dry-run
```

Main options:

| Option | Description |
| :--- | :--- |
| `--win` / `--mac` / `--linux` | Target platform(s) |
| `--all-platforms` | Equivalent to `--win --mac --linux` |
| `--amd64` / `--arm64` / `--all-arch` | Target architecture(s) |
| `--arch <list>` | Comma-separated architecture list, for example `--arch amd64,arm64` |
| `--config <path>` | Config file path (`.mjs` or `.json`), default `cross-packer.config.mjs` |
| `--output <path>` | Output directory (default: `dist-<timestamp>`) |
| `--channel <name>` | Update channel override (for example, `latest` or `beta`) |
| `--sign` | Enable code signing hooks (see `config.sign`) |
| `--dry-run` | Validate config and targets without building |

The packer is also usable as a library: `runPack`, `loadConfig`, `generateUpdateMetadata`, and `buildBlockMap` are exported from the package root (see `src/index.ts`).

Programmatic API usage:

```ts
import { loadConfig, runPack } from 'cross-packer'

const config = await loadConfig('cross-packer.config.mjs')
const result = await runPack(config, {
  platforms: ['win', 'mac', 'linux'],
  arches: ['amd64'],
  output: 'dist-release',
})
```

## Dependencies

Runtime dependencies (bundled with the command-line tool):

| Component | License | Usage |
| :--- | :--- | :--- |
| [archiver](https://github.com/archiverjs/node-archiver) | MIT | Streaming ZIP assembly (macOS .app zip) |
| [jszip](https://github.com/Stuk/jszip) | MIT / Apache-2.0 | Reading Electron distribution zips |
| [tar](https://github.com/isaacs/node-tar) | ISC | Electron dist archive handling |
| [7zip-bin](https://github.com/develar/7zip-bin) | MIT | Embedded 7za binary for archive extraction |
| [plist](https://github.com/TooTallNate/plist.js) | MIT | Structured Info.plist generation and rewriting |
| [resedit](https://github.com/lemon-s/resedit) | MIT | Windows PE resource editing (icon, version info) |
| [js-yaml](https://github.com/nodeca/js-yaml) | MIT | NSIS messages and app-update.yml rendering |
| [minimatch](https://github.com/isaacs/minimatch) | ISC | Glob matching for file sets and filters |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | MIT | SHA-256 checksums for asar integrity and blockmaps |
| [fs-extra](https://github.com/jprichardson/node-fs-extra) | MIT | File system helpers |
| [chromium-pickle-js](https://github.com/electron/node-chromium-pickle-js) | MIT | Asar header (pickle) serialization |

The Windows packer acquires the NSIS toolchain automatically (downloaded on first use and cached locally), so no manual NSIS installation is required on the build host. macOS artifacts are produced unsigned by design; signing is opt-in via the `sign.mac` hook, using either the customized [rcodesign](https://github.com/Sg4Dylan/zip2dmg) fork on any host operating system or `codesign` on macOS (reference implementations are provided in `examples/signing-hooks.ts`). To produce a `.dmg` image from the generated `.app` zip on any host operating system, use [zip2dmg](https://github.com/Sg4Dylan/zip2dmg).

## License

### Project License
This project is licensed under the **AGPLv3 License**; see the [LICENSE](LICENSE) file for details.

### AI Disclosure & Disclaimer
Parts of this project are generated or optimized by AI coding tools. While the maintainers strive for quality, the AI-generated code is provided **"AS IS" without warranty of any kind**, express or implied. The authors do not guarantee the absolute accuracy, security, or reliability of the AI-contributed logic. Users are encouraged to review the source code independently. In no event shall the authors be liable for any claim, damages, or other liability arising from the use of AI-generated content.

### Third-Party Software Notices
This project integrates or makes use of the following open-source components, with gratitude to the original authors; see the table above under **Dependencies** for the full list with licenses.

---

Copyright (c) 2026-Present project contributors.  
Licensed under the AGPLv3 License.
