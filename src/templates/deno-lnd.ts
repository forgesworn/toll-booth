// src/templates/deno-lnd.ts - Deno + LND golden-path template

import type { TemplateContext } from '../init-prompts.js'
import type { GeneratedProject } from './shared.js'
import {
  generateEnvExample,
  generateReadme,
  generateGitignore,
} from './shared.js'

function generateServer(ctx: TemplateContext): string {
  const upstream = ctx.upstream === 'stub'
    ? "'http://localhost:4000'"
    : `Deno.env.get('UPSTREAM_URL') ?? 'http://localhost:4000'`

  return `import { Booth } from '@forgesworn/toll-booth'
import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'

const backend = lndBackend({
  url: Deno.env.get('LND_REST_URL') ?? 'https://localhost:8080',
  macaroon: Deno.env.get('LND_MACAROON') ?? '',
})

const booth = new Booth({
  adapter: 'web-standard',
  backend,
  pricing: { '/': 1 },
  upstream: ${upstream},
  freeTier: { requestsPerDay: parseInt(Deno.env.get('FREE_TIER_REQUESTS') ?? '10', 10) },
  defaultInvoiceAmount: 1000,
  rootKey: Deno.env.get('ROOT_KEY'),
  trustProxy: true,
})

const middleware = booth.middleware as (req: Request) => Promise<Response>
const invoiceStatus = booth.invoiceStatusHandler as (req: Request) => Promise<Response>
const createInvoice = booth.createInvoiceHandler as (req: Request) => Promise<Response>

const port = parseInt(Deno.env.get('PORT') ?? '3000', 10)
console.log(\`${ctx.projectName} listening on :\${port}\`)

Deno.serve({ port }, async (req: Request) => {
  const url = new URL(req.url)

  if (url.pathname.startsWith('/invoice-status/')) {
    return invoiceStatus(req)
  }
  if (url.pathname === '/create-invoice' && req.method === 'POST') {
    return createInvoice(req)
  }

  return middleware(req)
})
`
}

function generateDenoJson(_ctx: TemplateContext): string {
  const config = {
    tasks: {
      start: 'deno run --allow-net --allow-env --allow-read server.ts',
      dev: 'deno run --watch --allow-net --allow-env --allow-read server.ts',
    },
    imports: {
      '@forgesworn/toll-booth': 'npm:@forgesworn/toll-booth@latest',
      '@forgesworn/toll-booth/backends/lnd': 'npm:@forgesworn/toll-booth@latest/backends/lnd',
    },
  }

  return JSON.stringify(config, null, 2) + '\n'
}

export function generateDenoLnd(ctx: TemplateContext): GeneratedProject {
  return {
    files: {
      'server.ts': generateServer(ctx),
      'deno.json': generateDenoJson(ctx),
      '.env.example': generateEnvExample(ctx.envVars),
      'README.md': generateReadme(ctx.projectName, 'Deno', 'LND'),
      '.gitignore': generateGitignore(),
    },
  }
}
