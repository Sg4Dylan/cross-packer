import { Buffer } from 'node:buffer'

export interface ArEntry {
  name: string
  content: Buffer
  mode?: number
  mtime?: number
}

/**
 * Minimal `ar` archive writer, sufficient for .deb assembly
 * (debian-binary + control.tar.xz + data.tar.xz).
 */
export function createArArchive(files: ArEntry[]): Buffer {
  const parts = [Buffer.from('!<arch>\n')]

  for (const file of files) {
    const mtime = file.mtime ?? Math.floor(Date.now() / 1000)
    const mode = file.mode ?? 0o100644
    const size = file.content.length

    const header = Buffer.alloc(60)
    header.write(file.name.padEnd(16), 0, 16, 'ascii')
    header.write(String(mtime).padEnd(12), 16, 12, 'ascii')
    header.write('0     ', 28, 6, 'ascii')
    header.write('0     ', 34, 6, 'ascii')
    header.write(mode.toString(8).padStart(6, '0').padEnd(8), 40, 8, 'ascii')
    header.write(String(size).padEnd(10), 48, 10, 'ascii')
    header.write('`\n', 58, 2, 'ascii')

    parts.push(header)
    parts.push(Buffer.from(file.content))

    // ar members are 2-byte aligned
    if (size % 2 !== 0) {
      parts.push(Buffer.from('\n'))
    }
  }

  return Buffer.concat(parts)
}
