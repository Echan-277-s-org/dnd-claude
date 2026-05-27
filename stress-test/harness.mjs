/**
 * stress-test/harness.mjs
 * D&D Campaign Assistant — Long-Session Stress-Test Harness
 *
 * Implements PROTOCOL.md exactly.
 * Core logic (buildSystemPrompt, extractEntities, trimContext) is NO LONGER a
 * copied port — it is imported directly from the SAME shared module the live
 * app uses (../src/lib/context.js). This guarantees the harness measures the
 * exact behavior shipped in Chat.jsx, eliminating drift permanently.
 *
 * NOTES:
 *  1. No React state — raw message arrays managed imperatively.
 *  2. fetch() uses Node 18+ built-in (no window.location.hostname needed).
 *  3. Stream reading: Node ReadableStream via response.body.getReader() works
 *     identically to browser; TextDecoder available globally in Node 18+.
 *  4. num_predict: 400 (spec §6) vs prod 900 — deviation logged in output header.
 *  5. dice entries stored as {role:'dice', die, result}; mapped before API call.
 *  6. CPU offload check via `ollama ps` shell command (execa-free: uses child_process).
 */

import { execSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { appendFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildSystemPrompt, extractEntities, trimContext } from '../src/lib/context.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'qwen2.5:14b';
const STRESS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));

const CAMPAIGN = {
  name: 'The Shattered Vale',
  details: 'A dark fantasy campaign set in a crumbling empire. The party seeks the lost Sunstone artifact.',
  model: MODEL,
};

// Options per spec §1 — num_predict 400 (deviation from prod 900 logged in header)
const BASE_OPTIONS = {
  num_predict: 400,
  temperature: 0.8,
  top_p: 0.9,
  top_k: 40,
  repeat_penalty: 1.15,
  repeat_last_n: 256,
};

// buildSystemPrompt, extractEntities, trimContext are imported from
// ../src/lib/context.js (the SAME module Chat.jsx uses) — no local copy.

// ─── 60-turn script per PROTOCOL.md §3 ───────────────────────────────────────

// Entry types:
//   { type:'user', text }     — normal player turn
//   { type:'dice', die, result } — dice roll (stored as role:'dice')
//   { type:'probe', probe_id, text, anchors } — probe turn (real message slot)

const SCRIPT = [
  // T01
  { type:'user', text:"Begin the adventure — we arrive in Ravenmoor and make for The Broken Lantern tavern. Set the scene." },
  // T02
  { type:'user', text:"We approach the village elder, Elder Sorcha, and ask her about the Sunstone. What does Sorcha tell us? (Use the name Elder Sorcha for her.)" },
  // T03
  { type:'user', text:"We head to the town blacksmith, Garret Ironhand, at his shop the Forge of Embers. What does Garret tell us about the road ahead? (Use the names Garret Ironhand and the Forge of Embers.)" },
  // T04
  { type:'user', text:"We ask the blacksmith to inspect our weapons and tell us if they need repair." },
  // T05
  { type:'user', text:"We go to the East Gate barracks and speak with the guard captain in charge, Captain Vell. What does Captain Vell tell us? (Use the names Captain Vell and the East Gate barracks.)" },
  // T06
  { type:'user', text:"We ask the captain if there has been any unusual activity on the road to the Shattered Vale." },
  // T07
  { type:'user', text:"We seek out the informant Mira the Fence and pay her 12 gold pieces for what she knows about the rival faction, the Ash Covenant. What does Mira reveal? (Use the names Mira, 12 gold pieces, and the Ash Covenant.)" },
  // T08
  { type:'user', text:"We pay Mira and listen carefully to everything she tells us." },
  // T09
  { type:'user', text:"We follow Mira's directions and find the cracked fountain she described. What do we see there?" },
  // T10
  { type:'user', text:"We examine the passage entrance. What dangers are apparent?" },
  // T11
  { type:'user', text:"We prepare our gear and descend into the passage." },
  // T12 - dice
  { type:'dice', die:'d20', result:14 },
  // T13
  { type:'user', text:"We move carefully, taking whatever path seems safest." },
  // T14
  { type:'user', text:"We encounter a locked iron door. We check for traps first." },
  // T15 - dice
  { type:'dice', die:'d20', result:8 },
  // T16
  { type:'user', text:"We try to pick the lock." },
  // T17 - dice
  { type:'dice', die:'d20', result:19 },
  // T18
  { type:'user', text:"We push through and continue deeper." },
  // T19
  { type:'user', text:"What do we hear echoing from below?" },
  // T20
  { type:'user', text:"We hold still and listen." },
  // T21 - PROBE-1
  { type:'probe', probe_id:'P1', text:"Out of character: without looking back, tell me the name of the blacksmith we visited at the start of the session, the name of his shop, and the price we paid Mira for information.",
    anchors:[
      { id:'B1', expected:'Garret', category:'B' },
      { id:'B2', expected:'Forge of Embers', category:'B' },
      { id:'B5', expected:'12 gold', category:'B' },
    ]
  },
  // T22
  { type:'user', text:"Back in character. We descend toward the sound." },
  // T23
  { type:'user', text:"We find a large underground chamber. What does it look like?" },
  // T24
  { type:'user', text:"We search the chamber for any exits or points of interest." },
  // T25 - dice
  { type:'dice', die:'d20', result:11 },
  // T26
  { type:'user', text:"We investigate the eastern wall more closely." },
  // T27
  { type:'user', text:"We find markings on the wall. What do they say?" },
  // T28
  { type:'user', text:"We record the markings and continue through the northern passage." },
  // T29
  { type:'user', text:"We hear movement ahead. We prepare for combat." },
  // T30 - dice
  { type:'dice', die:'d20', result:17 },
  // T31 - PROBE-2
  { type:'probe', probe_id:'P2', text:"Out of character: who sent us on this quest, what is the artifact we are looking for, and what faction did Mira warn us about?",
    anchors:[
      { id:'A3', expected:'Sorcha', category:'A' },
      { id:'A4', expected:'Sunstone', category:'A' },
      { id:'B8', expected:'Ash Covenant', category:'B' },
    ]
  },
  // T32
  { type:'user', text:"Back in character. We engage whatever is ahead." },
  // T33 - dice
  { type:'dice', die:'d20', result:3 },
  // T34
  { type:'user', text:"We fall back and take cover behind the nearest pillar." },
  // T35 - dice
  { type:'dice', die:'d20', result:16 },
  // T36
  { type:'user', text:"We strike when the moment is right." },
  // T37 - dice
  { type:'dice', die:'d20', result:20 },
  // T38
  { type:'user', text:"We loot anything useful from the fallen enemy." },
  // T39
  { type:'user', text:"We tend our wounds and rest for a short time." },
  // T40
  { type:'user', text:"We continue deeper. What is the next obstacle?" },
  // T41 - PROBE-3
  { type:'probe', probe_id:'P3', text:"Out of character: what was the name of the town we started in, and what was the name of the guard captain at the East Gate?",
    anchors:[
      { id:'A1', expected:'Ravenmoor', category:'A' },
      { id:'B3', expected:'Vell', category:'B' },
    ]
  },
  // T42
  { type:'user', text:"Back in character. We press forward and reach what appears to be the entrance to the main dungeon complex. Describe what we see." },
  // T43
  { type:'user', text:"We study the Weeping Arch carefully before passing through." },
  // T44
  { type:'user', text:"We step through and carefully check the floor ahead for a pressure-plate trap before walking." },
  // T45 - dice
  { type:'dice', die:'d20', result:9 },
  // T46
  { type:'user', text:"We trigger something. What happens?" },
  // T47
  { type:'user', text:"We recover and press on, more cautiously now." },
  // T48
  { type:'user', text:"We reach a large hall guarded by a stone golem. Describe the stone golem." },
  // T49
  { type:'user', text:"We attempt to communicate with the creature before attacking." },
  // T50 - dice
  { type:'dice', die:'d20', result:13 },
  // T51 - PROBE-4
  { type:'probe', probe_id:'P4', text:"Out of character: describe the landmark we passed through to enter this dungeon complex, the trap we encountered just inside, and the type of creature guarding the main hall.",
    anchors:[
      { id:'C1', expected:'Weeping Arch', category:'C' },
      { id:'C2', expected:'pressure', category:'C' },
      { id:'C3', expected:'golem', category:'C' },
    ]
  },
  // T52
  { type:'user', text:"Back in character. We search the hall and recover the artifact resting on the altar — the Shard of Dawn. Describe what we find. (Use the name the Shard of Dawn.)" },
  // T53
  { type:'user', text:"We examine the item closely. What are its properties?" },
  // T54
  { type:'user', text:"We take the item and look for an exit." },
  // T55 - dice
  { type:'dice', die:'d20', result:7 },
  // T56
  { type:'user', text:"The exit appears guarded. We try to sneak past." },
  // T57 - dice
  { type:'dice', die:'d20', result:15 },
  // T58
  { type:'user', text:"We make it through and climb back toward daylight." },
  // T59
  { type:'user', text:"We emerge near the cracked fountain. What do we see waiting for us?" },
  // T60 - PROBE-5
  { type:'probe', probe_id:'P5', text:"Out of character: final continuity check. Name the town we started in, the artifact we recovered, the faction that opposes us, the informant who helped us, and the price she charged.",
    anchors:[
      { id:'A1', expected:'Ravenmoor', category:'A' },
      { id:'C4', expected:'Shard of Dawn', category:'C' },
      { id:'B8', expected:'Ash Covenant', category:'B' },
      { id:'B6', expected:'Mira', category:'B' },
      { id:'B5', expected:'12 gold', category:'B' },
    ]
  },
];

// Smoke subset per PROTOCOL.md §6:
// T01,T02,T03,T05,T07,T09, then PROBE-1 text as smoke-turn 12, then T10–T17
// Map to 0-based SCRIPT indices: T01=0,T02=1,T03=2,T05=4,T07=6,T09=8 → smoke1..6
// then probe-1 slot index=20 as smoke-turn 12
// then T10-T17 = indices 9..16
const SMOKE_INDICES = [0, 1, 2, 4, 6, 8, 20, 9, 10, 11, 12, 13, 14, 15, 16];

// ─── Streaming fetch — mirrors sendMessage from Chat.jsx ─────────────────────

async function callOllama(apiMessages, options, turnNum) {
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    messages: apiMessages,
    options,
  });

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Ollama ${response.status}: ${errBody}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let evalCount = 0;
  let evalDuration = 0;
  let totalDuration = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const delta = event.message?.content;
        if (delta) fullText += delta;
        if (event.done) {
          evalCount = event.eval_count ?? 0;
          evalDuration = event.eval_duration ?? 0;
          totalDuration = event.total_duration ?? 0;
        }
      } catch {
        // incomplete JSON chunk — skip (same as Chat.jsx)
      }
    }
  }

  return { fullText, evalCount, evalDuration, totalDuration };
}

// ─── Ollama ps parser ─────────────────────────────────────────────────────────

function getOllamaPs() {
  try {
    const out = execSync('ollama ps', { encoding: 'utf8', timeout: 10000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return { processor: 'none', context: '' };
    // Header: NAME  ID  SIZE  PROCESSOR  CONTEXT  UNTIL
    const dataLine = lines[1];
    if (!dataLine || !dataLine.trim()) return { processor: 'none', context: '' };
    // Parse: split by 2+ spaces
    const parts = dataLine.split(/\s{2,}/);
    // parts: [NAME, ID, SIZE, PROCESSOR, CONTEXT, UNTIL]
    const processor = parts[3] || '';
    const context = parts[4] || '';
    return { processor: processor.trim(), context: context.trim() };
  } catch {
    return { processor: 'error', context: '' };
  }
}

// ─── Percentile helper ────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// ─── Main run function ────────────────────────────────────────────────────────

async function runHarness({ mode, num_ctx, run_id, smokeOnly = false }) {
  const jsonlPath = path.join(STRESS_DIR, `stress-test-${run_id}.jsonl`);
  const summaryPath = path.join(STRESS_DIR, `stress-test-summary-${run_id}.json`);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`STRESS-TEST HARNESS — ${run_id}`);
  console.log(`Mode: ${mode}  num_ctx: ${num_ctx}  num_predict: ${BASE_OPTIONS.num_predict}`);
  console.log(`DEVIATION: num_predict=400 (prod=900) — intentional per PROTOCOL §6`);
  console.log(`Output: ${jsonlPath}`);
  console.log(`${'='.repeat(70)}\n`);

  const options = { ...BASE_OPTIONS, num_ctx };

  // Raw message log (same as Chat.jsx `messages` state)
  let messages = [];

  // Accumulated per-turn stats for non-probe turns
  const tokensPerSecSamples = [];

  // Probe results
  const probeResults = {};

  // Contradiction log
  const contradictions = [];

  // CPU offload tracking
  let cpuOffloadDetected = false;
  let cpuOffloadFirstTurn = null;
  let baselineProcessor = null;

  // Drift onset tracking
  let driftOnset = null;
  const anchorFirstFail = {};

  // Category tracking
  const categoryPassed = { A:0, B:0, C:0 };
  const categoryTotal = { A:0, B:0, C:0 };

  // Trim boundary log — which message indices get dropped when trim kicks in
  const trimBoundaryLog = [];

  const wallStart = Date.now();

  // Determine which script entries to run
  let scriptEntries;
  if (mode === 'smoke') {
    scriptEntries = SMOKE_INDICES.map((i, pos) => ({ scriptIdx: i, smokePos: pos + 1, entry: SCRIPT[i] }));
  } else {
    scriptEntries = SCRIPT.map((entry, i) => ({ scriptIdx: i, smokePos: null, entry }));
  }

  let turnCounter = 0; // counts real message turns (including probes, excluding dice-only)

  for (let pos = 0; pos < scriptEntries.length; pos++) {
    const { scriptIdx, smokePos, entry } = scriptEntries[pos];
    const displayTurn = mode === 'smoke' ? (smokePos ?? pos + 1) : (scriptIdx + 1);

    // ── Dice turns: inject directly into message log, no API call ─────────
    if (entry.type === 'dice') {
      messages.push({ role: 'dice', die: entry.die, result: entry.result });
      console.log(`  T${String(displayTurn).padStart(2,'0')} [DICE] ${entry.die} → ${entry.result}`);
      continue;
    }

    turnCounter++;

    // ── Build API messages array (mirrors sendMessage exactly) ─────────────

    // 1. Map dice entries in place
    const mappedMessages = messages.map(m =>
      m.role === 'dice'
        ? { role: 'user', content: `[Dice roll: ${m.die} → ${m.result}]` }
        : m
    );

    // 2. Add current user message
    const userMsg = { role: 'user', content: entry.text };
    const fullForTrim = [...mappedMessages, userMsg];

    // 3. Log trim boundary (token-budget window; actual tail size determined by
    //    trimContext internally from numCtx and systemContent reserve).
    const preTrimLen = fullForTrim.length;
    trimBoundaryLog.push({
      turn: displayTurn,
      total_before_trim: preTrimLen,
    });

    // 4. Apply trimContext with per-run num_ctx so the harness exercises the same
    //    token-budget window as the live app (pinned=8, reserve dynamic from systemContent).
    const trimmedApiMessages = trimContext(fullForTrim, { numCtx: num_ctx });

    // 5. Extract entities from the PRE-TRIM full raw message log (not mappedMessages).
    //    Default max=50 — same as Chat.jsx call site.
    const entities = extractEntities(messages);
    const systemPromptBase = buildSystemPrompt(CAMPAIGN);
    const systemContent = entities.length
      ? `${systemPromptBase}\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): ${entities.join(', ')}.`
      : systemPromptBase;

    // 6. Final API messages
    const finalApiMessages = [
      { role: 'system', content: systemContent },
      ...trimmedApiMessages,
    ];

    const entityDigestString = entities.join(', ');

    // ── CPU offload check (every 10th turn or turn 1) ───────────────────────
    let ollamaProcessor = '';
    let ollamaContext = '';
    if (turnCounter === 1 || turnCounter % 10 === 0) {
      const ps = getOllamaPs();
      ollamaProcessor = ps.processor;
      ollamaContext = ps.context;
      if (turnCounter === 1) {
        baselineProcessor = ollamaProcessor;
        console.log(`  Baseline processor: ${baselineProcessor || '(model not yet loaded)'}`);
      } else if (!cpuOffloadDetected) {
        // Check if CPU involvement appeared that was absent at turn 1
        const hasCpuNow = ollamaProcessor.toLowerCase().includes('cpu');
        const hadCpuAtStart = (baselineProcessor || '').toLowerCase().includes('cpu');
        if (hasCpuNow && !hadCpuAtStart) {
          cpuOffloadDetected = true;
          cpuOffloadFirstTurn = displayTurn;
          console.log(`  *** CPU OFFLOAD DETECTED at T${displayTurn}: ${ollamaProcessor} ***`);
        }
      }
    }

    // ── Call Ollama ─────────────────────────────────────────────────────────
    const callStart = Date.now();
    let result;
    try {
      result = await callOllama(finalApiMessages, options, displayTurn);
    } catch (err) {
      console.error(`  T${displayTurn} ERROR: ${err.message}`);
      // Write error line and continue
      const errLine = JSON.stringify({
        run_id, turn: displayTurn, error: err.message,
        is_probe: entry.type === 'probe', probe_id: entry.probe_id ?? null,
      });
      appendFileSync(jsonlPath, errLine + '\n', 'utf8');
      // Still add user message to history so indices stay correct
      messages.push(userMsg);
      messages.push({ role: 'assistant', content: '' });
      continue;
    }
    const callMs = Date.now() - callStart;

    const { fullText, evalCount, evalDuration, totalDuration } = result;

    // ── Compute tokens/sec ──────────────────────────────────────────────────
    const tokensPerSec = evalDuration > 0 ? evalCount / (evalDuration / 1e9) : 0;

    // ── Add to message history ──────────────────────────────────────────────
    messages.push(userMsg);
    messages.push({ role: 'assistant', content: fullText });

    // ── Score probe if applicable ───────────────────────────────────────────
    let anchorsTestedList = [];
    let anchorsPassedList = [];
    let probeId = null;

    if (entry.type === 'probe') {
      probeId = entry.probe_id;
      probeResults[probeId] = { anchors: [], passed: 0, total: 0 };

      for (const anchor of entry.anchors) {
        const passes = fullText.toLowerCase().includes(anchor.expected.toLowerCase());
        const anchorResult = { id: anchor.id, expected: anchor.expected, category: anchor.category, pass: passes };
        probeResults[probeId].anchors.push(anchorResult);
        probeResults[probeId].total++;
        categoryTotal[anchor.category]++;

        if (passes) {
          probeResults[probeId].passed++;
          categoryPassed[anchor.category]++;
          anchorsPassedList.push(anchor.id);
        } else {
          anchorsTestedList.push(anchor.id);
          // Drift onset tracking
          if (!driftOnset) {
            driftOnset = {
              probe: probeId,
              anchor_id: anchor.id,
              probe_turn: displayTurn,
              introduced_turn: getIntroducedTurn(anchor.id),
              turn_distance: displayTurn - getIntroducedTurn(anchor.id),
            };
          }
        }
        anchorsTestedList.push(anchor.id);
      }

      const score = `${probeResults[probeId].passed}/${probeResults[probeId].total}`;
      const failedIds = probeResults[probeId].anchors.filter(a => !a.pass).map(a => a.id);
      const passedIds = probeResults[probeId].anchors.filter(a => a.pass).map(a => a.id);
      console.log(`  T${String(displayTurn).padStart(2,'0')} [${probeId}] Score: ${score}  PASS: [${passedIds.join(',')}]  FAIL: [${failedIds.join(',')}]`);
      if (failedIds.length) {
        console.log(`         Response snippet: ${fullText.slice(0, 200)}`);
      }
    } else {
      // Non-probe: track tokens for performance stats
      if (tokensPerSec > 0) tokensPerSecSamples.push(tokensPerSec);
      console.log(`  T${String(displayTurn).padStart(2,'0')} [user]  ${String(evalCount).padStart(4)} tok  ${tokensPerSec.toFixed(1)} tok/s  digest_len=${entities.length}`);
    }

    // ── Passive recall check T59 (cracked fountain / B7) ───────────────────
    if (scriptIdx === 58) { // T59 (0-based: 58)
      if (!fullText.toLowerCase().includes('cracked fountain') &&
          !fullText.toLowerCase().includes('fountain')) {
        console.log(`  T59 WARNING: DM may have forgotten cracked fountain (B7). Snippet: ${fullText.slice(0,150)}`);
        contradictions.push({
          turn: displayTurn,
          anchor: 'B7',
          expected: 'cracked fountain',
          snippet: fullText.slice(0, 200),
          type: 'passive_recall_miss',
        });
      }
    }

    // ── Write JSONL line ────────────────────────────────────────────────────
    const logLine = {
      run_id,
      turn: displayTurn,
      script_idx: scriptIdx,
      is_probe: entry.type === 'probe',
      probe_id: probeId,
      anchors_tested: anchorsTestedList,
      anchors_passed: anchorsPassedList,
      tokens_per_sec: Math.round(tokensPerSec * 100) / 100,
      eval_count: evalCount,
      eval_duration_ns: evalDuration,
      total_duration_ns: totalDuration,
      wall_ms: callMs,
      ollama_processor: ollamaProcessor,
      ollama_context: ollamaContext,
      entity_digest_string: entityDigestString,
      entity_digest_length: entities.length,
      response_snippet: fullText.slice(0, 200),
      trim_triggered: willTrim,
    };
    appendFileSync(jsonlPath, JSON.stringify(logLine) + '\n', 'utf8');
  }

  // ── Finalize summary ──────────────────────────────────────────────────────
  const wallTime = Math.round((Date.now() - wallStart) / 1000);

  // Performance stats (non-probe turns only)
  const sortedTok = [...tokensPerSecSamples].sort((a, b) => a - b);
  const meanTok = sortedTok.length ? sortedTok.reduce((a, b) => a + b, 0) / sortedTok.length : 0;

  // Category accuracy
  const catAccuracy = {};
  for (const cat of ['A', 'B', 'C']) {
    catAccuracy[cat] = categoryTotal[cat] > 0
      ? Math.round((categoryPassed[cat] / categoryTotal[cat]) * 1000) / 1000
      : null;
  }

  const summary = {
    run_id,
    num_ctx,
    num_predict: BASE_OPTIONS.num_predict,
    deviation_note: 'num_predict=400 (production=900) per PROTOCOL §6',
    total_turns: turnCounter,
    probe_results: probeResults,
    category_accuracy: catAccuracy,
    category_counts: { passed: categoryPassed, total: categoryTotal },
    drift_onset: driftOnset,
    contradictions,
    trim_boundary_log: trimBoundaryLog,
    performance: {
      mean_tok_per_sec: Math.round(meanTok * 100) / 100,
      p25_tok_per_sec: Math.round(percentile(sortedTok, 25) * 100) / 100,
      p75_tok_per_sec: Math.round(percentile(sortedTok, 75) * 100) / 100,
      p95_tok_per_sec: Math.round(percentile(sortedTok, 95) * 100) / 100,
      sample_count: sortedTok.length,
    },
    cpu_offload_detected: cpuOffloadDetected,
    cpu_offload_first_turn: cpuOffloadFirstTurn,
    wall_time_seconds: wallTime,
  };

  // Write summary
  const { writeFileSync } = await import('fs');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n' + '='.repeat(70));
  console.log(`RUN COMPLETE: ${run_id}`);
  console.log(`Wall time: ${wallTime}s`);
  console.log(`Category accuracy: A=${catAccuracy.A}  B=${catAccuracy.B}  C=${catAccuracy.C}`);
  console.log(`Performance: mean=${meanTok.toFixed(1)} p25=${percentile(sortedTok,25).toFixed(1)} p75=${percentile(sortedTok,75).toFixed(1)} p95=${percentile(sortedTok,95).toFixed(1)} tok/s`);
  console.log(`CPU offload: ${cpuOffloadDetected ? `YES at T${cpuOffloadFirstTurn}` : 'No'}`);
  console.log(`Summary: ${summaryPath}`);
  console.log('='.repeat(70) + '\n');

  return summary;
}

// ─── Smoke validation per PROTOCOL.md §6 ─────────────────────────────────────

async function runSmoke(num_ctx) {
  console.log('\n=== SMOKE TEST (15-turn subset, num_ctx=' + num_ctx + ') ===\n');

  // Check 1: trimContext + extractEntities construct correctly
  const testMessages = [
    { role: 'user', content: 'Test input 1' },
    { role: 'assistant', content: 'The **Blacksmith Garret** works at the **Forge of Embers**.' },
  ];
  const ents = extractEntities(testMessages);
  const trimmed = trimContext(testMessages);
  const check1 = ents.includes('Blacksmith Garret') || ents.some(e => e.includes('Garret'));
  console.log(`Check 1 — trimContext/extractEntities: ${check1 ? 'PASS' : 'FAIL'}  entities=${JSON.stringify(ents)}`);

  // Check 2: streaming NDJSON succeeds — will be validated during smoke run
  // Check 3: final done line has eval_count+eval_duration — validated in smoke run
  // Check 4: ollama ps parses
  const ps = getOllamaPs();
  const check4 = ps.processor !== 'error';
  console.log(`Check 4 — ollama ps parses: ${check4 ? 'PASS' : 'FAIL'}  processor="${ps.processor}"`);

  // Run the smoke subset
  const smokeSummary = await runHarness({
    mode: 'smoke',
    num_ctx,
    run_id: `smoke_${num_ctx}`,
  });

  // Check 2+3: streaming worked if we got any turns with eval_count
  // Read back the jsonl to verify
  const jsonlPath = path.join(STRESS_DIR, `stress-test-smoke_${num_ctx}.jsonl`);
  let lines = [];
  try {
    lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {}

  const streamedLines = lines.filter(l => l.eval_count > 0);
  const check2 = streamedLines.length > 0;
  const check3 = streamedLines.every(l => l.eval_count > 0 && l.eval_duration_ns > 0);
  console.log(`Check 2 — streaming NDJSON succeeds: ${check2 ? 'PASS' : 'FAIL'}  (${streamedLines.length} turns with tokens)`);
  console.log(`Check 3 — done line has eval_count+eval_duration: ${check3 ? 'PASS' : 'FAIL'}`);

  // Check 5: ≥1 B-anchor recalled in the probe
  const p1 = smokeSummary.probe_results?.P1;
  const check5 = p1 && p1.passed >= 1;
  console.log(`Check 5 — ≥1 B-anchor recalled in P1: ${check5 ? 'PASS' : 'FAIL'}  score=${p1?.passed ?? 0}/${p1?.total ?? 0}`);

  const allPass = check1 && check2 && check3 && check4 && check5;
  console.log(`\nSMOKE RESULT: ${allPass ? '*** ALL 5 CHECKS PASSED — proceeding to full run ***' : '*** SMOKE FAILED — halting ***'}`);

  return { allPass, checks: { check1, check2, check3, check4, check5 }, smokeSummary };
}

// ─── Comparison table per PROTOCOL.md §5.3 ───────────────────────────────────

function printComparison(summaryA, summaryB) {
  const catA = summaryA.category_accuracy;
  const catB = summaryB.category_accuracy;
  const perfA = summaryA.performance;
  const perfB = summaryB.performance;

  const recallDeltaB = (catB.B ?? 0) - (catA.B ?? 0);
  const speedRatio = perfA.mean_tok_per_sec > 0
    ? perfB.mean_tok_per_sec / perfA.mean_tok_per_sec
    : 0;

  // Decision rule per §5.3
  let recommendation = '';
  let reason = '';

  const cpuFlagB = summaryB.cpu_offload_detected && !summaryA.cpu_offload_detected;

  if (cpuFlagB) {
    recommendation = 'HARD FLAG: Stay at 4096';
    reason = `CPU offload appeared in Run B at T${summaryB.cpu_offload_first_turn} (absent in Run A). Recommend 4096 unless user accepts CPU offload penalty.`;
  } else if (recallDeltaB >= 0.20 && speedRatio >= 0.70) {
    recommendation = 'Upgrade to 8192';
    reason = `recall_delta_B=${recallDeltaB.toFixed(3)} ≥ 0.20 AND speed_ratio=${speedRatio.toFixed(3)} ≥ 0.70`;
  } else if (recallDeltaB >= 0.20 && speedRatio < 0.70) {
    recommendation = 'CONDITIONAL: Upgrade to 8192 only if user accepts >30% slowdown';
    reason = `recall_delta_B=${recallDeltaB.toFixed(3)} ≥ 0.20 but speed_ratio=${speedRatio.toFixed(3)} < 0.70. Run A mean: ${perfA.mean_tok_per_sec.toFixed(1)} tok/s, Run B mean: ${perfB.mean_tok_per_sec.toFixed(1)} tok/s.`;
  } else if (recallDeltaB < 0.20 && speedRatio >= 0.85) {
    recommendation = 'Upgrade to 8192 (negligible cost)';
    reason = `recall_delta_B=${recallDeltaB.toFixed(3)} < 0.20 but speed_ratio=${speedRatio.toFixed(3)} ≥ 0.85 (negligible throughput cost)`;
  } else {
    recommendation = 'Stay at 4096';
    reason = `recall_delta_B=${recallDeltaB.toFixed(3)} < 0.20 AND speed_ratio=${speedRatio.toFixed(3)} < 0.85`;
  }

  // Note if Run A already achieves good B accuracy
  if ((catA.B ?? 0) >= 0.80) {
    reason += ` Note: Run A category_B_accuracy=${catA.B?.toFixed(3)} ≥ 0.80 — entity digest working well; 8192 motivation is weak.`;
  }

  console.log('\n' + '='.repeat(70));
  console.log('FINAL COMPARISON TABLE');
  console.log('='.repeat(70));
  console.log(`${'Metric'.padEnd(30)} ${'Run A (4096)'.padEnd(16)} ${'Run B (8192)'.padEnd(16)}`);
  console.log('-'.repeat(70));
  console.log(`${'Category A accuracy'.padEnd(30)} ${String(catA.A?.toFixed(3) ?? 'N/A').padEnd(16)} ${String(catB.A?.toFixed(3) ?? 'N/A').padEnd(16)}`);
  console.log(`${'Category B accuracy'.padEnd(30)} ${String(catA.B?.toFixed(3) ?? 'N/A').padEnd(16)} ${String(catB.B?.toFixed(3) ?? 'N/A').padEnd(16)}`);
  console.log(`${'Category C accuracy'.padEnd(30)} ${String(catA.C?.toFixed(3) ?? 'N/A').padEnd(16)} ${String(catB.C?.toFixed(3) ?? 'N/A').padEnd(16)}`);
  console.log(`${'Mean tok/s'.padEnd(30)} ${String(perfA.mean_tok_per_sec.toFixed(1)).padEnd(16)} ${String(perfB.mean_tok_per_sec.toFixed(1)).padEnd(16)}`);
  console.log(`${'p25 tok/s'.padEnd(30)} ${String(perfA.p25_tok_per_sec.toFixed(1)).padEnd(16)} ${String(perfB.p25_tok_per_sec.toFixed(1)).padEnd(16)}`);
  console.log(`${'p75 tok/s'.padEnd(30)} ${String(perfA.p75_tok_per_sec.toFixed(1)).padEnd(16)} ${String(perfB.p75_tok_per_sec.toFixed(1)).padEnd(16)}`);
  console.log(`${'p95 tok/s'.padEnd(30)} ${String(perfA.p95_tok_per_sec.toFixed(1)).padEnd(16)} ${String(perfB.p95_tok_per_sec.toFixed(1)).padEnd(16)}`);
  console.log(`${'CPU offload'.padEnd(30)} ${String(summaryA.cpu_offload_detected ? 'YES T'+summaryA.cpu_offload_first_turn : 'No').padEnd(16)} ${String(summaryB.cpu_offload_detected ? 'YES T'+summaryB.cpu_offload_first_turn : 'No').padEnd(16)}`);
  console.log(`${'Drift onset'.padEnd(30)} ${String(summaryA.drift_onset ? summaryA.drift_onset.probe+'/'+summaryA.drift_onset.anchor_id : 'None').padEnd(16)} ${String(summaryB.drift_onset ? summaryB.drift_onset.probe+'/'+summaryB.drift_onset.anchor_id : 'None').padEnd(16)}`);
  console.log(`${'Wall time (s)'.padEnd(30)} ${String(summaryA.wall_time_seconds).padEnd(16)} ${String(summaryB.wall_time_seconds).padEnd(16)}`);
  console.log('-'.repeat(70));
  console.log(`recall_delta_B  = ${recallDeltaB.toFixed(3)}`);
  console.log(`speed_ratio     = ${speedRatio.toFixed(3)}`);
  console.log('-'.repeat(70));
  console.log(`RECOMMENDATION: ${recommendation}`);
  console.log(`REASON: ${reason}`);
  console.log('='.repeat(70) + '\n');
}

// ─── Anchor introduction turn map ────────────────────────────────────────────

function getIntroducedTurn(anchorId) {
  const map = {
    A1:1, A2:1, A3:2, A4:2,
    B1:3, B2:3, B3:5, B4:5, B5:7, B6:7, B7:9, B8:10,
    C1:42, C2:44, C3:48, C4:52,
  };
  return map[anchorId] ?? 0;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, v] = a.slice(2).split('=');
        return [k, v ?? true];
      })
  );

  const mode = args.mode ?? 'smoke';
  const num_ctx = parseInt(args.num_ctx ?? '4096', 10);
  const run_id = args.run_id ?? (mode === 'smoke' ? `smoke_${num_ctx}` : `${num_ctx}_A`);

  if (mode === 'smoke') {
    const { allPass, checks } = await runSmoke(num_ctx);
    if (!allPass) {
      process.exit(1);
    }
  } else if (mode === 'full') {
    await runHarness({ mode: 'full', num_ctx, run_id });
  } else if (mode === 'compare') {
    // Read both summaries and print comparison
    const idA = args.id_a ?? '4096_A';
    const idB = args.id_b ?? '8192_B';
    const pathA = path.join(STRESS_DIR, `stress-test-summary-${idA}.json`);
    const pathB = path.join(STRESS_DIR, `stress-test-summary-${idB}.json`);
    const summaryA = JSON.parse(readFileSync(pathA, 'utf8'));
    const summaryB = JSON.parse(readFileSync(pathB, 'utf8'));
    printComparison(summaryA, summaryB);
  } else {
    console.error(`Unknown mode: ${mode}. Use --mode=smoke|full|compare`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
