import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonObject } from '../../shared/types.ts'

const NODE_MODULES_PATTERN = `${path.sep}node_modules${path.sep}`

const ignoredPackageMetadataProperties = new Set([
  'dist',
  'gitHead',
  'build',
  'jspm',
  'ava',
  'xo',
  'nyc',
  'eslintConfig',
  'contributors',
  'bundleDependencies',
  'tags',
])

const PROTECTED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function createTransformer(
  srcDir: string,
  extraMetadata: JsonObject | undefined,
  extraTransformer?: (file: string) => Promise<string | null> | string | null,
): (file: string) => Promise<string | null> | string | null {
  const mainPackageJson = path.join(srcDir, 'package.json')
  const isRemovePackageScripts = true
  const isRemovePackageKeywords = true
  const packageJson = `${path.sep}package.json`

  // Transform the contents of a single file on read; return the modified
  // content for touched files and the raw content for untouched files.
  return (file) => {
    if (file === mainPackageJson) {
      return modifyMainPackageJson(
        file,
        extraMetadata,
        isRemovePackageScripts,
        isRemovePackageKeywords,
      )
    }
    if (file.endsWith(packageJson) && file.includes(NODE_MODULES_PATTERN)) {
      return readFile(file, 'utf-8')
        .then((it) =>
          cleanupPackageJson(JSON.parse(it) as JsonObject, {
            isMain: false,
            isRemovePackageScripts,
            isRemovePackageKeywords,
          }),
        )
        .catch((e: unknown) => {
          console.warn(e)
          return null
        })
    }
    if (extraTransformer != null) {
      return extraTransformer(file)
    }
    return null
  }
}

function cleanupPackageJson(
  data: JsonObject,
  options: { isMain: boolean; isRemovePackageScripts: boolean; isRemovePackageKeywords: boolean },
): string | null {
  const deps = data.dependencies
  const isRemoveBabel =
    deps != null &&
    typeof deps === 'object' &&
    !Object.getOwnPropertyNames(deps).some((it) => it.startsWith('babel'))
  let changed = false
  for (const prop of Object.getOwnPropertyNames(data)) {
    if (
      prop[0] === '_' ||
      ignoredPackageMetadataProperties.has(prop) ||
      (options.isRemovePackageScripts && prop === 'scripts') ||
      (options.isRemovePackageKeywords && prop === 'keywords') ||
      (options.isMain && prop === 'devDependencies') ||
      (!options.isMain && prop === 'bugs') ||
      (isRemoveBabel && prop === 'babel')
    ) {
      delete data[prop]
      changed = true
    }
  }
  if (changed) {
    return JSON.stringify(data, null, 2)
  }
  return null
}

async function modifyMainPackageJson(
  file: string,
  extraMetadata: JsonObject | undefined,
  isRemovePackageScripts: boolean,
  isRemovePackageKeywords: boolean,
): Promise<string | null> {
  const mainPackageData = JSON.parse(await readFile(file, 'utf-8')) as JsonObject
  if (extraMetadata != null) {
    deepAssign(mainPackageData, extraMetadata)
  }
  const serializedDataIfChanged = cleanupPackageJson(mainPackageData, {
    isMain: true,
    isRemovePackageScripts,
    isRemovePackageKeywords,
  })
  if (serializedDataIfChanged != null) {
    return serializedDataIfChanged
  }
  return null
}

/** Check that a key is safe for assignment that avoids prototype pollution. */
function isValidKey(key: string): boolean {
  return !PROTECTED_KEYS.has(key)
}

/** Check whether a value is a non-array object (or a function). */
function isObject(x: unknown): boolean {
  if (Array.isArray(x)) return false
  const type = typeof x
  return type === 'object' || type === 'function'
}

function assignKey(target: JsonObject, from: JsonObject, key: string): void {
  const value = from[key]
  if (value === undefined) return
  const prevValue = target[key]
  if (prevValue == null || value == null || !isObject(prevValue) || !isObject(value)) {
    if (Array.isArray(prevValue) && Array.isArray(value)) {
      target[key] = Array.from(new Set(prevValue.concat(value)))
    } else {
      target[key] = value
    }
  } else {
    deepAssign(prevValue as JsonObject, value as JsonObject)
  }
}

function deepAssign(target: JsonObject, ...objects: (JsonObject | undefined)[]): JsonObject {
  for (const o of objects) {
    if (o != null) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (isValidKey(key)) {
          assignKey(target, o, key)
        }
      }
    }
  }
  return target
}
