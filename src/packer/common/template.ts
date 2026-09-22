/**
 * Generic {{placeholder}} template rendering with CRLF normalization.
 */
import path from 'node:path'

export function getTemplatesDir(...segments: string[]): string {
  return path.join(import.meta.dirname, '..', '..', '..', 'templates', ...segments)
}

export function renderTemplate(
  template: string,
  replacements: Record<string, string | number>,
): string {
  let rendered = template
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value))
  }
  return normalizeUnixLineEndings(rendered)
}

/** Normalize CRLF and CR line endings to LF. */
function normalizeUnixLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
