#!/usr/bin/env node
// src/cli.ts

const command = process.argv[2]

if (command === 'demo') {
  const { startDemo } = await import('./demo.js')
  await startDemo()
} else {
  console.log('Usage: toll-booth <command>')
  console.log('')
  console.log('Commands:')
  console.log('  demo    Start a self-contained demo server with mock Lightning')
  console.log('')
  console.log('Example:')
  console.log('  npx @forgesworn/toll-booth demo')
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 1)
}
