#!/usr/bin/env node
/**
 * Compile benchmark results from JSONL into a summary JSON for the website.
 *
 * Usage:
 *   node compile-benchmarks.js            # compile to docs/benchmark-data.json
 *   node compile-benchmarks.js --check    # print summary to stdout, don't write
 *
 * Also exported as compileBenchmarks() for use from benchmark.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BENCHMARKS } from './benchmark.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.join(__dirname, 'benchmarks', 'results.jsonl');
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'benchmark-data.json');

export function compileBenchmarks({ check = false } = {}) {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error(`No results file found at ${RESULTS_PATH}`);
    return null;
  }

  const lines = fs.readFileSync(RESULTS_PATH, 'utf-8').trim().split('\n');
  const runs = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      console.error(`Skipping malformed line ${i + 1}: ${e.message}`);
      return null;
    }
  }).filter(Boolean);

  if (runs.length === 0) {
    console.error('No valid runs found.');
    return null;
  }

  // Discover models and benchmarks from the data
  const models = [...new Set(runs.map(r => r.model))];
  const benchmarks = [...new Set(runs.map(r => r.bench))];

  // Build per-model, per-bench summaries
  const summary = {};
  for (const model of models) {
    const modelRuns = runs.filter(r => r.model === model);
    const modelPasses = modelRuns.filter(r => r.success);

    summary[model] = {
      overall: {
        pass: modelPasses.length,
        total: modelRuns.length,
        rate: modelRuns.length > 0 ? modelPasses.length / modelRuns.length : 0,
        avgTime: avg(modelPasses, 'elapsed'),
        avgTools: avg(modelPasses, 'toolCalls'),
      },
    };

    for (const bench of benchmarks) {
      const benchRuns = modelRuns.filter(r => r.bench === bench);
      const benchPasses = benchRuns.filter(r => r.success);

      // Aggregate tool usage across all runs for this model+bench
      const toolCounts = {};
      for (const r of benchRuns) {
        for (const t of (r.toolLog || [])) {
          toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
        }
      }

      summary[model][bench] = {
        pass: benchPasses.length,
        total: benchRuns.length,
        rate: benchRuns.length > 0 ? benchPasses.length / benchRuns.length : 0,
        avgTime: avg(benchPasses, 'elapsed'),
        avgTimeout: avg(benchRuns, 'timeout'),
        avgTools: avg(benchPasses, 'toolCalls'),
        avgFailures: avg(benchPasses, 'failures'),
        avgOwnerInteractions: avg(benchRuns, 'ownerInteractions'),
        toolCounts,
      };
    }
  }

  // Compact per-run records
  const compactRuns = runs.map(r => ({
    model: r.model,
    bench: r.bench,
    success: r.success,
    elapsed: r.elapsed,
    timeout: r.timeout || 300_000,
    toolCalls: r.toolCalls,
    failures: r.failures,
    ownerInteractions: r.ownerInteractions || 0,
    toolLog: r.toolLog || [],
    ts: r.ts,
  }));

  // Build benchMeta from BENCHMARKS definitions
  const benchMeta = {};
  for (const id of benchmarks) {
    const def = BENCHMARKS[id];
    if (def) {
      benchMeta[id] = {
        name: def.name,
        timeout: def.timeout,
        goal: def.goal,
        successItems: def.successItems || (def.iconItem ? [def.iconItem] : (def.successCounts ? Object.keys(def.successCounts) : [])),
        startItems: (def.startItems || []).map(s => s.split(' ')[0]),
      };
    } else {
      benchMeta[id] = { name: id, timeout: 300_000, goal: '', successItems: [], startItems: [] };
    }
  }

  const output = {
    generated: new Date().toISOString(),
    totalRuns: runs.length,
    models,
    benchmarks,
    benchMeta,
    // Legacy compat
    benchNames: Object.fromEntries(Object.entries(benchMeta).map(([id, m]) => [id, m.name])),
    benchTimeouts: Object.fromEntries(Object.entries(benchMeta).map(([id, m]) => [id, m.timeout])),
    summary,
    runs: compactRuns,
  };

  if (check) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log(`Compiled ${runs.length} runs → ${OUTPUT_PATH}`);
  }

  return output;
}

function avg(items, key) {
  if (items.length === 0) return null;
  return Math.round(items.reduce((s, r) => s + (r[key] || 0), 0) / items.length);
}

// Run directly
if (process.argv[1] && process.argv[1].endsWith('compile-benchmarks.js')) {
  const check = process.argv.includes('--check');
  compileBenchmarks({ check });
}
