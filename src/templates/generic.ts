// src/templates/generic.ts - fallback template for non-golden-path combinations

import type { TemplateContext } from '../init-prompts.js'
import type { GeneratedProject } from './shared.js'
import {
  generatePackageJson,
  generateEnvExample,
  generateReadme,
  generateGitignore,
  generateTsConfig,
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

  if (isHono) {
    lines.push("import { createHonoTollBooth } from '@forgesworn/toll-booth/adapters/hono'")
    lines.push("import { createTollBooth, memoryStorage } from '@forgesworn/toll-booth'")
  } else {
    lines.push("import { Booth } from '@forgesworn/toll-booth'")
  }

  if (!isCashuOnly && ctx.backendImport) {
    lines.push(ctx.backendImport)
  }
  lines.push('')

  // Backend setup
  if (!isCashuOnly && !isHono) {
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
    lines.push("  normalisedPricing: new Map([['/', { default: { amount: 1, currency: 'sat' } }]]),")
    lines.push('  rails: [],')
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
    lines.push('const app = new Hono()')
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

  const files: Record<string, string> = {
    'server.ts': generateServer(ctx),
    '.env.example': generateEnvExample(ctx.envVars),
    'README.md': generateReadme(ctx.projectName, ctx.framework, ctx.backend),
    '.gitignore': generateGitignore(),
  }

  if (isDeno) {
    const denoConfig = {
      tasks: {
        start: 'deno run --allow-net --allow-env --allow-read server.ts',
        dev: 'deno run --watch --allow-net --allow-env --allow-read server.ts',
      },
      imports: {
        '@forgesworn/toll-booth': 'npm:@forgesworn/toll-booth@latest',
      },
    }
    files['deno.json'] = JSON.stringify(denoConfig, null, 2) + '\n'
  } else {
    const deps = [...ctx.dependencies]
    if (ctx.framework === 'hono' && !deps.includes('@hono/node-server')) {
      deps.push('@hono/node-server')
    }
    files['package.json'] = generatePackageJson(ctx.projectName, deps, ctx.framework)
    files['tsconfig.json'] = generateTsConfig()
  }

  return { files }
}
