// src/templates/generic.ts - fallback template for non-golden-path combinations

import type { TemplateContext } from '../init-prompts.js'
import type { GeneratedProject } from './shared.js'
import {
  generatePackageJson,
  generateEnvExample,
  generateReadme,
  generateGitignore,
  generateTsConfig,
  TOLL_BOOTH_DENO_PACKAGE,
  tollBoothDenoSubpath,
} from './shared.js'

function generateServer(ctx: TemplateContext): string {
  const isCashuOnly = ctx.backend === 'cashu-only'
  const isDeno = ctx.framework === 'deno'
  const isHono = ctx.framework === 'hono'
  const isExpress = ctx.framework === 'express'

  const envGet = isDeno
    ? (key: string, fallback: string) => `Deno.env.get('${key}') ?? '${fallback}'`
    : (key: string, fallback: string) => `process.env.${key} ?? '${fallback}'`

  const upstream = ctx.upstream === 'stub'
    ? "'http://localhost:4000'"
    : envGet('UPSTREAM_URL', 'http://localhost:4000')

  const lines: string[] = []

  // Imports
  if (isExpress) {
    lines.push("import express from 'express'")
  }
  if (isHono) {
    lines.push("import { Hono } from 'hono'")
    lines.push("import { serve } from '@hono/node-server'")
  }
  if (ctx.backend === 'nwc' && !isDeno) {
    lines.push("import { closeSync, fstatSync, openSync, readSync } from 'node:fs'")
  }

  if (isHono) {
    lines.push("import { createHonoTollBooth, type TollBoothEnv } from '@forgesworn/toll-booth/hono'")
    lines.push("import { createTollBooth, memoryStorage } from '@forgesworn/toll-booth'")
  } else {
    lines.push("import { Booth } from '@forgesworn/toll-booth'")
  }

  if (!isCashuOnly && ctx.backendImport) {
    lines.push(ctx.backendImport)
  }
  lines.push('')

  if (ctx.backend === 'nwc') {
    lines.push('function loadNwcUri(): string {')
    if (isDeno) {
      lines.push("  const file = Deno.env.get('NWC_URI_FILE')")
      lines.push("  if (!file) throw new Error('NWC_URI_FILE is required')")
      lines.push("  const handle = Deno.openSync(file, { read: true })")
      lines.push('  try {')
      lines.push('    const info = handle.statSync()')
      lines.push("    if (!info.isFile || info.size === 0 || info.size > 8192) throw new Error('NWC_URI_FILE must be a non-empty regular file no larger than 8192 bytes')")
      lines.push("    if (info.mode !== null && (info.mode & 0o077) !== 0) throw new Error('NWC_URI_FILE permissions are too broad; run chmod 600 on the file')")
      lines.push('    const bytes = new Uint8Array(info.size)')
      lines.push('    let offset = 0')
      lines.push('    while (offset < bytes.length) {')
      lines.push('      const read = handle.readSync(bytes.subarray(offset))')
      lines.push("      if (read === null || read === 0) throw new Error('NWC_URI_FILE changed while it was being read')")
      lines.push('      offset += read')
      lines.push('    }')
      lines.push('    const extra = new Uint8Array(1)')
      lines.push('    try {')
      lines.push("      if (handle.readSync(extra) !== null) throw new Error('NWC_URI_FILE changed while it was being read')")
      lines.push('    } finally {')
      lines.push('      extra.fill(0)')
      lines.push('    }')
      lines.push("    try { return new TextDecoder().decode(bytes).trim() } finally { bytes.fill(0) }")
      lines.push('  } finally {')
      lines.push('    handle.close()')
      lines.push('  }')
    } else {
      lines.push('  const file = process.env.NWC_URI_FILE')
      lines.push("  if (!file) throw new Error('NWC_URI_FILE is required')")
      lines.push("  const descriptor = openSync(file, 'r')")
      lines.push('  let bytes: Buffer | undefined')
      lines.push('  try {')
      lines.push('    const info = fstatSync(descriptor)')
      lines.push("    if (!info.isFile() || info.size === 0 || info.size > 8192) throw new Error('NWC_URI_FILE must be a non-empty regular file no larger than 8192 bytes')")
      lines.push("    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('NWC_URI_FILE permissions are too broad; run chmod 600 on the file')")
      lines.push('    bytes = Buffer.allocUnsafe(info.size)')
      lines.push('    let offset = 0')
      lines.push('    while (offset < bytes.length) {')
      lines.push('      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null)')
      lines.push("      if (count === 0) throw new Error('NWC_URI_FILE changed while it was being read')")
      lines.push('      offset += count')
      lines.push('    }')
      lines.push('    const extra = Buffer.allocUnsafe(1)')
      lines.push('    try {')
      lines.push("      if (readSync(descriptor, extra, 0, 1, null) !== 0) throw new Error('NWC_URI_FILE changed while it was being read')")
      lines.push('    } finally {')
      lines.push('      extra.fill(0)')
      lines.push('    }')
      lines.push("    return bytes.toString('utf8').trim()")
      lines.push('  } finally {')
      lines.push('    bytes?.fill(0)')
      lines.push('    closeSync(descriptor)')
      lines.push('  }')
    }
    lines.push('}')
    lines.push('')
  }

  // Backend setup
  if (!isCashuOnly && isExpress) {
    lines.push(`const backend = ${ctx.backendSetup}`)
    lines.push('')
  }

  if (isExpress) {
    lines.push('const app = express()')
    lines.push('app.use(express.json())')
    lines.push('')
    lines.push('const booth = new Booth({')
    lines.push("  adapter: 'express',")
    if (!isCashuOnly) {
      lines.push('  backend,')
    }
    lines.push("  pricing: { '/': 1 },")
    lines.push(`  upstream: ${upstream},`)
    lines.push(`  freeTier: { requestsPerDay: parseInt(${envGet('FREE_TIER_REQUESTS', '10')}, 10) },`)
    lines.push('  defaultInvoiceAmount: 1000,')
    lines.push(`  rootKey: process.env.ROOT_KEY,`)
    lines.push('  trustProxy: true,')
    lines.push('})')
    lines.push('')
    lines.push("app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)")
    lines.push("app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)")
    lines.push("app.use('/', booth.middleware as express.RequestHandler)")
    lines.push('')
    lines.push(`const port = parseInt(${envGet('PORT', '3000')}, 10)`)
    lines.push('const server = app.listen(port, () => {')
    lines.push(`  console.log(\`${ctx.projectName} listening on :\${port}\`)`)
    lines.push('})')
    lines.push('')
    lines.push('function shutdown() {')
    lines.push('  server.close()')
    lines.push('  booth.close()')
    lines.push('  process.exit(0)')
    lines.push('}')
    lines.push('')
    lines.push("process.on('SIGTERM', shutdown)")
    lines.push("process.on('SIGINT', shutdown)")
  } else if (isDeno) {
    if (!isCashuOnly) {
      lines.push(`const backend = ${ctx.backendSetup.replace(/process\.env\./g, "Deno.env.get('").replace(/!/g, "') ?? ''")}`)
    }
    lines.push('')
    lines.push('const booth = new Booth({')
    lines.push("  adapter: 'web-standard',")
    if (!isCashuOnly) {
      lines.push('  backend,')
    }
    lines.push("  pricing: { '/': 1 },")
    lines.push(`  upstream: ${upstream},`)
    lines.push(`  freeTier: { requestsPerDay: parseInt(${envGet('FREE_TIER_REQUESTS', '10')}, 10) },`)
    lines.push('  defaultInvoiceAmount: 1000,')
    lines.push(`  rootKey: Deno.env.get('ROOT_KEY'),`)
    lines.push('  trustProxy: true,')
    lines.push('})')
    lines.push('')
    lines.push('const middleware = booth.middleware as (req: Request) => Promise<Response>')
    lines.push('')
    lines.push(`const port = parseInt(${envGet('PORT', '3000')}, 10)`)
    lines.push(`console.log(\`${ctx.projectName} listening on :\${port}\`)`)
    lines.push('Deno.serve({ port }, (req: Request) => middleware(req))')
  } else if (isHono) {
    // Hono non-golden-path: use createHonoTollBooth
    lines.push('const storage = memoryStorage()')
    lines.push('')

    if (!isCashuOnly) {
      lines.push(`const backend = ${ctx.backendSetup}`)
      lines.push('')
    }

    lines.push('const engine = createTollBooth({')
    if (!isCashuOnly) {
      lines.push('  backend,')
    }
    lines.push('  storage,')
    lines.push("  pricing: { '/': 1 },")
    lines.push(`  upstream: ${upstream},`)
    lines.push('  defaultInvoiceAmount: 1000,')
    lines.push(`  freeTier: { requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10) },`)
    lines.push("  rootKey: process.env.ROOT_KEY ?? '',")
    if (isCashuOnly) {
      lines.push('  rails: [],')
    }
    lines.push('})')
    lines.push('')
    lines.push('const { authMiddleware, createPaymentApp } = createHonoTollBooth({')
    lines.push('  engine,')
    lines.push('  trustProxy: true,')
    lines.push('})')
    lines.push('')
    lines.push('const paymentApp = createPaymentApp({')
    lines.push('  storage,')
    lines.push("  rootKey: process.env.ROOT_KEY ?? '',")
    lines.push('  tiers: [],')
    lines.push('  defaultAmount: 1000,')
    if (!isCashuOnly) {
      lines.push('  backend,')
    }
    lines.push('})')
    lines.push('')
    lines.push('const app = new Hono<TollBoothEnv>()')
    lines.push("app.route('/pay', paymentApp)")
    lines.push("app.use('*', authMiddleware)")
    lines.push('')
    lines.push(`app.get('/', (c) => c.json({ message: 'Hello from ${ctx.projectName}!' }))`)
    lines.push('')
    lines.push("const port = parseInt(process.env.PORT ?? '3000', 10)")
    lines.push(`console.log(\`${ctx.projectName} listening on :\${port}\`)`)
    lines.push('serve({ fetch: app.fetch, port })')
  } else {
    // Bun / web-standard fallback
    if (!isCashuOnly) {
      lines.push(`const backend = ${ctx.backendSetup}`)
    }
    lines.push('')
    lines.push('const booth = new Booth({')
    lines.push("  adapter: 'web-standard',")
    if (!isCashuOnly) {
      lines.push('  backend,')
    }
    lines.push("  pricing: { '/': 1 },")
    lines.push(`  upstream: ${upstream},`)
    lines.push(`  freeTier: { requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10) },`)
    lines.push('  defaultInvoiceAmount: 1000,')
    lines.push('  rootKey: process.env.ROOT_KEY,')
    lines.push('  trustProxy: true,')
    lines.push('})')
    lines.push('')
    lines.push('const middleware = booth.middleware as (req: Request) => Promise<Response>')
    lines.push('')
    lines.push("const port = parseInt(process.env.PORT ?? '3000', 10)")
    lines.push(`console.log(\`${ctx.projectName} listening on :\${port}\`)`)
    lines.push(`Bun.serve({ port, fetch: (req) => middleware(req) })`)
  }

  lines.push('')
  return lines.join('\n')
}

export function generateGeneric(ctx: TemplateContext): GeneratedProject {
  const isDeno = ctx.framework === 'deno'
  const isCashuOnly = ctx.backend === 'cashu-only'

  const files: Record<string, string> = {
    'server.ts': generateServer(ctx),
    '.env.example': generateEnvExample(ctx.envVars),
    'README.md': generateReadme(ctx.projectName, ctx.framework, ctx.backend),
    '.gitignore': generateGitignore(),
  }

  if (isDeno) {
    const imports: Record<string, string> = {
      '@forgesworn/toll-booth': TOLL_BOOTH_DENO_PACKAGE,
    }
    if (!isCashuOnly) {
      const backendSubpath = `backends/${ctx.backend}`
      imports[`@forgesworn/toll-booth/${backendSubpath}`] = tollBoothDenoSubpath(backendSubpath)
    }
    const denoConfig = {
      tasks: {
        start: 'deno run --allow-net --allow-env --allow-read server.ts',
        dev: 'deno run --watch --allow-net --allow-env --allow-read server.ts',
      },
      imports,
    }
    files['deno.json'] = JSON.stringify(denoConfig, null, 2) + '\n'
  } else {
    const deps = [...ctx.dependencies]
    if (ctx.framework === 'hono' && !deps.includes('@hono/node-server')) {
      deps.push('@hono/node-server')
    }
    files['package.json'] = generatePackageJson(ctx.projectName, deps, ctx.framework)
    files['tsconfig.json'] = generateTsConfig(ctx.framework)
  }

  return { files }
}
