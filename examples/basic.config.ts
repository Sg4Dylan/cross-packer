/**
 * Example cross-packer config.
 * Copy to your Electron project root as cross-packer.config.ts and adjust.
 */
export default {
  name: 'my-app',
  productName: 'My App',
  appId: 'com.example.my-app',
  version: '1.0.0',
  description: 'My awesome Electron app',
  author: 'Example Team',
  homepage: 'https://example.com',

  electronVersion: '33.2.0',
  // Optional: regional mirror (e.g. 'https://npmmirror.com/mirrors/electron/')
  // electronMirror: 'https://npmmirror.com/mirrors/electron/',

  // App payload (paths relative to projectDir)
  projectDir: '.',
  files: {
    // Directory containing the built app payload (collected together with package.json)
    appDistDir: 'dist',
  },

  // Optional: replace node_modules native modules with prebuilt copies.
  // nativeModules: {
  //   prebuiltRules: (platform, arch) => [
  //     {
  //       moduleName: 'better-sqlite3',
  //       from: `vendor/better-sqlite3-v12-electron-v146-${platform}-${arch}`,
  //     },
  //     {
  //       // moduleName ending with '-*' matches a family of platform variants
  //       moduleName: '@napi-rs/canvas-*',
  //       from: `vendor/canvas-v0.1-${platform}-${arch}`,
  //       renameTo: `canvas-${platform}-${arch}`,
  //     },
  //   ],
  // },
  asarUnpack: ['**/*.node'],
  extraResources: [
    // { from: 'assets', to: 'assets' },
  ],

  mac: {
    bundleName: 'MyApp',
    category: 'public.app-category.productivity',
    iconFile: 'build/icon.icns',
    minimumSystemVersion: '10.13',
    // URL schemes registered as CFBundleURLTypes entries in Info.plist
    // urlSchemes: ['my-app'],
    // Extra Info.plist entries merged on top of the generated keys
    // plist: {
    //   NSCameraUsageDescription: 'Camera access is required',
    //   NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    // },
  },

  win: {
    iconFile: 'build/icon.ico',
    compressionLevel: 5,
    shortcutName: 'My App',
  },

  linux: {
    installDir: 'my-app',
    maintainer: 'Example Team <dev@example.com>',
  },

  update: {
    channel: 'latest',
    generateMetadata: true,
  },

  // Signing is opt-in and pluggable (see examples/signing-hooks.ts for
  // reference implementations and the full hook contract):
  //   win.hook: (target, ctx) => Promise<void>   — target: app dir or single .exe (ctx.singleFile)
  //   mac.hook: (target, ctx) => Promise<string> — signs the unsigned .zip, returns the signed path
  // Per-platform `enabled: false` opts a single platform out while the global flag stays on.
  sign: {
    enabled: false,
    // win: { enabled: true, hook: async (target, ctx) => { /* signtool wrapper */ } },
    // mac: { hook: async (target, ctx) => { /* codesign/rcodesign */ } },
  },
}
