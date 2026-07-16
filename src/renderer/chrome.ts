// The host chrome strip. This is TRUSTED shell UI, rendered in its own native
// view above the cage. It will eventually show signer identity and verification
// status; for phase 1 it shows the thing's id and content hash next to a static
// "UNSIGNED — test harness" badge.
//
// Main injects the values by calling window.__setInfo(...) after the cage loads.

interface ThingInfo {
  id: string
  hash: string
}

declare global {
  interface Window {
    __setInfo?: (info: ThingInfo) => void
  }
}

window.__setInfo = (info: ThingInfo): void => {
  const id = document.getElementById('thing-id')
  const hash = document.getElementById('thing-hash')
  if (id) id.textContent = info.id.slice(0, 8)
  if (hash) hash.textContent = info.hash
}

export {}
