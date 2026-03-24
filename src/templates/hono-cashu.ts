// src/templates/hono-cashu.ts - Hono + Cashu-only golden-path template

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
  const upstream = ctx.upstream === 'stub'
    ? "'http://localhost:4000'"
    : `process.env.UPSTREAM_URL ?? 'http://localhost:4000'`

  return `import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createHonoTollBooth } from '@forgesworn/toll-booth/adapters/hono'
import { createTollBooth } from '@forgesworn/toll-booth'
import { memoryStorage } from '@forgesworn/toll-booth'

const storage = memoryStorage()

const engine = createTollBooth({
  storage,
  pricing: { '/': 1 },
  upstream: ${upstream},
  defaultInvoiceAmount: 1000,
  freeTier: { requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10) },
  rootKey: process.env.ROOT_KEY ?? '',
  normalisedPricing: new Map([['/', { default: { amount: 1, currency: 'sat' } }]]),
  rails: [],
})

const { authMiddleware, createPaymentApp } = createHonoTollBooth({
  engine,
  trustProxy: true,
})

const paymentApp = createPaymentApp({
  storage,
  rootKey: process.env.ROOT_KEY ?? '',
  tiers: [],
  defaultAmount: 1000,
})

const app = new Hono()
app.route('/pay', paymentApp)
app.use('*', authMiddleware)

app.get('/', (c) => c.json({ message: 'Hello from ${ctx.projectName}!' }))

const port = parseInt(process.env.PORT ?? '3000', 10)
console.log(\`${ctx.projectName} listening on :\${port}\`)
serve({ fetch: app.fetch, port })
`
}

export function generateHonoCashu(ctx: TemplateContext): GeneratedProject {
  return {
    files: {
      'server.ts': generateServer(ctx),
      'package.json': generatePackageJson(ctx.projectName, ['@forgesworn/toll-booth', 'hono', '@hono/node-server'], 'hono'),
      '.env.example': generateEnvExample(ctx.envVars),
      'README.md': generateReadme(ctx.projectName, 'Hono', 'Cashu-only'),
      '.gitignore': generateGitignore(),
      'tsconfig.json': generateTsConfig(),
    },
  }
}
