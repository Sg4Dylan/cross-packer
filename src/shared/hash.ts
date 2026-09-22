/**
 * File hashing helpers shared by update metadata, toolchain verification,
 * and archive hashing. Zero project dependencies.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Hash a file's contents with the given algorithm and digest encoding. */
export function hashFile(
  filePath: string,
  algorithm: 'sha256' | 'sha512' = 'sha512',
  encoding: 'hex' | 'base64' = 'hex',
): string {
  return createHash(algorithm).update(readFileSync(filePath)).digest(encoding)
}
