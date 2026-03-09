import type { Context } from 'hono'

export function getTrustedClientIp(c: Context, trustProxy: boolean): string | null {
  if (!trustProxy) return null

  const forwardedFor = c.req.header('X-Forwarded-For')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }

  const realIp = c.req.header('X-Real-IP')?.trim()
  return realIp || null
}
