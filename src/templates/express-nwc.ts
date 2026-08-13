// src/templates/express-nwc.ts - Express + NWC golden-path template

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
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { Booth } from '@forgesworn/toll-booth'
import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'

function loadNwcUri(): string {
  const file = process.env.NWC_URI_FILE
  if (!file) throw new Error('NWC_URI_FILE is required')
  const descriptor = openSync(file, 'r')
  let bytes: Buffer | undefined
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size === 0 || info.size > 8192) {
      throw new Error('NWC_URI_FILE must be a non-empty regular file no larger than 8192 bytes')
    }
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('NWC_URI_FILE permissions are too broad; run chmod 600 on the file')
    }
    bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null)
      if (count === 0) throw new Error('NWC_URI_FILE changed while it was being read')
      offset += count
    }
    const extra = Buffer.allocUnsafe(1)
    try {
      if (readSync(descriptor, extra, 0, 1, null) !== 0) throw new Error('NWC_URI_FILE changed while it was being read')
    } finally {
      extra.fill(0)
    }
    return bytes.toString('utf8').trim()
  } finally {
    bytes?.fill(0)
    closeSync(descriptor)
  }
}

const app = express()
app.use(express.json())

const backend = nwcBackend({
  nwcUrl: loadNwcUri(),
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

export function generateExpressNwc(ctx: TemplateContext): GeneratedProject {
  return {
    files: {
      'server.ts': generateServer(ctx),
      'package.json': generatePackageJson(ctx.projectName, ['@forgesworn/toll-booth', 'express'], 'express'),
      '.env.example': generateEnvExample(ctx.envVars),
      'README.md': generateReadme(ctx.projectName, 'Express', 'NWC'),
      '.gitignore': generateGitignore(),
      'tsconfig.json': generateTsConfig(),
    },
  }
}
