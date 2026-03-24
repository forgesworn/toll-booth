// src/templates/express-phoenixd.ts - Express + Phoenixd golden-path template

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

  return `import express from 'express'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const app = express()
app.use(express.json())

const backend = phoenixdBackend({
  url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
  password: process.env.PHOENIXD_PASSWORD ?? '',
})

const booth = new Booth({
  adapter: 'express',
  backend,
  pricing: { '/': 1 },
  upstream: ${upstream},
  freeTier: { requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10) },
  defaultInvoiceAmount: 1000,
  rootKey: process.env.ROOT_KEY,
  trustProxy: true,
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)
app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)
app.use('/', booth.middleware as express.RequestHandler)

const port = parseInt(process.env.PORT ?? '3000', 10)
const server = app.listen(port, () => {
  console.log(\`${ctx.projectName} listening on :\${port}\`)
})

function shutdown() {
  server.close()
  booth.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
`
}

export function generateExpressPhoenixd(ctx: TemplateContext): GeneratedProject {
  return {
    files: {
      'server.ts': generateServer(ctx),
      'package.json': generatePackageJson(ctx.projectName, ['@forgesworn/toll-booth', 'express'], 'express'),
      '.env.example': generateEnvExample(ctx.envVars),
      'README.md': generateReadme(ctx.projectName, 'Express', 'Phoenixd'),
      '.gitignore': generateGitignore(),
      'tsconfig.json': generateTsConfig(),
    },
  }
}
