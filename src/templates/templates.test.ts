// src/templates/templates.test.ts
import { describe, it, expect } from 'vitest'
import { buildTemplateContext } from '../init-prompts.js'
import type { TemplateContext } from '../init-prompts.js'
import { generateExpressPhoenixd } from './express-phoenixd.js'
import { generateHonoCashu } from './hono-cashu.js'
import { generateDenoLnd } from './deno-lnd.js'
import { generateExpressNwc } from './express-nwc.js'
import { generateGeneric } from './generic.js'
import {
  generatePackageJson,
  generateEnvExample,
  generateReadme,
  generateGitignore,
  generateTsConfig,
} from './shared.js'

// ---- Helpers ----

function makeContext(overrides: Partial<Parameters<typeof buildTemplateContext>[0]> = {}): TemplateContext {
  return buildTemplateContext({
    framework: 'express',
    backend: 'phoenixd',
    pricingMode: 'flat',
    upstream: 'stub',
    projectName: 'test-project',
    ...overrides,
  })
}

// ---- Shared helpers ----

describe('shared helpers', () => {
  it('generatePackageJson includes correct fields', () => {
    const json = generatePackageJson('my-api', ['@forgesworn/toll-booth', 'express'], 'express')
    const pkg = JSON.parse(json)

    expect(pkg.name).toBe('my-api')
    expect(pkg.version).toBe('1.0.0')
    expect(pkg.type).toBe('module')
    expect(pkg.scripts.start).toBeDefined()
    expect(pkg.scripts.build).toBeDefined()
    expect(pkg.scripts.dev).toBeDefined()
    expect(pkg.dependencies['@forgesworn/toll-booth']).toBeDefined()
    expect(pkg.dependencies.express).toBeDefined()
    expect(pkg.devDependencies.typescript).toBeDefined()
    expect(pkg.devDependencies['@types/node']).toBeDefined()
    expect(pkg.devDependencies['@types/express']).toBeDefined()
  })

  it('generatePackageJson omits @types/express for non-express frameworks', () => {
    const json = generatePackageJson('my-api', ['@forgesworn/toll-booth', 'hono'], 'hono')
    const pkg = JSON.parse(json)

    expect(pkg.devDependencies['@types/express']).toBeUndefined()
  })

  it('generateEnvExample produces key=value pairs with comments', () => {
    const env = generateEnvExample({
      PORT: 'HTTP listen port (default: 3000)',
      PHOENIXD_URL: 'Phoenixd HTTP endpoint',
    })

    expect(env).toContain('PORT=3000')
    expect(env).toContain('# HTTP listen port')
    expect(env).toContain('PHOENIXD_URL=')
    expect(env).toContain('# Phoenixd HTTP endpoint')
  })

  it('generateReadme includes project name and framework info', () => {
    const readme = generateReadme('my-api', 'Express', 'Phoenixd')

    expect(readme).toContain('# my-api')
    expect(readme).toContain('Express')
    expect(readme).toContain('Phoenixd')
    expect(readme).toContain('toll-booth init')
  })

  it('generateGitignore includes standard entries', () => {
    const gitignore = generateGitignore()

    expect(gitignore).toContain('node_modules/')
    expect(gitignore).toContain('dist/')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('*.db')
  })

  it('generateTsConfig targets ES2022 with Node16 module', () => {
    const json = generateTsConfig()
    const config = JSON.parse(json)

    expect(config.compilerOptions.target).toBe('ES2022')
    expect(config.compilerOptions.module).toBe('Node16')
    expect(config.compilerOptions.moduleResolution).toBe('Node16')
  })
})

// ---- Express + Phoenixd ----

describe('express-phoenixd template', () => {
  const ctx = makeContext({ framework: 'express', backend: 'phoenixd' })
  const project = generateExpressPhoenixd(ctx)

  it('generates all expected files', () => {
    expect(Object.keys(project.files)).toEqual(
      expect.arrayContaining(['server.ts', 'package.json', '.env.example', 'README.md', '.gitignore', 'tsconfig.json']),
    )
  })

  it('server.ts imports express and phoenixdBackend', () => {
    const server = project.files['server.ts']
    expect(server).toContain("import express from 'express'")
    expect(server).toContain("import { Booth } from '@forgesworn/toll-booth'")
    expect(server).toContain("import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'")
  })

  it('server.ts uses Booth with express adapter', () => {
    const server = project.files['server.ts']
    expect(server).toContain("adapter: 'express'")
    expect(server).toContain('booth.middleware')
    expect(server).toContain('booth.invoiceStatusHandler')
    expect(server).toContain('booth.createInvoiceHandler')
  })

  it('server.ts includes graceful shutdown', () => {
    const server = project.files['server.ts']
    expect(server).toContain('booth.close()')
    expect(server).toContain('SIGTERM')
    expect(server).toContain('SIGINT')
  })

  it('package.json has express and toll-booth dependencies', () => {
    const pkg = JSON.parse(project.files['package.json'])
    expect(pkg.dependencies['@forgesworn/toll-booth']).toBeDefined()
    expect(pkg.dependencies.express).toBeDefined()
  })

  it('.env.example has Phoenixd variables', () => {
    const env = project.files['.env.example']
    expect(env).toContain('PHOENIXD_URL')
    expect(env).toContain('PHOENIXD_PASSWORD')
    expect(env).toContain('ROOT_KEY')
    expect(env).toContain('PORT')
  })
})

// ---- Hono + Cashu ----

describe('hono-cashu template', () => {
  const ctx = makeContext({ framework: 'hono', backend: 'cashu-only' })
  const project = generateHonoCashu(ctx)

  it('generates all expected files', () => {
    expect(Object.keys(project.files)).toEqual(
      expect.arrayContaining(['server.ts', 'package.json', '.env.example', 'README.md', '.gitignore', 'tsconfig.json']),
    )
  })

  it('server.ts imports Hono and createHonoTollBooth', () => {
    const server = project.files['server.ts']
    expect(server).toContain("import { Hono } from 'hono'")
    expect(server).toContain("import { createHonoTollBooth } from '@forgesworn/toll-booth/adapters/hono'")
  })

  it('server.ts does NOT import any Lightning backend', () => {
    const server = project.files['server.ts']
    expect(server).not.toContain('phoenixdBackend')
    expect(server).not.toContain('lndBackend')
    expect(server).not.toContain('nwcBackend')
  })

  it('server.ts uses createHonoTollBooth pattern', () => {
    const server = project.files['server.ts']
    expect(server).toContain('createHonoTollBooth')
    expect(server).toContain('authMiddleware')
    expect(server).toContain('createPaymentApp')
  })

  it('package.json has hono dependency', () => {
    const pkg = JSON.parse(project.files['package.json'])
    expect(pkg.dependencies.hono).toBeDefined()
    expect(pkg.dependencies['@forgesworn/toll-booth']).toBeDefined()
  })

  it('.env.example has Cashu variables', () => {
    const env = project.files['.env.example']
    expect(env).toContain('CASHU_MINT_URL')
  })
})

// ---- Deno + LND ----

describe('deno-lnd template', () => {
  const ctx = makeContext({ framework: 'deno', backend: 'lnd' })
  const project = generateDenoLnd(ctx)

  it('generates deno.json instead of package.json', () => {
    expect(project.files['deno.json']).toBeDefined()
    expect(project.files['package.json']).toBeUndefined()
  })

  it('does not generate tsconfig.json (Deno handles TS natively)', () => {
    expect(project.files['tsconfig.json']).toBeUndefined()
  })

  it('generates standard files', () => {
    expect(Object.keys(project.files)).toEqual(
      expect.arrayContaining(['server.ts', 'deno.json', '.env.example', 'README.md', '.gitignore']),
    )
  })

  it('server.ts imports Booth and lndBackend', () => {
    const server = project.files['server.ts']
    expect(server).toContain("import { Booth } from '@forgesworn/toll-booth'")
    expect(server).toContain("import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'")
  })

  it('server.ts uses Deno.serve and Deno.env.get', () => {
    const server = project.files['server.ts']
    expect(server).toContain('Deno.serve')
    expect(server).toContain('Deno.env.get')
  })

  it('server.ts uses web-standard adapter', () => {
    const server = project.files['server.ts']
    expect(server).toContain("adapter: 'web-standard'")
  })

  it('.env.example has LND variables', () => {
    const env = project.files['.env.example']
    expect(env).toContain('LND_REST_URL')
    expect(env).toContain('LND_MACAROON')
  })

  it('deno.json has import maps for toll-booth', () => {
    const denoConfig = JSON.parse(project.files['deno.json'])
    expect(denoConfig.imports['@forgesworn/toll-booth']).toBeDefined()
  })
})

// ---- Express + NWC ----

describe('express-nwc template', () => {
  const ctx = makeContext({ framework: 'express', backend: 'nwc' })
  const project = generateExpressNwc(ctx)

  it('generates all expected files', () => {
    expect(Object.keys(project.files)).toEqual(
      expect.arrayContaining(['server.ts', 'package.json', '.env.example', 'README.md', '.gitignore', 'tsconfig.json']),
    )
  })

  it('server.ts imports nwcBackend', () => {
    const server = project.files['server.ts']
    expect(server).toContain("import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'")
  })

  it('server.ts uses nwcUrl parameter (real API)', () => {
    const server = project.files['server.ts']
    expect(server).toContain('nwcUrl:')
  })

  it('server.ts uses express adapter', () => {
    const server = project.files['server.ts']
    expect(server).toContain("adapter: 'express'")
  })

  it('.env.example has NWC_URI variable', () => {
    const env = project.files['.env.example']
    expect(env).toContain('NWC_URI')
  })

  it('package.json has express dependency', () => {
    const pkg = JSON.parse(project.files['package.json'])
    expect(pkg.dependencies.express).toBeDefined()
  })
})

// ---- Generic template ----

describe('generic template', () => {
  it('works for Hono + LND (non-golden-path)', () => {
    const ctx = makeContext({ framework: 'hono', backend: 'lnd' })
    const project = generateGeneric(ctx)

    expect(project.files['server.ts']).toBeDefined()
    expect(project.files['package.json']).toBeDefined()
    expect(project.files['.env.example']).toBeDefined()
    expect(project.files['README.md']).toBeDefined()
    expect(project.files['.gitignore']).toBeDefined()

    const server = project.files['server.ts']
    expect(server).toContain("import { Hono } from 'hono'")
    expect(server).toContain('createHonoTollBooth')
    expect(server).toContain('lndBackend')
  })

  it('works for Express + CLN', () => {
    const ctx = makeContext({ framework: 'express', backend: 'cln' })
    const project = generateGeneric(ctx)

    const server = project.files['server.ts']
    expect(server).toContain("import express from 'express'")
    expect(server).toContain('clnBackend')
    expect(server).toContain("adapter: 'express'")
  })

  it('works for Deno + Phoenixd', () => {
    const ctx = makeContext({ framework: 'deno', backend: 'phoenixd' })
    const project = generateGeneric(ctx)

    expect(project.files['deno.json']).toBeDefined()
    expect(project.files['package.json']).toBeUndefined()

    const server = project.files['server.ts']
    expect(server).toContain('Deno.serve')
    expect(server).toContain("adapter: 'web-standard'")
  })

  it('works for Bun + LNbits', () => {
    const ctx = makeContext({ framework: 'bun' as any, backend: 'lnbits' })
    const project = generateGeneric(ctx)

    const server = project.files['server.ts']
    expect(server).toContain('Bun.serve')
    expect(server).toContain('lnbitsBackend')
  })

  it('works for Express + cashu-only', () => {
    const ctx = makeContext({ framework: 'express', backend: 'cashu-only' })
    const project = generateGeneric(ctx)

    const server = project.files['server.ts']
    expect(server).toContain("import express from 'express'")
    expect(server).not.toContain('phoenixdBackend')
    expect(server).not.toContain('lndBackend')
  })

  it('includes UPSTREAM_URL env var when upstream is not stub', () => {
    const ctx = makeContext({ framework: 'express', backend: 'phoenixd', upstream: 'https://api.example.com' })
    const project = generateGeneric(ctx)

    expect(project.files['.env.example']).toContain('UPSTREAM_URL')
  })

  it('omits UPSTREAM_URL env var when upstream is stub', () => {
    const ctx = makeContext({ framework: 'express', backend: 'phoenixd', upstream: 'stub' })
    const project = generateGeneric(ctx)

    expect(project.files['.env.example']).not.toContain('UPSTREAM_URL')
  })

  it('includes @hono/node-server for hono projects', () => {
    const ctx = makeContext({ framework: 'hono', backend: 'phoenixd' })
    const project = generateGeneric(ctx)

    const pkg = JSON.parse(project.files['package.json'])
    expect(pkg.dependencies['@hono/node-server']).toBeDefined()
  })
})
