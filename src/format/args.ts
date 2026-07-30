import type { CborKey, CborMap, CborValue } from './cbor.js'
import { toHex } from './hash.js'

// ── args conversion: JS objects ⇄ canonical-CBOR values ──────────────────────
//
// `manifest.args` is canonical CBOR (Map-based, integers only), but the two
// places args actually live in JS are plain-object shaped: the draft a program
// emits via `emit("publish", …)` and the `getArgs().args` view a program
// renders from (context-bridged, where a Map would not survive). These two
// functions are the deliberate seam between those worlds.
//
// The conversion is REJECTING, not normalizing, in the same spirit as the
// encoder: a float or an exotic object throws with a reason instead of being
// silently rounded or stringified, so an authoring bug surfaces at sign time
// rather than shipping as mangled state.

export class ArgsError extends Error {
  override name = 'ArgsError'
}

/** Convert a JS value (JSON-ish: plain objects, arrays, strings, integers,
 *  booleans, null, plus bigint and Uint8Array) to a `CborValue` suitable for
 *  `buildBundle({ args })`. Throws `ArgsError` on floats, `-0`, and anything
 *  that is not data (functions, class instances, symbols). `undefined` maps to
 *  `null` at the top level and is skipped inside objects (JSON semantics). */
export function jsToCbor(value: unknown): CborValue {
  if (value === undefined || value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'bigint':
      return value
    case 'number':
      if (!Number.isInteger(value)) throw new ArgsError('args: non-integer number (floats are forbidden by canonical CBOR)')
      if (Object.is(value, -0)) throw new ArgsError('args: negative zero is forbidden by canonical CBOR')
      return value
    case 'object':
      break
    default:
      throw new ArgsError(`args: cannot convert value of type ${typeof value}`)
  }
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return value.map((item) => jsToCbor(item))
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) {
    throw new ArgsError('args: only plain objects can become CBOR maps')
  }
  const map: CborMap = new Map()
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue
    map.set(k, jsToCbor(v))
  }
  return map
}

function keyToString(key: CborKey): string {
  if (typeof key === 'string') return key
  if (key instanceof Uint8Array) return toHex(key)
  return String(key)
}

/** Convert a decoded `CborValue` to the plain-JS shape a thing renders from:
 *  maps become plain objects (non-string keys stringified; a post-conversion
 *  key collision throws rather than silently dropping a field), arrays
 *  recurse, scalars and Uint8Array pass through. */
export function cborToJs(value: CborValue): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of value) {
      const key = keyToString(k)
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new ArgsError(`args: duplicate key "${key}" after string conversion`)
      }
      obj[key] = cborToJs(v)
    }
    return obj
  }
  if (Array.isArray(value)) return value.map((item) => cborToJs(item))
  return value
}
