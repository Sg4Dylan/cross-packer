# cross-packer

[**English**](README.md) | [**简体中文**](README.zh-CN.md)

跨平台 Electron 应用打包器：在任意宿主操作系统上产出 **Windows（NSIS）**、**macOS（.app/.zip）** 与 **Linux（.deb）** 产物，不依赖 `electron-builder`、`app-builder-bin` 或任何平台专属工具链。

## 工作原理

`cross-packer` 是一个 Node.js 命令行工具与程序库，可将构建完成的 Electron 应用载荷转换为可分发产物：

```
cross-packer.config.mjs
   │  加载并归一化配置
   ▼
项目文件收集
   │  应用构建产物、package.json 与裁剪后的生产依赖 node_modules，
   │  智能 unpack 检测、预构建原生模块替换
   ▼
Asar 归档
   │  按目标平台打包，附带完整性哈希与可选的 unpacked 目录
   ▼
平台打包器（并发执行）
   ├─ Windows: NSIS 安装包 / 便携版 exe（自动获取 NSIS 工具链，rcedit 风格的图标与元数据）
   ├─ macOS:   重命名后的 .app bundle（zip 格式）、生成的 Info.plist、asar 完整性、electron-updater 元数据
   └─ Linux:   基于模板（control、desktop 入口、维护者脚本）组装的 .deb 包
   ▼
更新产物（可选）
      latest.yml + *.blockmap，兼容 electron-updater
```

关键设计点：

- **宿主操作系统无关**：Windows、macOS、Linux 产物均可在任意宿主操作系统上构建；各目标的 Electron 发行版按需下载，下载镜像可配置。
- **不依赖 electron-builder**：NSIS 工具链自动获取，.deb 组装由模板驱动，Info.plist 生成基于结构化 `plist` 数据而非字符串模板。
- **可插拔签名**：签名通过钩子（`sign.win` / `sign.mac`）选配启用，打包器自身不执行签名。`examples/signing-hooks.ts` 提供了 [osslsigncode](https://github.com/mtrojnar/osslsigncode) 与定制版 `rcodesign` 分支的参考实现。
- **跨平台 macOS 工具链**：macOS 产物可在任意宿主操作系统上完成签名与镜像封装：跨平台签名使用定制版 [rcodesign](https://github.com/Sg4Dylan/zip2dmg)，`.dmg` 镜像由 [zip2dmg](https://github.com/Sg4Dylan/zip2dmg) 生成。
- **预构建原生模块**：交付预构建原生模块（如 `better-sqlite3`、`@napi-rs/canvas-*`）的项目可按平台与架构声明替换规则，无需从源码重新编译。

## 基本用法

在项目根目录创建配置文件（参见 `examples/basic.config.ts`）：

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
    appDistDir: 'dist', // 应用构建产物目录，与 package.json 共同收集
  },
  asarUnpack: ['**/*.node'],

  mac: {
    bundleName: 'MyApp',
    iconFile: 'build/icon.icns',
    // 额外的 Info.plist 条目，合并到生成的键之上
    // plist: { NSCameraUsageDescription: '需要访问摄像头' },
    // urlSchemes: ['my-app'],
  },
  win: { iconFile: 'build/icon.ico' },
  linux: { maintainer: 'Example Team <dev@example.com>' },

  update: { channel: 'latest', generateMetadata: true },
}
```

构建产物：

```bash
# Windows NSIS 安装包（amd64）
npx cross-packer --win

# macOS .app zip（arm64）
npx cross-packer --mac --arm64

# 全平台、双架构
npx cross-packer --all-platforms --all-arch

# 仅校验配置与目标，不执行构建
npx cross-packer --linux --dry-run
```

主要选项：

| 选项 | 说明 |
| :--- | :--- |
| `--win` / `--mac` / `--linux` | 目标平台 |
| `--all-platforms` | 等价于 `--win --mac --linux` |
| `--amd64` / `--arm64` / `--all-arch` | 目标架构 |
| `--arch <list>` | 逗号分隔的架构列表，如 `--arch amd64,arm64` |
| `--config <path>` | 配置文件路径（`.mjs` 或 `.json`），默认 `cross-packer.config.mjs` |
| `--output <path>` | 输出目录（默认：`dist-<timestamp>`） |
| `--channel <name>` | 更新通道覆盖（如 `latest`、`beta`） |
| `--sign` | 启用代码签名钩子（见 `config.sign`） |
| `--dry-run` | 仅校验配置与目标，不执行构建 |

本打包器亦可作为程序库使用：`runPack`、`loadConfig`、`generateUpdateMetadata`、`buildBlockMap` 均自包根导出（见 `src/index.ts`）。

编程式 API 用法：

```ts
import { loadConfig, runPack } from 'cross-packer'

const config = await loadConfig('cross-packer.config.mjs')
const result = await runPack(config, {
  platforms: ['win', 'mac', 'linux'],
  arches: ['amd64'],
  output: 'dist-release',
})
```

## 依赖说明

运行时依赖（随命令行工具一并提供）：

| 组件 | 许可证 | 用途 |
| :--- | :--- | :--- |
| [archiver](https://github.com/archiverjs/node-archiver) | MIT | 流式 ZIP 组装（macOS .app zip） |
| [jszip](https://github.com/Stuk/jszip) | MIT / Apache-2.0 | 读取 Electron 发行版 zip |
| [tar](https://github.com/isaacs/node-tar) | ISC | Electron 发行版归档处理 |
| [7zip-bin](https://github.com/develar/7zip-bin) | MIT | 内嵌 7za 二进制，用于归档解压 |
| [plist](https://github.com/TooTallNate/plist.js) | MIT | 结构化 Info.plist 的生成与改写 |
| [resedit](https://github.com/lemon-s/resedit) | MIT | Windows PE 资源编辑（图标、版本信息） |
| [js-yaml](https://github.com/nodeca/js-yaml) | MIT | NSIS 消息与 app-update.yml 渲染 |
| [minimatch](https://github.com/isaacs/minimatch) | ISC | 文件集与过滤器的 glob 匹配 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | MIT | asar 完整性与 blockmap 的 SHA-256 校验和 |
| [fs-extra](https://github.com/jprichardson/node-fs-extra) | MIT | 文件系统辅助工具 |
| [chromium-pickle-js](https://github.com/electron/node-chromium-pickle-js) | MIT | Asar 头部（pickle）序列化 |

Windows 打包器自动获取 NSIS 工具链（首次使用时下载并缓存于本地），构建主机无需手动安装 NSIS。macOS 产物默认不签名，签名通过 `sign.mac` 钩子选配启用：可使用定制版 [rcodesign](https://github.com/Sg4Dylan/zip2dmg) 在任意宿主操作系统上完成签名，或在 macOS 上使用 `codesign`（参考实现见 `examples/signing-hooks.ts`）。如需在任意宿主操作系统上将生成的 `.app` zip 转换为 `.dmg` 镜像，请使用 [zip2dmg](https://github.com/Sg4Dylan/zip2dmg)。

## 许可证

### 项目许可证
本项目基于 **AGPLv3 许可证**授权，详见 [LICENSE](LICENSE) 文件。

### AI 披露与免责声明
本项目的部分代码由 AI 编程工具生成或优化。维护者尽力保证质量，但 AI 生成的代码按**「原样」提供，不附带任何明示或默示的保证**。作者不保证 AI 贡献逻辑的绝对准确性、安全性或可靠性，建议用户自行审阅源代码。对于因使用 AI 生成内容而产生的任何索赔、损害或其他责任，作者概不负责。

### 第三方软件声明
本项目集成或使用了以下开源组件，谨向原作者致谢。完整清单及许可证见上方**「依赖说明」**表格。

---

Copyright (c) 2026-Present 项目贡献者。  
基于 AGPLv3 许可证授权。
