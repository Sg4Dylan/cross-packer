/**
 * Convert a semver string into the four-part numeric build version.
 * NSIS VIProductVersion and PE version resources require the X.X.X.X format.
 * The fourth segment prefers: explicit buildNumber param > prerelease number
 * in the version string > CI build number (only when CI=true).
 */
export function getBuildVersion(version: string, buildNumber?: number | string): string {
  const ciBuildNumber = getCiBuildNumber()
  const semverMatch = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|rc)\.(\d+))?/i)

  if (semverMatch) {
    const major = Number.parseInt(semverMatch[1], 10)
    const minor = Number.parseInt(semverMatch[2], 10)
    const patch = Number.parseInt(semverMatch[3], 10)

    if (buildNumber != null && /^\d+$/.test(String(buildNumber))) {
      return `${major}.${minor}.${patch}.${Number.parseInt(String(buildNumber), 10)}`
    }

    if (ciBuildNumber && /^\d+$/.test(ciBuildNumber)) {
      return `${major}.${minor}.${patch}.${Number.parseInt(ciBuildNumber, 10)}`
    }

    const prereleaseBuild = semverMatch[4] ? Number.parseInt(semverMatch[4], 10) : 0
    return `${major}.${minor}.${patch}.${prereleaseBuild}`
  }

  const parts = version.replace(/-/g, '.').split('.')
  const major = Number.parseInt(parts[0], 10) || 0
  const minor = Number.parseInt(parts[1], 10) || 0
  const patch = Number.parseInt(parts[2], 10) || 0
  const fallbackBuild =
    buildNumber != null && /^\d+$/.test(String(buildNumber))
      ? Number.parseInt(String(buildNumber), 10)
      : Number.parseInt(parts[3], 10) || 0
  const build =
    ciBuildNumber && /^\d+$/.test(ciBuildNumber)
      ? Number.parseInt(ciBuildNumber, 10)
      : fallbackBuild

  return `${major}.${minor}.${patch}.${build}`
}

/**
 * Read the CI build number from well-known environment variables.
 * Only consulted inside a CI runner (CI=true) so that a stray BUILD_NUMBER
 * on a developer machine cannot silently alter artifact versions.
 */
function getCiBuildNumber(): string | undefined {
  if (process.env.CI !== 'true') return undefined
  return (
    process.env.CI_PIPELINE_IID ||
    process.env.BUILD_BUILDNUMBER ||
    process.env.CIRCLE_BUILD_NUM ||
    process.env.APPVEYOR_BUILD_NUMBER ||
    process.env.TRAVIS_BUILD_NUMBER ||
    process.env.BUILD_NUMBER
  )
}
