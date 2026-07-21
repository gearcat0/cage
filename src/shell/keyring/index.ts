import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { extract } from '@noble/hashes/hkdf.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { nip44Decrypt, type Signer, type Unsealer } from '@yourproject/format'

// ── Keyring — the ONLY code that touches private key bytes (brief §2) ────────
//
// Custody: the identity is a secp256k1 private key, generated locally and stored
// ENCRYPTED AT REST via Electron `safeStorage` (OS-backed). The plaintext key is
// never written to disk, a log, or the index. It is unlocked into memory for the
// session and zeroed on lock/quit.
//
// The injected-interface rule (§2.2): `format` and the cage receive a `Signer`
// and an `Unsealer`, never key bytes. `signer.sign(...)` returns a signature;
// the Unsealer returns the symmetric content key CK. A bug in `format` or the
// cage yields a wrong result, never key exfiltration — they structurally cannot
// hold the identity key.

const IDENTITY_FILE = 'identity.key.enc'
const NOSTR_DERIVATION_MESSAGE = 'thing-nostr-derivation-v1'

// At-rest encoding scheme markers (first byte of the identity file).
const SCHEME_SAFE_STORAGE = 0x01
const SCHEME_INSECURE_FALLBACK = 0x02

// ── At-rest custody ──────────────────────────────────────────────────────────
// Production: Electron safeStorage (OS Keychain / DPAPI / libsecret). In a
// headless dev/CI container with no keyring backend, safeStorage is unavailable;
// an explicit, LOUD opt-in (SHELL_KEYRING_INSECURE_FALLBACK=1) enables a
// static-key XChaCha encoding so the tests can run. It is NOT secure — a fixed
// key means anyone with the file can decrypt it — but the plaintext key still
// never touches disk, which is the property the accommodation preserves. The
// production path REFUSES to run without safeStorage.

const FALLBACK_KEY = sha256(
  new TextEncoder().encode('thing-shell-keyring-fallback-v1-INSECURE-dev-only')
)

function fallbackEnabled(): boolean {
  return process.env.SHELL_KEYRING_INSECURE_FALLBACK === '1'
}

function encryptAtRest(plaintextHex: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    const blob = safeStorage.encryptString(plaintextHex)
    return Buffer.concat([Buffer.from([SCHEME_SAFE_STORAGE]), blob])
  }
  if (!fallbackEnabled()) {
    throw new Error(
      'safeStorage is unavailable and no key custody backend is configured. ' +
        'Refusing to persist the identity key without OS-backed encryption.'
    )
  }
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(FALLBACK_KEY, nonce).encrypt(new TextEncoder().encode(plaintextHex))
  return Buffer.concat([Buffer.from([SCHEME_INSECURE_FALLBACK]), Buffer.from(nonce), Buffer.from(ct)])
}

function decryptAtRest(file: Buffer): string {
  const scheme = file[0]
  const payload = file.subarray(1)
  if (scheme === SCHEME_SAFE_STORAGE) {
    return safeStorage.decryptString(payload)
  }
  if (scheme === SCHEME_INSECURE_FALLBACK) {
    if (!fallbackEnabled()) throw new Error('identity was stored with the insecure fallback but it is not enabled')
    const nonce = payload.subarray(0, 24)
    const ct = payload.subarray(24)
    return new TextDecoder().decode(xchacha20poly1305(FALLBACK_KEY, nonce).decrypt(ct))
  }
  throw new Error(`unknown at-rest scheme byte ${scheme}`)
}

export interface PublicIdentity {
  /** eth-eip191 signing address (20 bytes). */
  address: Uint8Array
  /** nostr x-only pubkey (32 bytes) — encryption / `ek` duty. */
  nostrPubkey: Uint8Array
}

function personalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`)
  const buf = new Uint8Array(prefix.length + message.length)
  buf.set(prefix, 0)
  buf.set(message, prefix.length)
  return keccak_256(buf)
}

function ethPersonalSign(privkey: Uint8Array, message: Uint8Array): Uint8Array {
  const digest = personalSignDigest(message)
  const recd = secp256k1.sign(digest, privkey, { prehash: false, format: 'recovered' })
  const out = new Uint8Array(65)
  out.set(recd.subarray(1, 65), 0) // @noble is rec||r||s; eth wants r||s||v
  out[64] = recd[0]! + 27
  return out
}

function ethAddress(privkey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(privkey, true)).toBytes(false)
  const addr = keccak_256(uncompressed.subarray(1))
  return addr.subarray(addr.length - 20)
}

/** Derive the Nostr/encryption key deterministically from a signed message
 *  (§6): sign a fixed domain string with the identity key, hash the signature. */
function deriveNostrKey(privkey: Uint8Array): Uint8Array {
  const sig = ethPersonalSign(privkey, new TextEncoder().encode(NOSTR_DERIVATION_MESSAGE))
  return sha256(sig)
}

/** conversation_key = HKDF-extract("nip44-v2", ecdh_x). Computed HERE, in the
 *  keyring, so `format` never sees the identity key — it only receives the
 *  derived symmetric conversation key via nip44Decrypt. */
function conversationKeyLocal(privkey: Uint8Array, xonlyPub: Uint8Array): Uint8Array {
  const pub = new Uint8Array(33)
  pub[0] = 0x02
  pub.set(xonlyPub, 1)
  const sharedX = secp256k1.getSharedSecret(privkey, pub).subarray(1)
  return extract(sha256, sharedX, new TextEncoder().encode('nip44-v2'))
}

export class Keyring {
  #privkey: Uint8Array
  #nostrPriv: Uint8Array
  readonly #address: Uint8Array
  readonly #nostrPub: Uint8Array
  #locked = false

  private constructor(privkey: Uint8Array) {
    this.#privkey = privkey
    this.#nostrPriv = deriveNostrKey(privkey)
    this.#address = ethAddress(privkey)
    this.#nostrPub = schnorr.getPublicKey(this.#nostrPriv)
  }

  /** Generate a new identity and persist it encrypted-at-rest. */
  static create(userDataDir: string): Keyring {
    const privkey = secp256k1.utils.randomSecretKey()
    const kr = new Keyring(privkey)
    kr.persist(userDataDir)
    return kr
  }

  /** Load an existing identity, or null if none exists. */
  static load(userDataDir: string): Keyring | null {
    const path = join(userDataDir, IDENTITY_FILE)
    if (!existsSync(path)) return null
    const hex = decryptAtRest(readFileSync(path))
    return new Keyring(fromHex(hex))
  }

  static loadOrCreate(userDataDir: string): Keyring {
    return Keyring.load(userDataDir) ?? Keyring.create(userDataDir)
  }

  private persist(userDataDir: string): void {
    mkdirSync(userDataDir, { recursive: true })
    // Encrypt the hex-encoded key at rest; the plaintext key bytes never touch
    // disk (safeStorage in production; a loud gated fallback in dev/CI).
    writeFileSync(join(userDataDir, IDENTITY_FILE), encryptAtRest(toHex(this.#privkey)))
  }

  get identity(): PublicIdentity {
    return { address: this.#address, nostrPubkey: this.#nostrPub }
  }

  /** The Signer handed to `format` for publishing. */
  get signer(): Signer {
    return {
      scheme: 'eth-eip191',
      pubkey: this.#address,
      sign: async (signingInput: Uint8Array) => {
        if (this.#locked) throw new Error('keyring is locked')
        return ethPersonalSign(this.#privkey, signingInput)
      }
    }
  }

  /** The Unsealer handed to `format` for reading sealed things. Returns the
   *  content key CK; the identity key stays here. */
  get unsealer(): Unsealer {
    return {
      unwrap: (epk: Uint8Array, wrap: Uint8Array): Uint8Array | null => {
        if (this.#locked) return null
        try {
          const convKey = conversationKeyLocal(this.#nostrPriv, epk)
          const ck = nip44Decrypt(wrap, convKey)
          return ck.length === 32 ? ck : null
        } catch {
          return null
        }
      }
    }
  }

  /** Zero the in-memory key material. After this, sign/unseal fail. */
  lock(): void {
    this.#privkey.fill(0)
    this.#nostrPriv.fill(0)
    this.#locked = true
  }
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export { randomBytes }
