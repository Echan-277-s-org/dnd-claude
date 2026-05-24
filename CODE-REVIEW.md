# dnd-claude Code Review

**Reviewed:** 2026-05-23  
**Scope:** Full codebase (no git history — all source files reviewed)  
**Effort:** High (3 angles × 6 candidates → 1-vote verify)

---

## Findings (ranked by severity)

### 1. HIGH — Error messages sent to API as valid assistant turns
**File:** `src/components/Chat.jsx:74`

`apiMessages` filters out `role === 'dice'` messages but does NOT filter out messages where `error: true`. After an API failure, the error assistant turn (`role: 'assistant', error: true`) is included in the conversation history sent on the next request.

**Fix:** Change the filter:
```js
// before
const apiMessages = [...messages.filter(m => m.role !== 'dice'), userMsg]

// after
const apiMessages = [...messages.filter(m => m.role !== 'dice' && !m.error), userMsg]
```

---

### 2. MEDIUM — No AbortController / no unmount cleanup on streaming fetch
**File:** `src/components/Chat.jsx:103`

No `AbortController` is passed to `fetch()`, and no `useEffect` cleanup cancels the stream reader on unmount. If the user clicks the gear icon (onReset) mid-stream, the component unmounts but the `while (true)` reader loop continues calling `setMessages` on the destroyed component.

**Fix:** Create an `AbortController` ref, pass `signal` to `fetch()`, and cancel it in a `useEffect` cleanup or at the start of `sendMessage` if a previous call is in-flight.

---

### 3. MEDIUM — `handleReset()` leaves campaign data in localStorage
**File:** `src/App.jsx:22`

`handleReset()` only removes `dnd_api_key`. The keys `dnd_campaign_name`, `dnd_campaign_details`, and `dnd_model` persist in localStorage. On the next load after a reset, old campaign details silently re-populate.

**Fix:**
```js
function handleReset() {
  localStorage.removeItem('dnd_api_key')
  localStorage.removeItem('dnd_campaign_name')
  localStorage.removeItem('dnd_campaign_details')
  localStorage.removeItem('dnd_model')
  setApiKey('')
}
```

---

### 4. LOW — Raw Anthropic API error body displayed in chat UI
**File:** `src/components/Chat.jsx:100`

The full raw API response body is thrown as an `Error` and then rendered verbatim in the chat bubble via `err.message`. API errors can contain quota metadata, internal error codes, and account details the user shouldn't see unfiltered.

**Fix:** Parse the error body and surface only a user-friendly message, or at minimum truncate it.

---

### 5. LOW — `response.body` null check missing
**File:** `src/components/Chat.jsx:103`

`response.body.getReader()` is called without checking if `response.body` is null. Per the Fetch spec, `response.body` can be null (certain proxied/redirected responses). This throws a `TypeError` caught by the outer catch, leaving an empty assistant bubble with no explanation.

**Fix:**
```js
if (!response.body) throw new Error('No response body received from API')
const reader = response.body.getReader()
```

---

### 6. LOW — Model ID read from localStorage without allowlist validation
**File:** `src/App.jsx:10`

The `model` value is read from localStorage and passed directly to the Anthropic API with no validation. A tampered value (DevTools, browser extension) causes a silent 400 with no specific UI feedback.

**Fix:** Validate against an allowlist before use:
```js
const VALID_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7']
const storedModel = localStorage.getItem('dnd_model')
model: VALID_MODELS.includes(storedModel) ? storedModel : 'claude-sonnet-4-6'
```

---

## Status

- [ ] Fix #1 — Error messages filtered from API history (`Chat.jsx:74`)
- [ ] Fix #2 — AbortController + unmount cleanup (`Chat.jsx:103`)
- [ ] Fix #3 — handleReset clears all campaign localStorage keys (`App.jsx:22`)
- [ ] Fix #4 — Sanitize API error body before display (`Chat.jsx:100`)
- [ ] Fix #5 — Null check on `response.body` (`Chat.jsx:103`)
- [ ] Fix #6 — Model ID allowlist validation (`App.jsx:10`)
