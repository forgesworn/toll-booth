// src/free-tier.ts

export interface FreeTierResult {
  allowed: boolean
  remaining: number
}

export class FreeTier {
  private counters = new Map<string, { count: number; date: string }>()

  constructor(private readonly requestsPerDay: number) {}

  check(ip: string): FreeTierResult {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
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
