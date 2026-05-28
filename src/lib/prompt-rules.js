// Shared prompt-rule strings used by both genre engines (context.js, context.starwars.js).
// Lifted here so a rule refinement edits one place and the two engines can't drift.
// Only the truly genre-neutral text is shared; the no-self-roll bullet still keeps its
// genre-specific opener inline (D&D mentions checks/saves; Star Wars adds attack vs Reflex
// Defense), and continues with NO_SELF_ROLL_TAIL.

export const NO_SELF_ROLL_TAIL = `then leave the outcome open for the player to roll — do not resolve it yourself. You NEVER roll dice or state a die result; the PLAYER rolls every die. Do not narrate success or failure (and do not roll initiative or any other die) until the player reports their number on a later turn; only then do you narrate the result. Calling for a check is not resolving it. (You still append the required blocks as normal — the \`party\` block on every response, and the \`check\` block when you call for a roll.)`

export const DC_BAND_RULE = `Difficulty Classes (DC) follow 5e: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30. Default routine actions to DC 10–15: a typical lock, sneaking past distracted guards, persuading a wary NPC, searching a room, or climbing a rough wall are all DC 15 (or DC 10 if conditions favor the character) — NOT 17, 18, or 20. Reserve DC 20+ ONLY for genuinely difficult feats (scaling a sheer wet cliff, swaying a hostile zealot). If you are unsure, use 15. Do not set DC 16–19 for ordinary tasks; round down to 15.`

export const VERDICT_CRITICAL_CLAUSE = `CRITICAL: emit a \`verdict\` block ONLY when the player's most recent message literally contains a rolled number (a dice-roll line such as "d20 → 14" or "I rolled 12"). If the player only described an action and reported NO number, you must NOT invent or assume a roll and must NOT emit a \`verdict\` — instead call for the check (the \`check\` block) and let them roll. The \`roll\` value must always be a number the player gave you, never one you chose.`

export const REMINDER_FOOTER = `REMINDER — before you finish: your response is INVALID unless it includes the \`party\` block — a \`\`\`party fenced block listing EVERY party member with name, role, hpPct, isActive. Append it now, after the prose, even if nothing changed, and even if you are also emitting a \`check\` or \`verdict\` block. The \`party\` block is MANDATORY on EVERY turn, no exceptions — never end a response without it.`
