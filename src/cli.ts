#!/usr/bin/env node
// src/cli.ts

const command = process.argv[2]

if (command === 'demo') {
  const { startDemo } = await import('./demo.js')
  await startDemo()
} else if (command === 'init') {
  const { runInit } = await import('./init.js')
  await runInit()
} else {
  console.log('Usage: toll-booth <command>')
  console.log('')
  console.log('Commands:')
  console.log('  demo    Start a self-contained demo server with mock Lightning')
  console.log('  init    Scaffold a new toll-booth project')
  console.log('')
  console.log('Example:')
  console.log('  npx @forgesworn/toll-booth demo')
  console.log('  npx @forgesworn/toll-booth init')
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 1)
}
