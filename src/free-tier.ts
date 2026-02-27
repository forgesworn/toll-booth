// src/free-tier.ts

export interface FreeTierResult {
  allowed: boolean
  remaining: number
}

export class FreeTier {
  private counters = new Map<string, { count: number; date: string }>()
  private currentDate = new Date().toISOString().slice(0, 10)

  constructor(private readonly requestsPerDay: number) {
    if (!Number.isInteger(requestsPerDay) || requestsPerDay < 1) {
      throw new RangeError(`requestsPerDay must be a positive integer, got ${requestsPerDay}`)
    }
  }

  check(ip: string): FreeTierResult {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // Evict all stale entries when the date rolls over
    if (this.currentDate !== today) {
      this.counters.clear()
      this.currentDate = today
    }

    const entry = this.counters.get(ip)

    if (!entry || entry.date !== today) {
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
