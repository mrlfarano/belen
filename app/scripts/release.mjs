#!/usr/bin/env node
// BELEN release tooling — sign the portable exe and publish the update feed.
//
//   pnpm release init                    create the signing keypair (once)
//   pnpm release sign <BELEN.exe>        hash + sign, write latest.json
//   pnpm release publish <exe> [json]    upload both to the GitHub release
//
// The private key lives outside the repo at ~/.belen/update-private.pem
// (override with BELEN_UPDATE_KEY). The public key is committed at
// src-tauri/update.pubkey and compiled into the app. Losing the private key
// means existing installs can only be updated by hand; if it leaks, someone
// can ship malicious updates — back it up offline.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'mrlfarano/belen'
const SIGNING_PREFIX = 'BELEN-UPDATE-1'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = process.env.BELEN_UPDATE_KEY || join(homedir(), '.belen', 'update-private.pem')
const pubPath = join(appRoot, 'src-tauri', 'update.pubkey')

const usage = () => {
  console.error(`usage:
  pnpm release init                 create the signing keypair (refuses to overwrite)
  pnpm release sign <BELEN.exe>     write latest.json (--out= --notes= --url=)
  pnpm release publish <exe> [json] upload BELEN.exe + latest.json via gh`)
  process.exit(1)
}

const fail = (message) => {
  console.error(`error: ${message}`)
  process.exit(1)
}

// --- key helpers ---------------------------------------------------------

// SPKI DER wraps the 32-byte key; strip to the raw key the Rust side reads.
const rawPublicKey = (keyObject) => {
  const der = keyObject.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - 32)
}

const loadPrivateKey = () => {
  if (!existsSync(keyPath)) {
    fail(`no signing key at ${keyPath} — run "pnpm release init" first`)
  }
  return readFileSync(keyPath, 'utf8')
}

const committedPublicKeyHex = () => {
  if (!existsSync(pubPath)) {
    fail(`no public key at ${pubPath} — run "pnpm release init" first`)
  }
  return readFileSync(pubPath, 'utf8').trim()
}

// Rebuild an SPKI DER around a raw 32-byte key — mirrors how the Rust side
// turns its committed hex into something verifiable.
const spkiFromRaw = (raw) => {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  return Buffer.concat([prefix, raw])
}

// --- version helpers -----------------------------------------------------

const appVersion = () => {
  const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  const conf = JSON.parse(readFileSync(join(appRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const cargo = readFileSync(join(appRoot, 'src-tauri', 'Cargo.toml'), 'utf8')
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

  if (pkg.version !== conf.version || pkg.version !== cargoVersion) {
    fail(`versions disagree: package.json ${pkg.version}, tauri.conf.json ${conf.version}, Cargo.toml ${cargoVersion}`)
  }
  return pkg.version
}

const sha256File = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

const signedMessage = (version, sha256) =>
  Buffer.from(`${SIGNING_PREFIX}\n${version}\n${sha256}`, 'utf8')

const signMessage = (message) => {
  const privateKey = loadPrivateKey()
  const signature = cryptoSign(null, message, privateKey)

  // Belt and braces: the private key must be the committed public key's
  // other half, and the signature must verify through the exact raw-key
  // path the Rust side uses. A mismatch here means the committed key was
  // rotated without regenerating the private key.
  const derivedHex = rawPublicKey(createPublicKey(privateKey)).toString('hex')
  const committedHex = committedPublicKeyHex()
  if (derivedHex !== committedHex) {
    fail(`private key does not match ${pubPath} — refusing to sign with the wrong identity`)
  }
  const ok = cryptoVerify(null, message, createPublicKey({ key: spkiFromRaw(Buffer.from(committedHex, 'hex')), format: 'der', type: 'spki' }), signature)
  if (!ok) fail('self-verification failed — refusing to publish an unverifiable manifest')

  return signature.toString('hex')
}

// --- commands -------------------------------------------------------------

const init = () => {
  if (existsSync(keyPath)) {
    fail(`${keyPath} already exists — refusing to overwrite it`)
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawHex = rawPublicKey(publicKey).toString('hex')

  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  try {
    chmodSync(keyPath, 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }

  if (existsSync(pubPath) && readFileSync(pubPath, 'utf8').trim() !== rawHex && !flags.rotate) {
    fail(`${pubPath} already holds a different key — re-run with --rotate only if you accept that existing installs can no longer self-update`)
  }
  writeFileSync(pubPath, `${rawHex}\n`)

  console.log(`private key: ${keyPath} (never commit, back it up offline)`)
  console.log(`public key:  ${pubPath} (compiled into the app)`)
  console.log('next: rebuild BELEN so the new key is embedded, then "pnpm release sign <BELEN.exe>"')
}

const sign = () => {
  const exe = pos[0] ? resolve(pos[0]) : fail('sign needs the path to BELEN.exe')
  if (!existsSync(exe)) fail(`no such file: ${exe}`)

  const version = appVersion()
  const sha256 = sha256File(exe)
  const signature = signMessage(signedMessage(version, sha256))
  const url = flags.url || process.env.BELEN_UPDATE_URL || `https://github.com/${REPO}/releases/download/v${version}/BELEN.exe`
  const notes = flags.notes || `BELEN ${version}`
  const manifest = {
    version,
    pubDate: new Date().toISOString(),
    url,
    sha256,
    notes,
    signature,
  }

  const out = flags.out ? resolve(flags.out) : join(process.cwd(), 'latest.json')
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`version:   ${version}`)
  console.log(`sha256:    ${sha256}`)
  console.log(`manifest:  ${out}`)
  console.log(`feed url:  ${url}`)
  console.log(`next:      pnpm release publish ${exe} ${out}`)
}

const publish = () => {
  const exe = pos[0] ? resolve(pos[0]) : fail('publish needs the path to BELEN.exe')
  const manifestPath = pos[1] ? resolve(pos[1]) : join(process.cwd(), 'latest.json')
  if (!existsSync(exe)) fail(`no such file: ${exe}`)
  if (!existsSync(manifestPath)) fail(`no such file: ${manifestPath}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const tag = `v${manifest.version}`

  // GitHub asset names come from the file basename and are case-sensitive;
  // upload canonical names regardless of what the files are called locally.
  const stage = mkdtempSync(join(tmpdir(), 'belen-release-'))
  const stagedExe = join(stage, 'BELEN.exe')
  const stagedManifest = join(stage, 'latest.json')
  copyFileSync(exe, stagedExe)
  copyFileSync(manifestPath, stagedManifest)

  const gh = (args) => execFileSync('gh', args, { stdio: 'inherit' })

  try {
    let exists = true
    try {
      gh(['release', 'view', tag, '--repo', REPO])
    } catch {
      exists = false
    }

    if (exists) {
      gh(['release', 'upload', tag, '--repo', REPO, '--clobber', stagedExe, stagedManifest])
      console.log(`uploaded assets to the existing release ${tag}`)
    } else {
      gh([
        'release',
        'create',
        tag,
        '--repo',
        REPO,
        '--title',
        `BELEN ${manifest.version}`,
        '--notes',
        manifest.notes || `BELEN ${manifest.version}`,
        stagedExe,
        stagedManifest,
      ])
      console.log(`created release ${tag}`)
    }
    console.log(`feed:      https://github.com/${REPO}/releases/latest/download/latest.json`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

// --- argv -----------------------------------------------------------------

const [, , command, ...rest] = process.argv
const flags = {}
const pos = []
for (const arg of rest) {
  if (arg.startsWith('--')) {
    const name = arg.slice(2)
    const eq = name.indexOf('=')
    if (eq >= 0) flags[name.slice(0, eq)] = name.slice(eq + 1)
    else flags[name] = ''
  } else {
    pos.push(arg)
  }
}

switch (command) {
  case 'init':
    init()
    break
  case 'sign':
    sign()
    break
  case 'publish':
    publish()
    break
  default:
    usage()
}
