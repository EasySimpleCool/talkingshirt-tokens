// Build per-tier JSONs → dist/{input,screen,output,comps,index}.css.
// Reads Token Studio multi-file layout directly.
//
// All values resolve via var() chains: Comps reference Output/Screen/Input,
// Output references Screen/Input, Screen references Input. Flip [data-screen]
// on any element and the cascade re-resolves every downstream var without
// JS or rebuilds.

import StyleDictionary from "style-dictionary";
import { register } from "@tokens-studio/sd-transforms";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.cwd();
const TOKENS_DIR = "tokens";
const OUT_DIR = resolve(ROOT, "dist");

// Source paths — Token Studio's multi-file layout under tokens/. Single-
// set tiers are flat .json files; multi-set tiers are folders.
const SRC = {
  input: `${TOKENS_DIR}/🔵 Input.json`,
  screenMobile: `${TOKENS_DIR}/🟠 Screen/mobile.json`,
  screenDesktop: `${TOKENS_DIR}/🟠 Screen/desktop.json`,
  output: `${TOKENS_DIR}/🟢 Output.json`,
};

for (const [name, path] of Object.entries(SRC)) {
  if (!existsSync(resolve(ROOT, path))) {
    throw new Error(`Missing source: ${path}`);
  }
}

// Comps tier sources — component tokens (🟣 Comps/*). Order matters for
// cross-set refs (e.g. comp.post.gap → comp.stack.sm), so we read it from
// Token Studio's $metadata.json instead of globbing — TS maintains
// tokenSetOrder as you add or reorder sets in the UI.
const metadata = JSON.parse(
  readFileSync(resolve(ROOT, TOKENS_DIR, "$metadata.json"), "utf8"),
);
const compsSets = metadata.tokenSetOrder
  .filter((s) => s.startsWith("🟣 Comps/"))
  .map((s) => `${TOKENS_DIR}/${s}.json`);

if (compsSets.length === 0) {
  throw new Error("No Comps sets found in $metadata.json tokenSetOrder");
}
for (const path of compsSets) {
  if (!existsSync(resolve(ROOT, path))) {
    throw new Error(`Missing source: ${path}`);
  }
}

// --- Custom transform: px units for number-typed tokens ----------------
// Token Studio's built-in ts/size/px only fires on fontSize/dimension/
// borderRadius/spacing types. Our tokens use $type: "number" because they
// represent abstract scale values that could be consumed by non-CSS
// platforms (where px is meaningless). For CSS output, we treat any
// numeric value as a pixel dimension.
//
// transitive: true → runs after refs resolve, so chained refs get units.
// Returns the value untouched if it's already a non-numeric string (e.g.
// a reference token that outputReferences will preserve as var(...)) or
// already carries a unit.
StyleDictionary.registerTransform({
  name: "ts/size/px-number",
  type: "value",
  transitive: true,
  filter: (token) => token.$type === "number" || token.type === "number",
  transform: (token) => {
    const v = token.$value ?? token.value;
    if (typeof v === "number") return `${v}px`;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return `${v}px`;
    return v;
  },
});

// Register Tokens Studio transforms — handles $type/$value DTCG syntax,
// strips $extensions, etc. No name transform is included, so we add one.
register(StyleDictionary);

// --- Custom format: screen tier ----------------------------------------
// Emits each set's tokens twice — once inside a media query (viewport
// default), once on a [data-screen="..."] selector (forced override).
// Attribute selector beats :root on cascade specificity, so a forced
// data-screen wins over whatever the viewport says.
//
// References to Input tokens are emitted as var(--name) so the Input
// layer remains the single source of truth at runtime.
StyleDictionary.registerFormat({
  name: "css/screen-tier",
  format: ({ dictionary, options }) => {
    const { mode, mediaQuery } = options;
    const toVar = (refPath) => `var(--${refPath.replace(/\./g, "-")})`;
    const renderValue = (t) => {
      const orig = t.original.$value ?? t.original.value;
      if (typeof orig === "string" && /\{[^}]+\}/.test(orig)) {
        return orig.replace(/\{([^}]+)\}/g, (_, ref) => toVar(ref));
      }
      return t.$value ?? t.value;
    };
    const decls = dictionary.allTokens
      .map((t) => `  --${t.name}: ${renderValue(t)};`)
      .join("\n");
    return [
      `/* Screen tier: ${mode} */`,
      `@media ${mediaQuery} {`,
      `  :root {`,
      decls.replace(/^ {2}/gm, "    "),
      `  }`,
      `}`,
      `[data-screen="${mode}"] {`,
      decls,
      `}`,
      ``,
    ].join("\n");
  },
});

// --- Run Style Dictionary, one platform per tier -----------------------
// `include` files load tokens for reference resolution only; `source`
// files contribute the tokens we actually emit. The filter restricts
// output to tokens that originated in a source file, so upstream tiers
// don't bleed into the wrong CSS file.

async function buildTier({
  name,
  include = [],
  source,
  format,
  options = {},
  expand,
}) {
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
    // Demote unresolved refs from fatal to warning — incoming Figma sync
    // can leave dangling refs while a component lands across multiple sets.
    log: {
      verbosity: "default",
      warnings: "warn",
      errors: { brokenReferences: "warn" },
    },
  });
  await sd.buildAllPlatforms();
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// Input — primitives → :root. No refs, so outputReferences is moot.
await buildTier({
  name: "input",
  source: [SRC.input],
  format: "css/variables",
});

// Screen mobile + desktop — each emits MQ + attribute selector.
// Input is included for ref resolution but filtered out of output.
await buildTier({
  name: "screen-mobile",
  include: [SRC.input],
  source: [SRC.screenMobile],
  format: "css/screen-tier",
  options: { mode: "mobile", mediaQuery: "(max-width: 767px)" },
});
await buildTier({
  name: "screen-desktop",
  include: [SRC.input],
  source: [SRC.screenDesktop],
  format: "css/screen-tier",
  options: { mode: "desktop", mediaQuery: "(min-width: 768px)" },
});

// Output — theme tokens → :root, referencing Input via var().
// Mobile is included as the "default" Screen set so any refs like
// {number.sm} resolve at build time; runtime swapping is handled by
// screen.css. outputReferences keeps refs as var(--name).
await buildTier({
  name: "output",
  include: [SRC.input, SRC.screenMobile],
  source: [SRC.output],
  format: "css/variables",
  options: { outputReferences: true },
  // Expand typography composites into per-property vars for CSS consumption.
  expand: { include: ["typography"] },
});

// Comps — component tokens → :root, referencing Output/Screen/Input.
// All upstream tiers included for ref resolution; only Comps tokens
// emitted thanks to the isSource filter.
await buildTier({
  name: "comps",
  include: [SRC.input, SRC.screenMobile, SRC.output],
  source: compsSets,
  format: "css/variables",
  options: { outputReferences: true },
});

// --- Stitch screen-mobile + screen-desktop into screen.css ------------
// Built separately so SD could resolve refs per set; concatenated so
// consumers @import a single file.

const mobile = readFileSync(join(OUT_DIR, "screen-mobile.css"), "utf8");
const desktop = readFileSync(join(OUT_DIR, "screen-desktop.css"), "utf8");
writeFileSync(join(OUT_DIR, "screen.css"), mobile + "\n" + desktop);
rmSync(join(OUT_DIR, "screen-mobile.css"));
rmSync(join(OUT_DIR, "screen-desktop.css"));

// --- Write index.css entrypoint ---------------------------------------
// Import order matches dependency order: Input → Screen → Output → Comps.
// Each tier's CSS only references vars from tiers above it.
writeFileSync(
  join(OUT_DIR, "index.css"),
  [
    `/* Generated — do not edit. Built from Token Studio multi-file sources. */`,
    `@import "./input.css";`,
    `@import "./screen.css";`,
    `@import "./output.css";`,
    `@import "./comps.css";`,
    ``,
  ].join("\n"),
);

console.log("✓ Built dist/{input,screen,output,comps,index}.css");
