import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const exe =
  process.env.BELEN_EXE ||
  join(process.env.USERPROFILE, '.belen-target', 'release', 'belen.exe')
const key = process.env.BELEN_LIVE_KEY

if (!key) {
  console.error('Set BELEN_LIVE_KEY to run the live provider probe.')
  process.exit(1)
}
if (!existsSync(exe)) {
  console.error(`No build at ${exe}`)
  process.exit(1)
}

const dataDir = resolve('data')
const specPath = join(dataDir, 'probe.json')
const resultPath = join(dataDir, 'probe-result.json')

writeFileSync(
  specPath,
  JSON.stringify({
    mode: 'live',
    kind: 'openai',
    baseUrl: process.env.BELEN_LIVE_URL || 'https://api.z.ai/api/paas/v4',
    apiKey: key,
    model: process.env.BELEN_LIVE_MODEL || 'glm-5.3',
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

const deadline = Date.now() + 120_000
const timer = setInterval(() => {
  if (!existsSync(resultPath)) {
    if (Date.now() > deadline) {
      clearInterval(timer)
      child.kill()
      try {
        unlinkSync(specPath)
      } catch {
        /* ignore */
      }
      console.error('Timed out waiting for data/probe-result.json')
      process.exit(1)
    }
    return
  }

  let result
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    return
  }

  clearInterval(timer)
  child.kill()
  try {
    // Never leave the key on disk after the test.
    unlinkSync(specPath)
  } catch {
    /* ignore */
  }

  console.log('LIVE PROVIDER PROBE')
  console.log('─'.repeat(56))
  console.log(
    `models        ${
      result.models.length
        ? `${result.models.length}: ${result.models.join(', ')}`
        : `discovery failed — ${result.discoverError}`
    }`,
  )
  console.log(`model         ${result.model}`)
  console.log(`test          ${result.test.ttftMs} ms · ${JSON.stringify(result.test.text)}`)
  console.log(`stream        ${JSON.stringify(result.text.slice(0, 240))}`)
  console.log(
    `events        ${result.tokenEvents} token · ${result.doneEvents} done · ${result.errorEvents} error`,
  )
  console.log(
    `saved         config=${result.saved.configOk} · key=${result.saved.keyOk} · live=${result.saved.ttftMs} ms`,
  )
  console.log('─'.repeat(56))

  const ok =
    result.test.text.trim().length > 0 &&
    result.tokenEvents > 0 &&
    result.errorEvents === 0 &&
    result.doneEvents === 1 &&
    result.saved.configOk === true &&
    result.saved.keyOk === true &&
    result.saved.testOk === true

  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}, 200)
