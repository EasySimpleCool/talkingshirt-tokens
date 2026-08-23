// Build Token Studio multi-file sources → dist/{input,modify,output,comps,index}.css
//
// Tier discovery is entirely metadata-driven (see scripts/lib/token-sources.mjs):
// no token filename appears anywhere in this codebase.
//
// The switching boundary
// ----------------------
// Input and Modify sit *below* the boundary: their values are fixed per mode,
// selected at runtime by media query or [data-<dimension>] attribute. Output and
// Comps sit *above* it: they are emitted once and must recompute in the cascade
// whenever a mode flips. That is why derived colors above the boundary are
// emitted as live CSS math over var() references rather than baked values —
// a baked value would freeze whichever mode happened to be included at build
// time. It is also why `lighten`/`darken` are rejected above the boundary: they
// have no CSS equivalent, so they can only ever be baked.
//
// Browser floor
// -------------
// Derived colors above the boundary use two modern CSS colour features:
//   • color-mix()                — Safari 16.4+, Chrome 111+, Firefox 113+
//   • relative color syntax      — Safari 16.4+, Chrome 119+, Firefox 128+
// Both are available in all evergreen browsers. Accepted for talkingshirt.co.

import StyleDictionary from "style-dictionary";
import { register } from "@tokens-studio/sd-transforms";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { readTierMap, representativeModifySets } from "./lib/token-sources.mjs";

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "dist");

const tiers = readTierMap(ROOT);

console.log("Discovered token sets:");
console.log(`  🔵 input   ${tiers.input.setName}`);
for (const [dimension, sets] of tiers.dimensions) {
  console.log(`  🟠 modify  ${dimension} → ${sets.map((s) => s.mode).join(", ")}`);
}
console.log(`  🟢 output  ${tiers.output.setName}`);
console.log(`  🟣 comps   ${tiers.comps.map((s) => s.setName.split("/").pop()).join(", ")}`);

// --- Symmetric-math rule ----------------------------------------------
// `lighten`/`darken` are directional: they move a colour one way regardless of
// which mode is active, so a single emitted value cannot be correct in both.
// They are legal below the switching boundary (🔵 Input, 🟠 modify), where the
// value is fixed per mode, and rejected above it (🟢 Output, 🟣 Comps).
// `mix` and `alpha` are symmetric — expressible as live CSS math — so they are
// legal everywhere.

function findDirectionalModifiers(node, path = []) {
  const hits = [];
  if (!node || typeof node !== "object") return hits;

  const modify = node.$extensions?.["studio.tokens"]?.modify;
  if (modify && (modify.type === "lighten" || modify.type === "darken")) {
    hits.push({ path: path.join("."), type: modify.type });
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    hits.push(...findDirectionalModifiers(child, [...path, key]));
  }
  return hits;
}

function assertNoDirectionalModifiersAboveBoundary() {
  const offenders = [];
  for (const set of [tiers.output, ...tiers.comps]) {
    const json = JSON.parse(readFileSync(resolve(ROOT, set.path), "utf8"));
    for (const hit of findDirectionalModifiers(json)) {
      offenders.push({ setName: set.setName, ...hit });
    }
  }
  if (offenders.length === 0) return;

  throw new Error(
    `Directional colour modifiers found above the switching boundary:\n` +
      offenders.map((o) => `  • ${o.path}  (${o.type})  in "${o.setName}"`).join("\n") +
      `\n\n  Directional modifiers cannot sit above the switching boundary; use mix or alpha.\n` +
      `  lighten/darken are only legal in 🔵 Input and 🟠 modify sets, where the\n` +
      `  value is fixed per mode. Above the boundary a single emitted value has to\n` +
      `  stay correct in every mode, which only symmetric math can guarantee.`,
  );
}

assertNoDirectionalModifiersAboveBoundary();

// --- Custom transform: px units for number-typed tokens ----------------
// Token Studio's built-in ts/size/px only fires on fontSize/dimension/
// borderRadius/spacing types. Our tokens use $type: "number" because they
// represent abstract scale values that could be consumed by non-CSS platforms
// (where px is meaningless). For CSS output we treat any numeric value as px.
//
// transitive: true → runs after refs resolve, so chained refs get units.
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

// Register Tokens Studio transforms — DTCG $type/$value handling, colour
// modifiers, math resolution. Its transform group ends with name/camel; the
// per-platform `transforms` list below is concatenated after it, so name/kebab
// (which recomputes from token.path) wins.
register(StyleDictionary);

// --- Value rendering ---------------------------------------------------
// One renderer, shared by every custom format below, so reference-name →
// var-name conversion happens in exactly one place.

const REF_PATTERN = /\{([^}]+)\}/g;

const originalValue = (token) => token.original?.$value ?? token.original?.value ?? token.$value ?? token.value;
const transformedValue = (token) => token.$value ?? token.value;
const modifierOf = (token) =>
  (token.original?.$extensions ?? token.$extensions ?? {})["studio.tokens"]?.modify;
const isColor = (token) => (token.$type ?? token.type) === "color";

/**
 * Map token path → the name Style Dictionary computed for it (name/kebab).
 * Built from the *unfiltered* token list so references into included-but-not-
 * emitted tiers still resolve. This is the single name transform — nothing here
 * re-derives a kebab name by hand.
 */
function buildNameLookup(dictionary) {
  const byPath = new Map();
  for (const token of dictionary.unfilteredAllTokens ?? dictionary.allTokens) {
    byPath.set(token.path.join("."), token.name);
  }
  return byPath;
}

function refToVar(ref, names, token) {
  const name = names.get(ref.trim());
  if (!name) {
    throw new Error(
      `Cannot resolve reference {${ref}} on token "${token.path.join(".")}" — ` +
        `no token with that path is in scope for this build.`,
    );
  }
  return `var(--${name})`;
}

const substituteRefs = (value, names, token) =>
  value.replace(REF_PATTERN, (_, ref) => refToVar(ref, names, token));

const isRefOnly = (value) => typeof value === "string" && /^\s*\{[^}]+\}\s*$/.test(value);
const hasRef = (value) => typeof value === "string" && /\{[^}]+\}/.test(value);

// Round a percentage to 1 decimal, dropping a trailing ".0".
const pct = (n) => String(Math.round(n * 10) / 10);

/** A colour operand is either a reference (→ var()) or a literal (→ verbatim). */
const colourOperand = (value, names, token) =>
  hasRef(value) ? substituteRefs(String(value), names, token) : String(value).trim();

/**
 * Render a `mix` or `alpha` modifier as live CSS math.
 *
 * mix   — sd-transforms computes `base.mix(mixColor, amount)`, i.e. `amount` is
 *         the weight of the *mix colour*, so the base keeps (1 − amount).
 * alpha — sd-transforms sets the base colour's alpha channel to `amount`.
 */
function renderColourMath(token, modifier, names) {
  const amount = Number(modifier.value);
  if (!Number.isFinite(amount)) {
    throw new Error(
      `Token "${token.path.join(".")}" has a ${modifier.type} modifier with a ` +
        `non-numeric value ${JSON.stringify(modifier.value)}.`,
    );
  }
  const base = colourOperand(originalValue(token), names, token);

  switch (modifier.type) {
    case "mix": {
      if (modifier.color === undefined) {
        throw new Error(
          `Token "${token.path.join(".")}" has a mix modifier with no "color" field.`,
        );
      }
      // Token Studio records the interpolation space; lch maps to oklch, which
      // is the perceptually-uniform space CSS actually offers.
      const space = modifier.space === "lch" ? "oklch" : "srgb";
      const mixColour = colourOperand(modifier.color, names, token);
      return `color-mix(in ${space}, ${base} ${pct((1 - amount) * 100)}%, ${mixColour})`;
    }
    case "alpha":
      return `rgb(from ${base} r g b / ${amount})`;
    default:
      throw new Error(
        `Token "${token.path.join(".")}" has an unsupported colour modifier ` +
          `type "${modifier.type}".`,
      );
  }
}

function renderValue(token, names) {
  const modifier = modifierOf(token);

  if (modifier && isColor(token)) {
    // lighten/darken survive only below the boundary, where a baked per-mode
    // value is correct. Style Dictionary has already computed it for us.
    if (modifier.type === "lighten" || modifier.type === "darken") {
      return transformedValue(token);
    }
    return renderColourMath(token, modifier, names);
  }

  const original = originalValue(token);
  if (hasRef(original)) return substituteRefs(String(original), names, token);

  return transformedValue(token);
}

const declarations = (dictionary, names, indent) =>
  dictionary.allTokens
    .map((token) => `${indent}--${token.name}: ${renderValue(token, names)};`)
    .join("\n");

const BANNER = "/* Generated — do not edit. Built from Token Studio sources. */";

// --- Custom format: modify tier ----------------------------------------
// Emits each set's tokens twice — once inside a media query (the viewport or
// system default), once on a [data-<dimension>="<mode>"] selector (a forced
// override). The attribute selector beats :root on specificity, so an explicit
// data-attribute always wins over what the media query says.
//
// Plain references emit as var(--name), keeping Input the runtime source of
// truth rather than copying its values down into every mode.
StyleDictionary.registerFormat({
  name: "css/modify-tier",
  format: ({ dictionary, options }) => {
    const { dimension, mode, mediaQuery } = options;
    const names = buildNameLookup(dictionary);
    const attribute = `[data-${dimension.toLowerCase()}="${mode.toLowerCase()}"]`;

    return [
      `/* ${dimension} → ${mode} */`,
      `@media ${mediaQuery} {`,
      `  :root {`,
      declarations(dictionary, names, "    "),
      `  }`,
      `}`,
      `${attribute} {`,
      declarations(dictionary, names, "  "),
      `}`,
      ``,
    ].join("\n");
  },
});

// --- Custom format: tiers above the switching boundary -----------------
// A single :root block. Plain references stay var() chains; mix/alpha
// modifiers become live CSS math so the derived colour recomputes in the
// cascade the moment a [data-*] attribute or media query flips a mode.
//
// This replaces css/variables + outputReferences, which silently dropped
// studio.tokens.modify extensions and emitted the unmodified reference.
StyleDictionary.registerFormat({
  name: "css/live-math",
  format: ({ dictionary }) => {
    const names = buildNameLookup(dictionary);
    return [BANNER, ``, `:root {`, declarations(dictionary, names, "  "), `}`, ``].join("\n");
  },
});

// --- Run Style Dictionary, one platform per tier -----------------------
// `include` files load tokens for reference resolution only; `source` files
// contribute the tokens actually emitted. The isSource filter keeps upstream
// tiers from bleeding into the wrong CSS file.

async function buildTier({ name, include = [], source, format, options = {}, expand }) {
  const sd = new StyleDictionary({
    include,
    source,
    ...(expand ? { expand } : {}),
    preprocessors: ["tokens-studio"],
    platforms: {
      css: {
        transformGroup: "tokens-studio",
        transforms: ["ts/size/px-number", "name/kebab"],
        buildPath: `${OUT_DIR}/`,
        files: [
          {
            destination: `${name}.css`,
            format,
            options,
            filter: (token) => token.isSource,
          },
        ],
      },
    },
    // A dangling reference is a silent regression on a CDN that serves @main.
    // Red CI is cheaper, so broken references are fatal.
    //
    // NB: brokenReferences takes "throw" | "console" — NOT "warn"/"error".
    // Any other value falls through to the non-throwing console branch, so a
    // plausible-looking "error" here would quietly keep the old warn behaviour.
    log: {
      verbosity: "default",
      warnings: "warn",
      errors: { brokenReferences: "throw" },
    },
  });
  await sd.buildAllPlatforms();
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const inputSrc = tiers.input.path;
// Output and Comps need one concrete modify set per dimension in scope so
// cross-tier references resolve at build time.
const representativeSrcs = representativeModifySets(tiers).map((s) => s.path);

// Input — primitives → :root. No refs, so there is nothing to render live.
await buildTier({ name: "input", source: [inputSrc], format: "css/variables" });

// Modify — every 🟠 dimension × mode, each emitting a media-query block and a
// forced [data-<dimension>] block. Built one set at a time so Style Dictionary
// resolves each mode's references independently, then concatenated in
// tokenSetOrder so cascade order mirrors Token Studio's order.
const modifyChunks = [];
for (const set of tiers.modify) {
  const temp = `_modify-${set.dimension}-${set.mode}`.toLowerCase();
  await buildTier({
    name: temp,
    include: [inputSrc],
    source: [set.path],
    format: "css/modify-tier",
    options: { dimension: set.dimension, mode: set.mode, mediaQuery: set.mediaQuery },
  });
  const tempPath = join(OUT_DIR, `${temp}.css`);
  modifyChunks.push(readFileSync(tempPath, "utf8"));
  rmSync(tempPath);
}
writeFileSync(join(OUT_DIR, "modify.css"), [BANNER, ``, ...modifyChunks].join("\n"));

// Output — semantic layer → :root, with mix/alpha rendered as live CSS math.
await buildTier({
  name: "output",
  include: [inputSrc, ...representativeSrcs],
  source: [tiers.output.path],
  format: "css/live-math",
  // Expand typography composites into per-property vars for CSS consumption.
  expand: { include: ["typography"] },
});

// Comps — component tokens → :root. Same live-math rendering, so a mix or
// alpha added to a component token later renders as CSS rather than vanishing.
await buildTier({
  name: "comps",
  include: [inputSrc, ...representativeSrcs, tiers.output.path],
  source: tiers.comps.map((s) => s.path),
  format: "css/live-math",
});

// --- Entry point -------------------------------------------------------
// Import order matches dependency order: each tier only references vars from
// the tiers above it. The storefront imports dist/index.css via jsDelivr, so
// this filename is the stable public surface.
//
// screen.css is not emitted: it was replaced by modify.css, and no consumer in
// the storefront imports it directly (every consumer loads index.css).
writeFileSync(
  join(OUT_DIR, "index.css"),
  [
    BANNER,
    `@import "./input.css";`,
    `@import "./modify.css";`,
    `@import "./output.css";`,
    `@import "./comps.css";`,
    ``,
  ].join("\n"),
);

console.log("\n✓ Built dist/{input,modify,output,comps,index}.css");
