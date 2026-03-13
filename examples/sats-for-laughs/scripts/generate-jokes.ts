import OpenAI from 'openai'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const JOKES_PATH = resolve(__dirname, '..', 'jokes.json')

const TOPICS = ['bitcoin', 'lightning', 'nostr', 'freedom tech', 'meshtastic', 'Handshake (HNS)'] as const
const JOKES_PER_TOPIC = 200
const BATCH_SIZE = 20

interface Joke {
  setup: string
  punchline: string
  topic: string
}

const client = new OpenAI()

async function generateBatch(topic: string, count: number): Promise<Joke[]> {
  const topicLabel = topic === 'Handshake (HNS)'
    ? 'the Handshake naming protocol (HNS) - a decentralised DNS alternative'
    : topic

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 1.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a comedy writer specialising in tech humour. Generate original, clever jokes about ${topicLabel}. Each joke has a "setup" and "punchline". Vary the style: puns, one-liners, observational, dad jokes. Avoid repetitive structures. Return JSON: { "jokes": [{ "setup": "...", "punchline": "..." }] }`,
      },
      {
        role: 'user',
        content: `Generate ${count} unique jokes about ${topicLabel}. Make them genuinely funny, not just "Why did the X cross the road?" templates.`,
      },
    ],
  })

  const content = response.choices[0]?.message.content
  if (!content) return []

  try {
    const parsed = JSON.parse(content) as { jokes: { setup: string; punchline: string }[] }
    return parsed.jokes
      .filter((j) => j.setup && j.punchline)
      .map((j) => ({
        setup: j.setup,
        punchline: j.punchline,
        topic: topic.toLowerCase().replace(/\s*\(hns\)/i, ''),
      }))
  } catch {
    console.error(`  Failed to parse response for ${topic}`)
    return []
  }
}

function deduplicate(jokes: Joke[]): Joke[] {
  const seen = new Set<string>()
  return jokes.filter((joke) => {
    const key = joke.setup.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function main() {
  let allJokes: Joke[] = []
  if (existsSync(JOKES_PATH)) {
    const existing = JSON.parse(readFileSync(JOKES_PATH, 'utf-8')) as Joke[]
    allJokes = existing
    console.log(`Loaded ${existing.length} existing jokes`)
  }

  for (const topic of TOPICS) {
    const topicKey = topic.toLowerCase().replace(/\s*\(hns\)/i, '')
    const existingCount = allJokes.filter((j) => j.topic === topicKey).length
    const remaining = JOKES_PER_TOPIC - existingCount
    if (remaining <= 0) {
      console.log(`${topic}: already have ${existingCount} jokes, skipping`)
      continue
    }

    console.log(`${topic}: generating ${remaining} jokes (have ${existingCount})...`)

    const batches = Math.ceil(remaining / BATCH_SIZE)
    for (let i = 0; i < batches; i++) {
      const count = Math.min(BATCH_SIZE, remaining - i * BATCH_SIZE)
      console.log(`  batch ${i + 1}/${batches} (${count} jokes)...`)
      const jokes = await generateBatch(topic, count)
      allJokes.push(...jokes)

      if (i < batches - 1) await new Promise((r) => setTimeout(r, 500))
    }
  }

  const deduped = deduplicate(allJokes)
  console.log(`\nTotal: ${allJokes.length} raw, ${deduped.length} after deduplication`)

  writeFileSync(JOKES_PATH, JSON.stringify(deduped, null, 2) + '\n')
  console.log(`Written to ${JOKES_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
