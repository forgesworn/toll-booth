// src/free-tier.ts

export interface FreeTierResult {
  allowed: boolean
  remaining: number
}

export interface IFreeTier {
  check(ip: string, cost: number): FreeTierResult
  reset(): void
}

/** Maximum number of distinct IPs tracked before new IPs are denied. */
const MAX_TRACKED_IPS = 100_000

/** Plausible IP format check to prevent arbitrary strings filling the tracking map. */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9a-fA-F:]+$/
function isPlausibleIp(value: string): boolean {
  if (!value || value.length > 45) return false
  return IPV4_RE.test(value) || IPV6_RE.test(value)
}

export class FreeTier implements IFreeTier {
  private counters = new Map<string, { count: number; date: string }>()
  private currentDate = new Date().toISOString().slice(0, 10)

  constructor(private readonly requestsPerDay: number) {
    if (!Number.isInteger(requestsPerDay) || requestsPerDay < 1) {
      throw new RangeError(`requestsPerDay must be a positive integer, got ${requestsPerDay}`)
    }
  }

  /** Reset all counters (e.g. via admin endpoint). */
  reset(): void {
    this.counters.clear()
  }

  check(ip: string, _cost?: number): FreeTierResult {
    // Reject non-IP strings to prevent arbitrary values filling the tracking map
    if (!isPlausibleIp(ip)) {
      return { allowed: false, remaining: 0 }
    }

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // Evict all stale entries when the date rolls over
    if (this.currentDate !== today) {
      this.counters.clear()
      this.currentDate = today
    }

    const entry = this.counters.get(ip)

    if (!entry || entry.date !== today) {
      // Prevent unbounded memory growth from IP-spoofed requests
      if (!entry && this.counters.size >= MAX_TRACKED_IPS) {
        return { allowed: false, remaining: 0 }
      }
      this.counters.set(ip, { count: 1, date: today })
      return { allowed: true, remaining: this.requestsPerDay - 1 }
    }

    if (entry.count >= this.requestsPerDay) {
      return { allowed: false, remaining: 0 }
    }

    entry.count++
    return { allowed: true, remaining: this.requestsPerDay - entry.count }
  }
}

export class CreditFreeTier implements IFreeTier {
  private spent = new Map<string, { amount: number; date: string }>()
  private currentDate = new Date().toISOString().slice(0, 10)

  constructor(private readonly creditsPerDay: number) {
    if (!Number.isInteger(creditsPerDay) || creditsPerDay < 1) {
      throw new RangeError(`creditsPerDay must be a positive integer, got ${creditsPerDay}`)
    }
  }

  /** Reset all counters (e.g. via admin endpoint). */
  reset(): void {
    this.spent.clear()
  }

  check(ip: string, cost: number): FreeTierResult {
    // Reject non-IP strings to prevent arbitrary values filling the tracking map
    if (!isPlausibleIp(ip)) {
      return { allowed: false, remaining: 0 }
    }

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // Evict all stale entries when the date rolls over
    if (this.currentDate !== today) {
      this.spent.clear()
      this.currentDate = today
    }

    const entry = this.spent.get(ip)
    const currentSpent = (entry && entry.date === today) ? entry.amount : 0

    // Zero-cost requests always pass without consuming budget
    if (cost === 0) {
      return { allowed: true, remaining: this.creditsPerDay - currentSpent }
    }

    const remaining = this.creditsPerDay - currentSpent

    if (cost > remaining) {
      return { allowed: false, remaining }
    }

    // Prevent unbounded memory growth from IP-spoofed requests
    if (!entry && this.spent.size >= MAX_TRACKED_IPS) {
      return { allowed: false, remaining: 0 }
    }

    const newSpent = currentSpent + cost
    this.spent.set(ip, { amount: newSpent, date: today })
    return { allowed: true, remaining: this.creditsPerDay - newSpent }
  }

  /** Refund credits back to an IP's daily budget (clamped — cannot exceed daily budget). */
  refund(ip: string, amount: number): void {
    const today = new Date().toISOString().slice(0, 10)
    const entry = this.spent.get(ip)
    if (!entry || entry.date !== today) return

    entry.amount = Math.max(0, entry.amount - amount)
  }
}
