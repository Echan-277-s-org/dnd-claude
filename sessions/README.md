# sessions/

Saved live-play sessions — one Markdown file per save (e.g. `jaycen-hawke-2026-05-25.md`).

This folder is the companion to `campaigns/`:

| Folder | Holds | Loaded as |
|--------|-------|-----------|
| `../campaigns/` | World notes / lore / setup (authored) | prior world state → `campaign.context` |
| `sessions/` *(here)* | Saved play — transcript + exact state (app-generated) | full session restore |

## What a session file is for

A session file is a **self-contained, LLM-loadable handoff**. You can:

1. **Reload it in the app** — Setup → *Load .md file* → pick a session file. If the file contains
   a ` ```session ` block, the app restores the full session (messages, party, dice, campaign);
   otherwise it falls back to loading the prose as campaign context.
2. **Continue it in any LLM with no app** — paste the matching `campaigns/<name>.md` **and** this
   session file into Claude (or any model) and keep playing. The prose is written as a Game Master
   brief: role instruction → "where we are" recap → party/scene state → full transcript.

## File format

```markdown
# Session — <Campaign> · <Scene>
<!-- saved <ISO> · genre: <id> · model: <name> · sessionId: <uuid> -->

## Continue from here
You are the Game Master. Pick up as DM from the last line below.
Pair this with the campaign notes (`campaigns/<name>.md`).

## Where we are
<short recap>

## Party
| Name | Role | HP | Turn |
| ...  | ...  | .. | ▶   |

**Pending check:** <skill DC n>   (omitted if none)

## Transcript
**You:** ...
**GM:** ...
> 🎲 d20 → 17 · Perception DC 15 → **PASS**

```session
{ "schemaVersion": 1, "sessionId": "...", "savedAt": "<ISO>",
  "campaign": { "name": "...", "genre": "...", "details": "...", "context": "...", "model": "..." },
  "messages": [ ... ], "sessionLog": [ ... ], "party": [ ... ] }
```
```

The human-readable prose above the fenced block is what an LLM reads; the trailing
` ```session ` block is the lossless machine payload the app uses to restore exact state.

> Implemented — Phase A2. Save via the 💾 button in the chat header; load via the setup screen's
> **Load .md file**. Design: `../docs/design/CROSS-DEVICE-SYNC-EVALUATION.md` §2.5.
