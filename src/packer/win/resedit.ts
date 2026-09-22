/**
 * Windows PE resource editing (icon + version info) via resedit.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedConfig } from '../../config/index.ts'
import { getBuildVersion } from '../../update/version.ts'

export async function editExeResources(
  exePath: string,
  { iconPath, config }: { iconPath: string | null; config: NormalizedConfig },
): Promise<void> {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit')

  const buffer = await readFile(exePath)
  const executable = NtExecutable.from(buffer)
  const res = NtExecutableResource.from(executable)

  const viList = Resource.VersionInfo.fromEntries(res.entries)
  const vi = viList.length > 0 ? viList[0] : Resource.VersionInfo.createEmpty()

  const languages = vi.getAllLanguagesForStringValues()
  const lang = languages.length > 0 ? languages[0] : { lang: 0x0409, codepage: 1200 }

  const numericVersion = getBuildVersion(config.version, config.buildNumber)
  const displayVersion = config.version

  const versionStrings: Record<string, string> = {
    FileDescription: config.productName,
    ProductName: config.productName,
    LegalCopyright: config.copyright,
    FileVersion: displayVersion,
    ProductVersion: displayVersion,
  }
  if (config.author) {
    versionStrings.CompanyName = config.author
  }
  const internalName = path.basename(exePath, '.exe')
  versionStrings.InternalName = internalName
  versionStrings.OriginalFilename = ''

  vi.setStringValues(lang, versionStrings)
  vi.setFileVersion(numericVersion)
  vi.setProductVersion(numericVersion)
  vi.outputToResourceEntries(res.entries)

  if (iconPath) {
    const iconBuf = await readFile(iconPath)
    const iconFile = Data.IconFile.from(iconBuf)
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      lang.lang,
      iconFile.icons.map((i) => i.data),
    )
  }

  res.outputResource(executable)
  await writeFile(exePath, Buffer.from(executable.generate()))
}
