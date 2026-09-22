import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import fsExtra from 'fs-extra'

const require = createRequire(import.meta.url)
const chromiumPickle = require('chromium-pickle-js')

interface PickleIterator {
  readUInt32(): number
  readString(): string
}

interface Pickle {
  createIterator(): PickleIterator
}

export async function readAsarHeader(archive: string): Promise<{ header: string; size: number }> {
  const fd = await fsExtra.open(archive, 'r')
  let size: number
  let headerBuf: Buffer

  try {
    const sizeBuf = Buffer.allocUnsafe(8)
    const { bytesRead: sizeBytesRead } = await fsExtra.read(fd, sizeBuf, 0, 8, null)
    if (sizeBytesRead !== 8) {
      throw new Error('Unable to read header size')
    }

    const sizePickle: Pickle = chromiumPickle.createFromBuffer(sizeBuf)
    size = sizePickle.createIterator().readUInt32()

    headerBuf = Buffer.allocUnsafe(size)
    const { bytesRead: headerBytesRead } = await fsExtra.read(fd, headerBuf, 0, size, null)
    if (headerBytesRead !== size) {
      throw new Error('Unable to read header')
    }
  } finally {
    await fsExtra.close(fd)
  }

  const headerPickle: Pickle = chromiumPickle.createFromBuffer(headerBuf)
  return { header: headerPickle.createIterator().readString(), size }
}

export async function hashHeader(file: string): Promise<{ algorithm: string; hash: string }> {
  const hash = crypto.createHash('sha256')
  const { header } = await readAsarHeader(file)
  hash.update(header)
  return {
    algorithm: 'SHA256',
    hash: hash.digest('hex'),
  }
}
