// src/init.test.ts — tests for init command wiring

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { selectTemplate, writeProject, formatSuccessMessage } from './init.js'
import { buildTemplateContext } from './init-prompts.js'
import { generateExpressPhoenixd } from './templates/express-phoenixd.js'
import { generateHonoCashu } from './templates/hono-cashu.js'
import { generateDenoLnd } from './templates/deno-lnd.js'
import { generateExpressNwc } from './templates/express-nwc.js'
import { generateGeneric } from './templates/generic.js'

import type { Framework, Backend, InitConfig } from './init-prompts.js'

// ---- Helpers ----

function makeConfig(overrides: Partial<InitConfig> = {}): InitConfig {
  return {
    framework: 'express',
    backend: 'phoenixd',
    pricingMode: 'flat',
    upstream: 'stub',
    projectName: 'test-project',
    ...overrides,
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toll-booth-init-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---- selectTemplate ----

describe('selectTemplate', () => {
  it('returns express-phoenixd template for express + phoenixd', () => {
    expect(selectTemplate('express', 'phoenixd')).toBe(generateExpressPhoenixd)
  })

  it('returns hono-cashu template for hono + cashu-only', () => {
    expect(selectTemplate('hono', 'cashu-only')).toBe(generateHonoCashu)
  })

  it('returns deno-lnd template for deno + lnd', () => {
    expect(selectTemplate('deno', 'lnd')).toBe(generateDenoLnd)
  })

  it('returns express-nwc template for express + nwc', () => {
    expect(selectTemplate('express', 'nwc')).toBe(generateExpressNwc)
  })

  it('returns generic template for non-golden-path combinations', () => {
    const nonGolden: [Framework, Backend][] = [
      ['express', 'lnd'],
      ['express', 'cln'],
      ['express', 'lnbits'],
      ['express', 'cashu-only'],
      ['hono', 'phoenixd'],
      ['hono', 'lnd'],
      ['deno', 'phoenixd'],
      ['deno', 'cashu-only'],
      ['bun', 'phoenixd'],
      ['bun', 'lnd'],
    ]

    for (const [fw, be] of nonGolden) {
      expect(selectTemplate(fw, be), `${fw} + ${be} should be generic`).toBe(generateGeneric)
    }
  })
})

// ---- writeProject ----

describe('writeProject', () => {
  it('writes all generated files to the output directory', () => {
    const config = makeConfig()
    const ctx = buildTemplateContext(config)
    const template = selectTemplate(config.framework, config.backend)
    const project = template(ctx)

    const outDir = path.join(tmpDir, 'output')
    writeProject(outDir, project)

    const written = fs.readdirSync(outDir).sort()
    const expected = Object.keys(project.files).sort()

    expect(written).toEqual(expected)
  })

  it('creates subdirectories as needed', () => {
    const project = {
      files: {
        'src/server.ts': '// server',
        'src/lib/util.ts': '// util',
        'README.md': '# test',
      },
    }

    const outDir = path.join(tmpDir, 'nested')
    writeProject(outDir, project)

    expect(fs.existsSync(path.join(outDir, 'src', 'server.ts'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'src', 'lib', 'util.ts'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'README.md'))).toBe(true)
  })

  it('throws if directory exists and is not empty', () => {
    const outDir = path.join(tmpDir, 'existing')
    fs.mkdirSync(outDir)
    fs.writeFileSync(path.join(outDir, 'file.txt'), 'hello')

    const project = { files: { 'test.ts': '// test' } }

    expect(() => writeProject(outDir, project)).toThrow('already exists and is not empty')
  })

  it('succeeds if directory exists but is empty', () => {
    const outDir = path.join(tmpDir, 'empty')
    fs.mkdirSync(outDir)

    const project = { files: { 'test.ts': '// test' } }
    writeProject(outDir, project)

    expect(fs.readFileSync(path.join(outDir, 'test.ts'), 'utf-8')).toBe('// test')
  })

  it('file contents match generated content', () => {
    const config = makeConfig()
    const ctx = buildTemplateContext(config)
    const project = selectTemplate(config.framework, config.backend)(ctx)

    const outDir = path.join(tmpDir, 'content-check')
    writeProject(outDir, project)

    for (const [relativePath, content] of Object.entries(project.files)) {
      const actual = fs.readFileSync(path.join(outDir, relativePath), 'utf-8')
      expect(actual).toBe(content)
    }
  })
})

// ---- Generated content ----

describe('generated server.ts content', () => {
  it('express + phoenixd contains correct imports', () => {
    const ctx = buildTemplateContext(makeConfig({ framework: 'express', backend: 'phoenixd' }))
    const project = generateExpressPhoenixd(ctx)
    const server = project.files['server.ts']!

    expect(server).toContain("import express from 'express'")
    expect(server).toContain("import { Booth } from '@forgesworn/toll-booth'")
    expect(server).toContain("import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'")
  })

  it('hono + cashu-only contains Hono imports and no Lightning backend', () => {
    const ctx = buildTemplateContext(makeConfig({ framework: 'hono', backend: 'cashu-only' }))
    const project = generateHonoCashu(ctx)
    const server = project.files['server.ts']!

    expect(server).toContain("import { Hono } from 'hono'")
    expect(server).toContain("import { createHonoTollBooth, type TollBoothEnv } from '@forgesworn/toll-booth/hono'")
    expect(server).not.toContain('phoenixdBackend')
    expect(server).not.toContain('lndBackend')
  })

  it('deno + lnd uses Deno.env and Deno.serve', () => {
    const ctx = buildTemplateContext(makeConfig({ framework: 'deno', backend: 'lnd' }))
    const project = generateDenoLnd(ctx)
    const server = project.files['server.ts']!

    expect(server).toContain('Deno.env.get')
    expect(server).toContain('Deno.serve')
    expect(server).toContain("import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'")
  })

  it('express + nwc contains NWC backend import', () => {
    const ctx = buildTemplateContext(makeConfig({ framework: 'express', backend: 'nwc' }))
    const project = generateExpressNwc(ctx)
    const server = project.files['server.ts']!

    expect(server).toContain("import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'")
    expect(server).toContain('NWC_URI_FILE')
  })

  it('deno template generates deno.json instead of package.json', () => {
    const ctx = buildTemplateContext(makeConfig({ framework: 'deno', backend: 'lnd' }))
    const project = generateDenoLnd(ctx)

    expect(project.files['deno.json']).toBeDefined()
    expect(project.files['package.json']).toBeUndefined()
  })
})

// ---- formatSuccessMessage ----

describe('formatSuccessMessage', () => {
  it('includes project name and npm instructions for Node frameworks', () => {
    const msg = formatSuccessMessage('my-api', './my-api', false)

    expect(msg).toContain('\u2713 Project created in ./my-api')
    expect(msg).toContain('cd my-api')
    expect(msg).toContain('cp .env.example .env')
    expect(msg).toContain('npm install')
    expect(msg).toContain('npm start')
  })

  it('uses deno task start for Deno projects', () => {
    const msg = formatSuccessMessage('my-deno-api', './my-deno-api', true)

    expect(msg).toContain('deno task start')
    expect(msg).not.toContain('npm install')
    expect(msg).not.toContain('npm start')
  })

  it('uses the output directory path for absolute paths', () => {
    const msg = formatSuccessMessage('my-api', '/tmp/my-api', false)

    expect(msg).toContain('\u2713 Project created in /tmp/my-api')
  })
})
