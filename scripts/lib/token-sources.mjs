// Shared source discovery for the token build and the preview tool.
//
// There are deliberately NO token filenames in this codebase. Every source
// path is derived from tokens/$metadata.json → tokenSetOrder, which Token
// Studio maintains as sets are added, renamed or reordered in the UI. That
// makes a casing drift like `Mobile.json` vs `mobile.json` structurally
// impossible rather than a bug waiting to be re-fixed.
//
// Tiers are identified by the emoji prefix on the set name, not by the name
// itself, so sets can be renamed freely without touching the build:
//
//   🔵  input   — primitives (exactly one set)
//   🟠  modify  — switchable dimensions, one folder per dimension
//   🟢  output  — semantic/theme layer (exactly one set)
//   🟣  comps   — component tokens (ordered; order matters for cross-set refs)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const TOKENS_DIR = "tokens";

const TIER_BY_PREFIX = {
  "🔵": "input",
  "🟠": "modify",
  "🟢": "output",
  "🟣": "comps",
};

// The one piece of legitimately hardcoded data in the build: Token Studio has
// nowhere to record the viewport/system condition a modify set corresponds to.
// Keyed by "<Dimension>/<Mode>" so it survives set renames that keep the shape.
// A 🟠 set missing from this map fails the build rather than being skipped.
export const MEDIA_QUERIES = {
  "Screen/Mobile": "(max-width: 767px)",
  "Screen/Desktop": "(min-width: 768px)",
  "Displaymode/Light": "(prefers-color-scheme: light)",
  "Displaymode/Dark": "(prefers-color-scheme: dark)",
};

// "🟠 Screen/Mobile" → { dimension: "Screen", mode: "Mobile", key: "Screen/Mobile" }
function splitModifySet(setName) {
  const rest = setName.slice(setName.indexOf(" ") + 1);
  const parts = rest.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Malformed 🟠 set "${setName}" in $metadata.json.\n` +
        `  Modify sets must be a folder per switchable dimension: "🟠 <Dimension>/<Mode>".`,
    );
  }
  return { dimension: parts[0], mode: parts[1], key: `${parts[0]}/${parts[1]}` };
}

/**
 * Read $metadata.json and bucket every declared set into its tier.
 *
 * @param {string} root  directory containing tokens/
 * @returns {{
 *   order: string[],
 *   input: {setName: string, path: string},
 *   output: {setName: string, path: string},
 *   comps: {setName: string, path: string}[],
 *   modify: {setName: string, path: string, dimension: string, mode: string, key: string, mediaQuery: string}[],
 *   dimensions: Map<string, {setName: string, path: string, dimension: string, mode: string, key: string, mediaQuery: string}[]>,
 * }}
 */
export function readTierMap(root) {
  const metaPath = resolve(root, TOKENS_DIR, "$metadata.json");
  if (!existsSync(metaPath)) {
    throw new Error(`Missing ${TOKENS_DIR}/$metadata.json — cannot discover token sets.`);
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const order = meta.tokenSetOrder;
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error(`${TOKENS_DIR}/$metadata.json has no tokenSetOrder entries.`);
  }

  const buckets = { input: [], modify: [], output: [], comps: [] };

  for (const setName of order) {
    const tier = TIER_BY_PREFIX[[...setName][0]];
    if (!tier) {
      throw new Error(
        `Set "${setName}" in $metadata.json has no recognised tier prefix.\n` +
          `  Expected one of: ${Object.keys(TIER_BY_PREFIX).join(" ")}`,
      );
    }
    const path = `${TOKENS_DIR}/${setName}.json`;
    if (!existsSync(resolve(root, path))) {
      throw new Error(
        `Missing source: ${path}\n` +
          `  Listed in $metadata.json tokenSetOrder but not present on disk.`,
      );
    }
    buckets[tier].push({ setName, path });
  }

  // Single-set tiers must be unambiguous — downstream builds include exactly
  // one input and one output set for reference resolution.
  for (const tier of ["input", "output"]) {
    if (buckets[tier].length !== 1) {
      throw new Error(
        `Expected exactly 1 ${tier} set in tokenSetOrder, found ${buckets[tier].length}` +
          `${buckets[tier].length ? `: ${buckets[tier].map((s) => s.setName).join(", ")}` : ""}.`,
      );
    }
  }
  if (buckets.comps.length === 0) throw new Error("No 🟣 Comps sets found in tokenSetOrder.");
  if (buckets.modify.length === 0) throw new Error("No 🟠 modify sets found in tokenSetOrder.");

  // Attach dimension/mode/media-query to each modify set, and group them by
  // dimension preserving tokenSetOrder (Map keeps insertion order, so cascade
  // order in the emitted CSS mirrors the order Token Studio shows).
  const modify = buckets.modify.map((set) => {
    const parsed = splitModifySet(set.setName);
    const mediaQuery = MEDIA_QUERIES[parsed.key];
    if (!mediaQuery) {
      throw new Error(
        `No media query mapped for 🟠 set "${set.setName}".\n` +
          `  Add "${parsed.key}" to MEDIA_QUERIES in scripts/lib/token-sources.mjs.\n` +
          `  Token Studio cannot record this, so every modify set needs an explicit mapping.`,
      );
    }
    return { ...set, ...parsed, mediaQuery };
  });

  const dimensions = new Map();
  for (const set of modify) {
    if (!dimensions.has(set.dimension)) dimensions.set(set.dimension, []);
    dimensions.get(set.dimension).push(set);
  }

  return {
    order,
    input: buckets.input[0],
    output: buckets.output[0],
    comps: buckets.comps,
    modify,
    dimensions,
  };
}

/**
 * One representative modify set per dimension (the first in tokenSetOrder).
 *
 * Output and Comps are emitted once, not per mode — they need *some* concrete
 * modify set included so cross-tier references resolve at build time. Runtime
 * mode switching is handled by the cascade in modify.css, not by duplicating
 * these tiers.
 */
export function representativeModifySets(tierMap) {
  return [...tierMap.dimensions.values()].map((sets) => sets[0]);
}
