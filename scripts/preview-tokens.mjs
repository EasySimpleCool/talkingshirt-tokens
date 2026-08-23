// Resolve every token in every mode combination and render an inspection page.
//
// The build emits live CSS math above the switching boundary, which is correct
// but unreadable — you cannot eyeball `color-mix(in oklch, var(--a) 90%, var(--b))`
// and know what colour it is. This tool does the opposite: it fully resolves
// every token (references followed, colour modifiers computed) for each
// combination of one set per 🟠 dimension, and lays the results out side by side.
//
// This is the canonical "see the output" surface. Figma is a baked byproduct of
// export, never the reference for correctness.
//
// Outputs (both gitignored build artifacts):
//   token-matrix.json  — combo → { tokenPath → { value, type } }
//   preview.html       — the same matrix as a plain static table

import StyleDictionary from "style-dictionary";
import { register } from "@tokens-studio/sd-transforms";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readTierMap } from "./lib/token-sources.mjs";

const ROOT = process.cwd();
const tiers = readTierMap(ROOT);

// Same transform as the build: $type "number" is an abstract scale value, and
// CSS wants pixels.
StyleDictionary.registerTransform({
  name: "ts/size/px-number",
  type: "value",
  transitive: true,
  filter: (token) => (token.$type ?? token.type) === "number",
  transform: (token) => {
    const v = token.$value ?? token.value;
    if (typeof v === "number") return `${v}px`;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return `${v}px`;
    return v;
  },
});

// Render computed colours as hex. sd-transforms otherwise returns them in the
// modifier'''s own space (e.g. `lch(92.797 0 none)`), which is valid CSS but hard
// to eyeball and hard to compare against Figma. Preview-only — the build renders
// live CSS math from the original values and is unaffected.
register(StyleDictionary, { "ts/color/modifiers": { format: "hex" } });

/** Cartesian product of one set per dimension, in tokenSetOrder. */
function modeCombinations(dimensions) {
  let combos = [[]];
  for (const sets of dimensions.values()) {
    combos = combos.flatMap((combo) => sets.map((set) => [...combo, set]));
  }
  return combos;
}

const comboLabel = (combo) => combo.map((s) => `${s.dimension}=${s.mode}`).join(" · ");

/**
 * Resolve every token for one mode combination.
 *
 * Everything is `source` (not `include`) so the whole graph is emitted, and no
 * custom format is used — we read Style Dictionary's transformed values
 * directly, which means references are followed and colour modifiers computed.
 */
async function resolveCombo(combo) {
  const sd = new StyleDictionary({
    source: [
      tiers.input.path,
      ...combo.map((s) => s.path),
      tiers.output.path,
      ...tiers.comps.map((s) => s.path),
    ],
    expand: { include: ["typography"] },
    preprocessors: ["tokens-studio"],
    platforms: {
      css: {
        transformGroup: "tokens-studio",
        transforms: ["ts/size/px-number", "name/kebab"],
      },
    },
    log: {
      verbosity: "silent",
      warnings: "warn",
      errors: { brokenReferences: "throw" },
    },
  });

  const dictionary = await sd.getPlatformTokens("css");
  const resolved = {};
  for (const token of dictionary.allTokens) {
    resolved[token.path.join(".")] = {
      value: String(token.$value ?? token.value),
      type: token.$type ?? token.type ?? "unknown",
    };
  }
  return resolved;
}

const combos = modeCombinations(tiers.dimensions);
const matrix = {};
for (const combo of combos) {
  matrix[comboLabel(combo)] = await resolveCombo(combo);
}

writeFileSync(resolve(ROOT, "token-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);

// --- preview.html ------------------------------------------------------

const TIER_OF = { input: "🔵 input", modify: "🟠 modify", output: "🟢 output", comp: "🟣 comp" };
const labels = Object.keys(matrix);

// Union of token paths across combos, preserving first-seen order.
const paths = [];
const seen = new Set();
for (const label of labels) {
  for (const path of Object.keys(matrix[label])) {
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
}

const grouped = new Map();
for (const path of paths) {
  const tier = TIER_OF[path.split(".")[0]] ?? "other";
  if (!grouped.has(tier)) grouped.set(tier, []);
  grouped.get(tier).push(path);
}

const escape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cell(entry) {
  if (!entry) return `<td class="missing">—</td>`;
  const value = escape(entry.value);
  if (entry.type === "color") {
    // Values come from our own tokens, but this file is generated — keep anything
    // that could terminate the declaration out of the inline style.
    const safe = entry.value.replace(/[;{}"<>]/g, "");
    return `<td><span class="swatch" style="--swatch:${safe}"></span><code>${value}</code></td>`;
  }
  return `<td><code>${value}</code></td>`;
}

const rows = [...grouped.entries()]
  .map(([tier, tierPaths]) => {
    const header = `<tr class="tier"><th colspan="${labels.length + 2}">${escape(tier)}</th></tr>`;
    const body = tierPaths
      .map((path) => {
        const type = labels.map((l) => matrix[l][path]?.type).find(Boolean) ?? "";
        const cells = labels.map((l) => cell(matrix[l][path])).join("");
        return `<tr><th><code>${escape(path)}</code></th><td class="type">${escape(type)}</td>${cells}</tr>`;
      })
      .join("\n");
    return `${header}\n${body}`;
  })
  .join("\n");

const html = `<!doctype html>
<meta charset="utf-8">
<title>Token matrix — talkingshirt</title>
<style>
  body { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #fff; color: #111; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.meta { margin: 0 0 16px; color: #666; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; vertical-align: middle; white-space: nowrap; }
  thead th { background: #f4f4f4; position: sticky; top: 0; }
  tr.tier th { background: #222; color: #fff; font-weight: normal; }
  td.type { color: #888; }
  td.missing { color: #bbb; }
  /* The colour is its own gradient layer so it paints ON TOP of the checkerboard;
     a background-color would sit underneath it and stay hidden. Partly
     transparent tokens therefore show the checkerboard through them. */
  .swatch { display: inline-block; width: 16px; height: 16px; margin-right: 6px;
            border: 1px solid #999; vertical-align: -4px; background-color: #fff;
            background-image: linear-gradient(var(--swatch), var(--swatch)),
                              linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%),
                              linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%);
            background-size: auto, 8px 8px, 8px 8px;
            background-position: 0 0, 0 0, 4px 4px; }
  code { font: inherit; }
</style>
<h1>Token matrix</h1>
<p class="meta">${labels.length} mode combination${labels.length === 1 ? "" : "s"} · ${paths.length} tokens · generated by <code>npm run preview</code></p>
<table>
  <thead>
    <tr><th>Token</th><th>Type</th>${labels.map((l) => `<th>${escape(l)}</th>`).join("")}</tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
`;

writeFileSync(resolve(ROOT, "preview.html"), html);

console.log(`✓ ${combos.length} combos × ${paths.length} tokens → token-matrix.json, preview.html`);
