# Multiplayer V1 — Test Results

> Snapshot of `npm test -- --run` (Vitest) after the Multiplayer V1 merge.

- **Date:** 2026-05-26
- **Branch:** `master` (merge commit `8c30a39` — `feature/multiplayer` Phases 0–7)
- **Command:** `npm test -- --run`
- **Runner:** Vitest v4.1.7 (jsdom + one node-env server suite)

## Summary

```
 Test Files  16 passed (16)
      Tests  405 passed | 2 skipped (407)
   Duration  ~4.4s
```

- **405 passed**, **0 failed**, **2 skipped** — zero regressions vs the 274-test pre-multiplayer baseline (+131 multiplayer tests).
- The **2 skips** are the non-gate `useWebSocket — M7 gate on session:update path` placeholder describe (empty routing stubs). Its real coverage lives in `src/hooks/useSessionPersistence.test.jsx` (the dual-authority / M7 gate is exercised there). No Phase 0–7 gate is skipped.

## Test files (16)

| File | Environment |
|------|-------------|
| `server/sync-server.test.mjs` | node |
| `server/sync-server.multiplayer.test.mjs` | node |
| `src/App.test.jsx` | jsdom |
| `src/components/CharacterPanel.test.jsx` | jsdom |
| `src/components/Chat.test.jsx` | jsdom |
| `src/components/DiceChip.test.jsx` | jsdom |
| `src/components/HistoryPanel.test.jsx` | jsdom |
| `src/components/PartyStrip.test.jsx` | jsdom |
| `src/hooks/useSessionPersistence.test.jsx` | jsdom |
| `src/hooks/useWebSocket.test.js` | jsdom |
| `src/lib/context.test.js` | jsdom |
| `src/lib/loadParty.test.js` | jsdom |
| `src/lib/parser.test.js` | jsdom |
| `src/lib/session.multiplayer.test.js` | jsdom |
| `src/lib/session.test.js` | jsdom |
| `src/lib/turnStateMachine.test.js` | jsdom |

## Coverage by phase (multiplayer)

- **P0** schema v2 / `applyPartyUpdate` — `src/lib/session.multiplayer.test.js`
- **P1** WS transport / `useWebSocket` — `server/sync-server.multiplayer.test.mjs`, `src/hooks/useWebSocket.test.js`
- **P2** server-authoritative state + dual-authority adopt — `server/sync-server.multiplayer.test.mjs`, `src/hooks/useSessionPersistence.test.jsx`
- **P3** server-side Ollama DM proxy (mock Ollama) — `server/sync-server.multiplayer.test.mjs`
- **P4** free-roam multi-client + MC-9 latency smoke + XSS guard — `server/sync-server.multiplayer.test.mjs`, `src/components/Chat.test.jsx`
- **P5** combat enforcement / `phaseReducer` — `src/lib/turnStateMachine.test.js`, `server/sync-server.multiplayer.test.mjs`, `PartyStrip.test.jsx`, `HistoryPanel.test.jsx`
- **P6** presence / disconnect / rejoin / GC — `server/sync-server.multiplayer.test.mjs`
- **P7** HTTP PUT v2 round-trip / v1↔v2 compat / 409 LWW / M7 stale-block — `server/sync-server.multiplayer.test.mjs`, `src/hooks/useSessionPersistence.test.jsx`

> Note: the server module also boots cleanly under raw Node ESM
> (`node --input-type=module -e "import('./server/sync-server.mjs')"` → OK).
