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

// Derive display names from benchmark definitions — no hardcoded map needed
const BENCH_NAMES = Object.fromEntries(
  Object.entries(BENCHMARKS).map(([id, def]) => [id, def.name || id])
);

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

      summary[model][bench] = {
        pass: benchPasses.length,
        total: benchRuns.length,
        rate: benchRuns.length > 0 ? benchPasses.length / benchRuns.length : 0,
        avgTime: avg(benchPasses, 'elapsed'),
        avgTools: avg(benchPasses, 'toolCalls'),
        avgFailures: avg(benchPasses, 'failures'),
      };
    }
  }

  // Compact per-run records (strip inventory to keep it small)
  const compactRuns = runs.map(r => ({
    model: r.model,
    bench: r.bench,
    success: r.success,
    elapsed: r.elapsed,
    toolCalls: r.toolCalls,
    failures: r.failures,
    ts: r.ts,
  }));

  const output = {
    generated: new Date().toISOString(),
    totalRuns: runs.length,
    models,
    benchmarks,
    benchNames: BENCH_NAMES,
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
