import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(new URL('../deploy/production-jokes.sh', import.meta.url))
const source = readFileSync(scriptPath, 'utf8')

describe('production Jokes deployment', () => {
  it('has valid Bash syntax', () => {
    expect(spawnSync('bash', ['-n', scriptPath]).status).toBe(0)
  })

  it('fails before side effects for an invalid release reference', () => {
    const result = spawnSync(scriptPath, [], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_REF: 'main', CONFIG_FILE: '/nonexistent' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Refusing invalid DEPLOY_REF')
  })

  it('pins deployment and records proof without a credential fallback', () => {
    expect(source).toContain('refs/tags/$DEPLOY_REF^{commit}')
    expect(source).toContain('worktree add --detach')
    expect(source).toContain('if [[ ! -d "$RUNTIME_DIR/data" ]]')
    expect(source).toContain('--env-file')
    expect(source).toContain('deployed-commit')
    expect(source).toContain('rollback')
    expect(source).toContain('http-password-limited-access')
    expect(source).toContain('refusing identity replacement')
    expect(source).not.toMatch(/s\/\^http-password=\/\/p/)
    expect(source).not.toContain('origin/main')
    expect(source).not.toMatch(/\|\|\s*echo\s+[0-9a-f]{32,}/)
  })
})
