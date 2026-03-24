import { describe, it, expect } from 'vitest'
import { buildTemplateContext, parseCliFlags } from './init-prompts.js'
import type { InitConfig, Framework, Backend, PricingMode } from './init-prompts.js'

describe('buildTemplateContext', () => {
  const baseConfig: InitConfig = {
    framework: 'express',
    backend: 'phoenixd',
    pricingMode: 'flat',
    upstream: 'http://localhost:8080',
    projectName: 'my-api',
  }

  // --- Backend-specific mapping ---

  describe('phoenixd backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'phoenixd' })

    it('produces correct import path', () => {
      expect(ctx.backendImport).toBe(
        "import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'",
      )
    })

    it('produces correct setup code', () => {
      expect(ctx.backendSetup).toBe(
        "phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! })",
      )
    })

    it('includes backend-specific env vars', () => {
      expect(ctx.envVars).toHaveProperty('PHOENIXD_URL')
      expect(ctx.envVars).toHaveProperty('PHOENIXD_PASSWORD')
    })
  })

  describe('lnd backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'lnd' })

    it('produces correct import path', () => {
      expect(ctx.backendImport).toBe(
        "import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'",
      )
    })

    it('produces correct setup code', () => {
      expect(ctx.backendSetup).toBe(
        "lndBackend({ url: process.env.LND_REST_URL!, macaroon: process.env.LND_MACAROON! })",
      )
    })

    it('includes backend-specific env vars', () => {
      expect(ctx.envVars).toHaveProperty('LND_REST_URL')
      expect(ctx.envVars).toHaveProperty('LND_MACAROON')
    })
  })

  describe('cln backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'cln' })

    it('produces correct import path', () => {
      expect(ctx.backendImport).toBe(
        "import { clnBackend } from '@forgesworn/toll-booth/backends/cln'",
      )
    })

    it('produces correct setup code', () => {
      expect(ctx.backendSetup).toBe(
        "clnBackend({ url: process.env.CLN_REST_URL!, rune: process.env.CLN_RUNE! })",
      )
    })

    it('includes backend-specific env vars', () => {
      expect(ctx.envVars).toHaveProperty('CLN_REST_URL')
      expect(ctx.envVars).toHaveProperty('CLN_RUNE')
    })
  })

  describe('lnbits backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'lnbits' })

    it('produces correct import path', () => {
      expect(ctx.backendImport).toBe(
        "import { lnbitsBackend } from '@forgesworn/toll-booth/backends/lnbits'",
      )
    })

    it('produces correct setup code', () => {
      expect(ctx.backendSetup).toBe(
        "lnbitsBackend({ url: process.env.LNBITS_URL!, apiKey: process.env.LNBITS_API_KEY! })",
      )
    })

    it('includes backend-specific env vars', () => {
      expect(ctx.envVars).toHaveProperty('LNBITS_URL')
      expect(ctx.envVars).toHaveProperty('LNBITS_API_KEY')
    })
  })

  describe('nwc backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'nwc' })

    it('produces correct import path', () => {
      expect(ctx.backendImport).toBe(
        "import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'",
      )
    })

    it('produces correct setup code', () => {
      expect(ctx.backendSetup).toBe(
        "nwcBackend({ nwcUrl: process.env.NWC_URI! })",
      )
    })

    it('includes backend-specific env vars', () => {
      expect(ctx.envVars).toHaveProperty('NWC_URI')
    })
  })

  describe('cashu-only backend', () => {
    const ctx = buildTemplateContext({ ...baseConfig, backend: 'cashu-only' })

    it('produces empty import', () => {
      expect(ctx.backendImport).toBe('')
    })

    it('produces empty setup code', () => {
      expect(ctx.backendSetup).toBe('')
    })

    it('includes optional CASHU_MINT_URL env var', () => {
      expect(ctx.envVars).toHaveProperty('CASHU_MINT_URL')
    })
  })

  // --- Framework-specific mapping ---

  describe('express framework', () => {
    const ctx = buildTemplateContext({ ...baseConfig, framework: 'express' })

    it('includes express dependency', () => {
      expect(ctx.dependencies).toContain('express')
    })
  })

  describe('hono framework', () => {
    const ctx = buildTemplateContext({ ...baseConfig, framework: 'hono' })

    it('includes hono dependency', () => {
      expect(ctx.dependencies).toContain('hono')
    })
  })

  describe('deno framework', () => {
    const ctx = buildTemplateContext({ ...baseConfig, framework: 'deno' })

    it('does not include extra framework dependency', () => {
      expect(ctx.dependencies).not.toContain('express')
      expect(ctx.dependencies).not.toContain('hono')
    })
  })

  describe('bun framework', () => {
    const ctx = buildTemplateContext({ ...baseConfig, framework: 'bun' })

    it('does not include extra framework dependency', () => {
      expect(ctx.dependencies).not.toContain('express')
      expect(ctx.dependencies).not.toContain('hono')
    })
  })

  // --- Common env vars ---

  it('always includes PORT env var', () => {
    const ctx = buildTemplateContext(baseConfig)
    expect(ctx.envVars).toHaveProperty('PORT')
  })

  it('always includes ROOT_KEY env var', () => {
    const ctx = buildTemplateContext(baseConfig)
    expect(ctx.envVars).toHaveProperty('ROOT_KEY')
  })

  it('always includes FREE_TIER_REQUESTS env var', () => {
    const ctx = buildTemplateContext(baseConfig)
    expect(ctx.envVars).toHaveProperty('FREE_TIER_REQUESTS')
  })

  it('includes UPSTREAM_URL when upstream is not stub', () => {
    const ctx = buildTemplateContext({ ...baseConfig, upstream: 'http://localhost:8080' })
    expect(ctx.envVars).toHaveProperty('UPSTREAM_URL')
  })

  it('omits UPSTREAM_URL when upstream is stub', () => {
    const ctx = buildTemplateContext({ ...baseConfig, upstream: 'stub' })
    expect(ctx.envVars).not.toHaveProperty('UPSTREAM_URL')
  })

  // --- Passthrough fields ---

  it('passes through framework, backend, pricingMode, upstream, projectName', () => {
    const ctx = buildTemplateContext(baseConfig)
    expect(ctx.framework).toBe('express')
    expect(ctx.backend).toBe('phoenixd')
    expect(ctx.pricingMode).toBe('flat')
    expect(ctx.upstream).toBe('http://localhost:8080')
    expect(ctx.projectName).toBe('my-api')
  })

  // --- All combinations produce valid TemplateContext ---

  const frameworks: Framework[] = ['express', 'hono', 'deno', 'bun']
  const backends: Backend[] = ['phoenixd', 'lnd', 'cln', 'lnbits', 'nwc', 'cashu-only']
  const pricingModes: PricingMode[] = ['flat', 'tiered', 'per-token']

  for (const framework of frameworks) {
    for (const backend of backends) {
      for (const pricingMode of pricingModes) {
        it(`produces valid context for ${framework}/${backend}/${pricingMode}`, () => {
          const ctx = buildTemplateContext({
            framework,
            backend,
            pricingMode,
            upstream: 'http://example.com',
            projectName: 'test',
          })

          expect(ctx.framework).toBe(framework)
          expect(ctx.backend).toBe(backend)
          expect(ctx.pricingMode).toBe(pricingMode)
          expect(ctx.dependencies).toBeInstanceOf(Array)
          expect(ctx.dependencies.length).toBeGreaterThan(0)
          expect(typeof ctx.backendImport).toBe('string')
          expect(typeof ctx.backendSetup).toBe('string')
          expect(typeof ctx.envVars).toBe('object')
          expect(ctx.envVars).toHaveProperty('PORT')
          expect(ctx.envVars).toHaveProperty('ROOT_KEY')
        })
      }
    }
  }

  // --- toll-booth is always a dependency ---

  it('always includes @forgesworn/toll-booth as a dependency', () => {
    const ctx = buildTemplateContext(baseConfig)
    expect(ctx.dependencies).toContain('@forgesworn/toll-booth')
  })
})

describe('parseCliFlags', () => {
  it('parses --name flag', () => {
    const flags = parseCliFlags(['--name', 'my-api'])
    expect(flags.projectName).toBe('my-api')
  })

  it('parses --framework flag', () => {
    const flags = parseCliFlags(['--framework', 'hono'])
    expect(flags.framework).toBe('hono')
  })

  it('parses --backend flag', () => {
    const flags = parseCliFlags(['--backend', 'lnd'])
    expect(flags.backend).toBe('lnd')
  })

  it('parses --pricing flag', () => {
    const flags = parseCliFlags(['--pricing', 'tiered'])
    expect(flags.pricingMode).toBe('tiered')
  })

  it('parses --upstream flag', () => {
    const flags = parseCliFlags(['--upstream', 'http://localhost:9000'])
    expect(flags.upstream).toBe('http://localhost:9000')
  })

  it('parses all flags together', () => {
    const flags = parseCliFlags([
      '--name', 'test-proj',
      '--framework', 'deno',
      '--backend', 'cln',
      '--pricing', 'per-token',
      '--upstream', 'http://api.example.com',
    ])
    expect(flags.projectName).toBe('test-proj')
    expect(flags.framework).toBe('deno')
    expect(flags.backend).toBe('cln')
    expect(flags.pricingMode).toBe('per-token')
    expect(flags.upstream).toBe('http://api.example.com')
  })

  it('leaves missing flags as undefined', () => {
    const flags = parseCliFlags(['--name', 'only-name'])
    expect(flags.projectName).toBe('only-name')
    expect(flags.framework).toBeUndefined()
    expect(flags.backend).toBeUndefined()
    expect(flags.pricingMode).toBeUndefined()
    expect(flags.upstream).toBeUndefined()
  })

  it('ignores unknown flags', () => {
    const flags = parseCliFlags(['--unknown', 'value', '--name', 'test'])
    expect(flags.projectName).toBe('test')
    expect(flags).not.toHaveProperty('unknown')
  })

  it('handles empty argv', () => {
    const flags = parseCliFlags([])
    expect(flags.projectName).toBeUndefined()
    expect(flags.framework).toBeUndefined()
    expect(flags.backend).toBeUndefined()
    expect(flags.pricingMode).toBeUndefined()
    expect(flags.upstream).toBeUndefined()
  })

  it('ignores invalid framework values', () => {
    const flags = parseCliFlags(['--framework', 'invalid'])
    expect(flags.framework).toBeUndefined()
  })

  it('ignores invalid backend values', () => {
    const flags = parseCliFlags(['--backend', 'invalid'])
    expect(flags.backend).toBeUndefined()
  })

  it('ignores invalid pricing values', () => {
    const flags = parseCliFlags(['--pricing', 'invalid'])
    expect(flags.pricingMode).toBeUndefined()
  })
})
