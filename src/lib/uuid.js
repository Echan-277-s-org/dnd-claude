// crypto.randomUUID() is only exposed in secure contexts (https + localhost).
// When the app is served over plain http to a LAN / Tailscale IP (the documented
// cross-device-play setup, see CLAUDE.md "Cross-device / LAN play"), `crypto`
// exists but `crypto.randomUUID` is undefined and any call throws synchronously —
// crashing App's first useState and leaving the page blank. crypto.getRandomValues
// IS available in insecure contexts, so the fallback builds an RFC 4122 v4 UUID
// from 16 random bytes (version + variant bits patched per the spec).
export function randomUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
