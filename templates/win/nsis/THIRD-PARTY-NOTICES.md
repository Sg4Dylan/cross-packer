# Third-party notices — NSIS templates

The `.nsh` / `.nsi` templates and message YAML files in this directory
originate from [electron-builder](https://github.com/electron-userland/electron-builder)
(`packages/app-builder-lib/templates/nsis`), Copyright (c) electron-builder
contributors, licensed under the [MIT License](https://github.com/electron-userland/electron-builder/blob/master/LICENSE).

- Upstream project: https://github.com/electron-userland/electron-builder
- NSIS binaries downloaded at build time come from
  [electron-userland/electron-builder-binaries](https://github.com/electron-userland/electron-builder-binaries)
  (customized NSIS build + NsisMultiUser plugin, MIT licensed).
- The `NsisMultiUser` plugin itself is by Drizin — see
  https://github.com/Drizin/NsisMultiUser
- NSIS (Nullsoft Scriptable Install System) is upstream at
  https://sourceforge.net/p/nsis/code/HEAD/tree/

Modifications by cross-packer contributors are released under the MIT license
(see the repository root LICENSE). Version pinning of the downloaded toolchain
is configurable via `config.win.nsisVersion` / `config.win.nsisResourcesVersion`
in `cross-packer.config.mjs`.
