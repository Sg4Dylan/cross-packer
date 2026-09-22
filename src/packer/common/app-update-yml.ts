/**
 * Shared app-update.yml rendering, used by the win and mac packers.
 */
import { readFile } from 'node:fs/promises'
import type { NormalizedConfig } from '../../config/index.ts'
import { getTemplatesDir, renderTemplate } from './template.ts'

/** Derive the electron-updater cache directory name for a config. */
export function getUpdaterCacheDirName(config: NormalizedConfig): string {
  return `${config.name.toLowerCase()}-updater`
}

/** Render the shared app-update.yml template. */
export async function renderAppUpdateYml(config: NormalizedConfig): Promise<string> {
  const template = await readFile(getTemplatesDir('mac', 'app-update.yml'), 'utf8')
  return renderTemplate(template, {
    updateServerUrl: config.update.url,
    updaterCacheDirName: getUpdaterCacheDirName(config),
    channel: config.update.channel,
  })
}
