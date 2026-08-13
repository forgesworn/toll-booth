import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
const localProtocols = /^(?:file|link|workspace|portal|patch|catalog):/i
const localPaths = /^(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/
const invalid = []

for (const section of sections) {
  for (const [name, specification] of Object.entries(manifest[section] ?? {})) {
    if (typeof specification !== 'string' || localProtocols.test(specification) || localPaths.test(specification)) {
      invalid.push(`${section}.${name}=${String(specification)}`)
    }
  }
}

if (invalid.length > 0) {
  console.error(`Refusing to publish local dependency specifications:\n${invalid.join('\n')}`)
  process.exit(1)
}

console.log('Publish dependencies are registry-resolvable')
