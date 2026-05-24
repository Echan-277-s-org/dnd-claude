/**
 * run-full-comparison.mjs
 * Orchestrates both full runs (A and B) sequentially with the required gap,
 * then prints the comparison table. Designed to run as a single background process.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const STRESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(STRESS_DIR, 'harness.mjs');

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getOllamaPs() {
  try {
    const out = execSync('ollama ps', { encoding: 'utf8', timeout: 10000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return { processor: 'none', context: '' };
    const dataLine = lines[1];
    if (!dataLine || !dataLine.trim()) return { processor: 'none', context: '' };
    const parts = dataLine.split(/\s{2,}/);
    return { processor: (parts[3] || '').trim(), context: (parts[4] || '').trim() };
  } catch {
    return { processor: 'error', context: '' };
  }
}

async function waitForModelIdle(maxWaitMs = 120000) {
  console.log('Waiting for model to go idle (≥60s between runs per spec)...');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await waitMs(10000);
    const ps = getOllamaPs();
    console.log(`  ollama ps: processor="${ps.processor}"  (${Math.round((Date.now()-start)/1000)}s elapsed)`);
    if (!ps.processor || ps.processor === 'none' || ps.processor === '') {
      console.log('  Model appears idle.');
      return true;
    }
  }
  console.log('  WARNING: model did not go fully idle within timeout — continuing anyway');
  return false;
}

// Each run is launched as a child process (node harness.mjs --mode=full ...), which writes
// its own jsonl/summary independently. We do NOT import harness.mjs here, because it
// auto-calls main() on import and would trigger an extra smoke run as a side effect.
import { spawn } from 'child_process';

function runNode(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HARNESS, ...args], {
      stdio: 'inherit',
      cwd: STRESS_DIR,
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`harness.mjs exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

console.log('='.repeat(70));
console.log('FULL COMPARISON ORCHESTRATOR');
console.log('Run A: num_ctx=4096  Run B: num_ctx=8192');
console.log('='.repeat(70));

// Run A
console.log('\n--- Starting Run A (num_ctx=4096) ---\n');
await runNode(['--mode=full', '--num_ctx=4096', '--run_id=4096_A']);

// Wait between runs
await waitForModelIdle();
console.log('Enforcing minimum 60s gap between runs...');
await waitMs(60000);

// Run B
console.log('\n--- Starting Run B (num_ctx=8192) ---\n');
await runNode(['--mode=full', '--num_ctx=8192', '--run_id=8192_B']);

// Print comparison
console.log('\n--- Printing comparison table ---\n');
await runNode(['--mode=compare', '--id_a=4096_A', '--id_b=8192_B']);

console.log('Full comparison orchestration complete.');
