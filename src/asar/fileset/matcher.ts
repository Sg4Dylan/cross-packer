import path from 'node:path'
import type { Minimatch } from 'minimatch'
import { EntryKind, type FileFilter, type FileStat } from '../../shared/types.ts'

export const excludedNames =
  '.git,.hg,.svn,CVS,RCS,SCCS,' +
  '__pycache__,.DS_Store,thumbs.db,.gitignore,.gitkeep,.gitattributes,.npmignore,' +
  '.idea,.vs,.flowconfig,.jshintrc,.eslintrc,.circleci,' +
  '.yarn-integrity,.yarn-metadata.json,yarn-error.log,yarn.lock,package-lock.json,npm-debug.log,pnpm-lock.yaml,bun.lock,bun.lockb,' +
  'appveyor.yml,.travis.yml,circle.yml,.nyc_output,.husky,.github,electron-builder.env'

export const excludedExts =
  'iml,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,suo,xproj,cc,d.ts,' + 'mk,a,o,obj,forge-meta'

export const excludedFiles = new Set(
  [
    '.DS_Store',
    'node_modules',
    'CHANGELOG.md',
    'ChangeLog',
    'changelog.md',
    'Changelog.md',
    'Changelog',
    'binding.gyp',
    '.npmignore',
    'node_gyp_bins',
  ].concat(excludedNames.split(',')),
)

export const topLevelExcludedFiles = new Set([
  'karma.conf.js',
  '.coveralls.yml',
  'README.md',
  'readme.markdown',
  'README',
  'readme.md',
  'Readme.md',
  'Readme',
  'readme',
  'test',
  'tests',
  '__tests__',
  'powered-test',
  'example',
  'examples',
  '.bin',
])

export function hasMagic(pattern: Minimatch): boolean {
  const set = pattern.set
  if (set.length > 1) return true
  for (const i of set[0]) {
    if (typeof i !== 'string') return true
  }
  return false
}

/** Ensure a path string ends with the platform separator. */
export function ensureEndSlash(s: string): string {
  return s.length === 0 || s.endsWith(path.sep) ? s : s + path.sep
}

export function getRelativePath(file: string, srcWithEndSlash: string, stat: FileStat): string {
  let relative = stat.moduleFullFilePath || file.substring(srcWithEndSlash.length)
  if (path.sep === '\\') {
    if (relative.startsWith('\\')) {
      relative = relative.substring(1)
    }
    relative = relative.replace(/\\/g, '/')
  }
  return relative
}

export function minimatchAll(p: string, patterns: Minimatch[], stat: FileStat): boolean {
  let match = false
  for (const pattern of patterns) {
    if (match !== pattern.negate) continue
    match = pattern.match(p, stat.type === EntryKind.DIRECTORY && !pattern.negate)
  }
  return match
}

export function createFilter(
  src: string,
  patterns: Minimatch[],
  excludePatterns?: Minimatch[] | null,
): FileFilter {
  const srcWithEndSlash = ensureEndSlash(src)
  return (file, stat) => {
    if (src === file) return true
    let relative = getRelativePath(file, srcWithEndSlash, stat)
    if (relative === 'node_modules') return false
    if (relative.endsWith('/node_modules')) relative += '/'
    return (
      minimatchAll(relative, patterns, stat) &&
      (excludePatterns == null ||
        stat.type === EntryKind.DIRECTORY ||
        !minimatchAll(relative, excludePatterns, stat))
    )
  }
}
