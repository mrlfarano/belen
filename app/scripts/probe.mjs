import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveBelenExe } from './lib/exe-path.mjs'

const exe = resolveBelenExe()
const dataDir = resolve('data')
const specPath = join(dataDir, 'probe.json')
const resultPath = join(dataDir, 'probe-result.json')

if (!existsSync(exe)) {
  console.error(`No build at ${exe}`)
  process.exit(1)
}

writeFileSync(
  specPath,
  JSON.stringify({
    kind: 'openai',
    baseUrl: process.env.MOCK_URL || 'http://127.0.0.1:8787/v1',
  }),
)
try {
  unlinkSync(resultPath)
} catch {
  /* no previous result */
}

const child = spawn(exe, ['--probe'], {
  stdio: 'ignore',
  env: { ...process.env, BELEN_DATA_DIR: dataDir },
})

const deadline = Date.now() + 30_000
const timer = setInterval(() => {
  if (existsSync(resultPath)) {
    let result
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch {
      return
    }
    clearInterval(timer)
    child.kill()

    console.log('provider probe')
    console.log('─'.repeat(52))
    console.log(`models        ${result.models.map((m) => m.id).join(', ')}`)
    console.log(`test          ${result.test.ttftMs} ms · ${JSON.stringify(result.test.text)}`)
    console.log(`stream text   ${JSON.stringify(result.text)}`)
    console.log(`events        ${result.tokenEvents} token · ${result.doneEvents} done · ${result.errorEvents} error`)
    console.log(`db            loaded=${result.db.loadedMatches} · hits=${result.db.hits} · ${result.db.exportPath}`)
    console.log(`db round-trip  ${result.db.roundTrip ? 'byte-identical' : 'MISMATCH'}`)
    console.log(
      `db 10k         ${result.db.big.blocks} blocks · save ${result.db.big.saveMs} ms · search ${result.db.big.searchMs} ms · ${result.db.big.hits} hits`,
    )
    console.log(`rate limit     ${result.rateLimit ? '429 rejects' : 'NOT REJECTED'}`)
    console.log(`malformed      ${result.malformed.tokens} tokens · ${result.malformed.done} done`)
    console.log(
      `oauth          ${result.oauth.userCode} · ${result.oauth.first} → ${result.oauth.second} · refresh ${result.oauth.refreshed} · authorized=${result.oauth.authorized}`,
    )
    console.log(`error path     ${result.errorPath ? 'rejects' : 'accepted'} (connection refused)`)

    const ok =
      result.models.length === 2 &&
      result.test.text.trim().length > 0 &&
      result.tokenEvents === 6 &&
      result.doneEvents === 1 &&
      result.errorEvents === 0 &&
      result.text.includes('mock provider streams tokens cleanly') &&
      result.errorPath === true &&
      result.rateLimit === true &&
      result.malformed.ok === true &&
      result.oauth.first === 'pending' &&
      result.oauth.second === 'ok' &&
      result.oauth.access === 'oauth-access-1' &&
      result.oauth.refreshed === 'oauth-access-2' &&
      result.oauth.authorized === true &&
      result.oauth.rejectsWithoutToken === true &&
      result.db.loadedMatches === true &&
      result.db.roundTrip === true &&
      result.db.big.roundTrip === true &&
      result.db.big.hits > 0 &&
      result.db.big.searchMs <= 30 &&
      result.db.hits === 1 &&
      existsSync(result.db.exportPath)

    console.log('─'.repeat(52))
    console.log(ok ? 'PASS' : 'FAIL')
    process.exit(ok ? 0 : 1)
  }

  if (Date.now() > deadline) {
    clearInterval(timer)
    child.kill()
    console.error('Timed out waiting for data/probe-result.json')
    process.exit(1)
  }
}, 100)
