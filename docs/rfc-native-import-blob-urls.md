# [Design Doc] Replace manual destructuring import rewriting with native `import`/`export` + Blob URLs

**Type:** Design doc / RFC — no code yet, opening for discussion before implementation.

### Summary

Right now `ParseTsModule_sideEffects.js` rewrites every `import ... from '...'` into a manual destructuring assignment against a global registry (`window['ts-browser-loaded-modules']`), and executes each transpiled module via `import('data:text/javascript;base64,' + code)`. This proposal keeps native `import`/`export` syntax in the emitted code and lets the browser's own module linker do the binding, instead of hand-rolling it.

### Motivation

- **Live bindings.** `export let x` mutated after init currently doesn't propagate to consumers — the destructuring approach is a one-time snapshot, not a real binding.
- **Less custom code.** Removes `es6ToDestr` (manual reconstruction of default/named/renamed/mixed import bindings) — the browser already does this correctly for free once real `import` statements survive.
- **Frees non-CDN-mapped bare specifiers from custom resolution entirely.** For a bare specifier matched by a flat `imports` entry (no `scopes`), the browser can resolve + fetch + `integrity`-check it itself with zero involvement from ts-browser, once the specifier is left untouched instead of forced through our own fetch/transpile pipeline.
- **Drops the `data:`+base64 execution path in favor of `Blob`+`URL.createObjectURL`.** Removes the `b64EncodeUnicode` workaround entirely (plain `btoa` throws on non-ASCII source, e.g. non-Latin string literals in user code).
- **Better DevTools experience.** A `//# sourceURL=...` comment per generated module gives a real file tree in Sources (e.g. `ts-browser://script/state.ts`) instead of opaque `VM123`/`blob:...uuid` entries, and makes stack traces readable.

### Relation to #30

Orthogonal, not overlapping. #30 teaches `addPathToUrl` to resolve bare specifiers via the page's import map — necessary as long as ts-browser fetches/transpiles a dependency itself. This proposal changes *how* an already-resolved dependency is wired into the parent's code (native `import` vs. manual destructuring). One consequence: for bare specifiers covered by a **flat** `imports` entry, after this change they can be left as literal bare specifiers and skipped from `staticDependencies` altogether — #30's resolution path is then only exercised for specifiers ts-browser still needs to fetch/transpile itself (i.e. every local `.ts`/`.tsx` file, and any bare specifier *not* covered by the import map).

**Correction found during implementation:** a bare specifier *not* covered by the import map does **not** throw a clean "not found in import map" error, as originally stated above. This project's `addPathToUrl` has always allowed a dot-less specifier to be treated as a same-directory relative file (IDEA-style auto-import, without the `./` prefix — see `tests/UrlPathResolverTest.js`'s "ServApi" case), and there is no syntactic way to distinguish that from a genuinely-bare npm-style specifier. So the actual precedence is: import-map match wins if present; otherwise the specifier falls through to ordinary relative-path resolution, unconditionally, exactly as it did before this RFC. An unmapped bare specifier that isn't also a valid local file just fails later, as an ordinary "file not found" fetch error, not a dedicated import-map error.

### Proposed design

**1. `ParseTsModule_sideEffects.js`**
- Drop `es6ToDestr` and the `window[CACHE_LOADED]` destructuring codegen.
- For a **relative** specifier (`ImportDeclaration` or **literal-string** dynamic `import()`): keep the import statement text as-is, replace only the specifier's source range with a placeholder token (e.g. `"__TSB_DEP__:<depUrl>"`).
- For a **dynamic `import()` with a non-literal argument** (i.e. `arg.kind !== StringLiteral`, same check the current `dynamicDependencies` logic already makes): the placeholder-substitution scheme does not apply — the target path isn't known until the call executes, after the enclosing module's Blob URL has already been created and frozen. This case keeps today's runtime rewrite: the call is replaced with `window[IMPORT_DYNAMIC](arg, baseUrl)`, which resolves, fetches/transpiles, and materializes the target module at call time, same as it does now. Only **relative** specifiers and **literal-string** dynamic imports go through the new placeholder/materialize path; computed dynamic imports remain a runtime call.
- For a **bare** specifier already covered by the page's flat `imports` map: leave completely untouched, do not add to `staticDependencies`.
- `export` / `export type` handling stays as-is (already passes through `ts.transpile` untouched today, since only `ImportDeclaration` is special-cased).

**2. `ts-browser.js`**
- New `materialize(url)`: recursively materializes `staticDependencies` first (post-order), substitutes each child's placeholder with its resolved Blob URL, only then creates this module's own Blob URL.
- Path→URL cache (`Map<path, blobUrl>`) replaces the current export-value registry; memoized the same way `getFileData`/`urlToWhenFileData` already are — one `createObjectURL` call per `depUrl`, ever (required to avoid creating duplicate module instances with independent module-level state).
- Cycle guard: track in-flight URLs on the current recursion branch. On a genuine cycle, throw an explicit "circular import not supported" error rather than attempting a partial/silent resolution — **but see the "Open questions" section below: this default is a documented public-behavior regression and needs an explicit decision, not just an implementation detail.**

**On circular imports.** Native `import`/`export` supports cycles (via TDZ/hoisting) — this is not a limitation of the platform. The reason `materialize()` cannot support them is structural to *this specific* strategy: it builds one Blob URL per file, post-order, substituting each child's already-known URL into the parent before the parent's own Blob is created. A genuine A↔B cycle has no valid post-order — neither file's dependency is available before the other's. This is a real regression relative to today's `makeCircularRefProxy`, which degrades gracefully (throws only if a cyclic binding is accessed before the other module finishes initializing, not unconditionally) rather than failing every cyclic import outright. Accepting this regression is a deliberate trade-off of the Blob-per-file approach, not an incidental gap.

**3. Execution (proposed)**

Pseudocode, not a final API — illustrates the shape of the two-phase placeholder→blobUrl substitution, not the exact function signatures/wiring:

```js
async function materializeLeaf(originalPath, jsCode) {
    if (blobUrlCache.has(originalPath)) {
        return blobUrlCache.get(originalPath);
    }
    const codeWithMarker = jsCode + '\n//# sourceURL=' + stableVirtualPath(originalPath);
    const blob = new Blob([codeWithMarker], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    blobUrlCache.set(originalPath, blobUrl);
    return blobUrl;
}

// materialize() recursively walks staticDependencies post-order (per §2):
// for each child dependency it first calls itself (or materializeLeaf) to
// obtain that child's own resolved blobUrl, then substitutes it into this
// file's code wherever the corresponding "__TSB_DEP__:<path>" placeholder
// appears, and only after all children are substituted does it produce
// this node's own blobUrl — exact wiring between materialize() and
// materializeLeaf() TBD.

// at the top-level entry point:
const absoluteEntryPath = getAbsolutePath(entryPath);
const rootBlobUrl = await materialize(absoluteEntryPath);
return await import(rootBlobUrl);
```

- `blobUrlCache` is the `Map<path, blobUrl>` from §2 — keyed by `originalPath`, populated once per distinct file for the lifetime of the page (or until an explicit invalidation/hot-reload event, per the open revoke-policy question below).
- `stableVirtualPath` must be a pure function of `originalPath` only (no timestamps/random suffixes), so DevTools breakpoints survive page reloads.
- `import(blobUrl)` itself is called only once per distinct `blobUrl` too — the module registry inside the browser's own loader naturally dedupes repeat `import()` calls to the same URL, so caching `blobUrl` by path is what actually guarantees single module-instance semantics, not just an optimization.
- **Caveat:** `originalPath` in the snippet above must already be the fully resolved absolute path/URL of the dependency, not the raw specifier text as written in the importing file. Two different relative specifiers (e.g. `./utils/helper.ts` from one file and `../utils/helper.ts` from another) can point at the same physical file — if `originalPath` isn't normalized to a single canonical form before being used as the cache key, they'd hit different `blobUrlCache` entries and produce two separate module instances, silently reintroducing the duplicate-instance bug this design is meant to fix. `getAbsolutePath(entryPath)` above illustrates this at the entry point; every recursive call inside `materialize()` for `staticDependencies` needs the same normalization applied to each child's `depUrl` before it's used as a cache key.

### Alternatives considered and rejected

- **Registering `virtual/path → blobUrl` into the page's import map at runtime, as files get transpiled.** Doesn't work: per spec, any `<script type="importmap">` added after module graph fetching has started is ignored outright — and that window closes as soon as `ts-browser.js` itself loads as the first module script, before a single dependency is even discovered. Confirmed both by spec text and by independent empirical testing (dynamically swapping import map content post-load has no effect on already-in-flight or future resolutions of previously-touched specifiers). The exact wording of this restriction (quoted from the HTML Living Standard) is discussed in [WICG/import-maps#92](https://github.com/WICG/import-maps/issues/92) — note the issue itself is just a discussion thread arguing the restriction is too strict; the actual normative source is the HTML spec text it quotes, not the issue.
- **Service Worker intercepting synthetic URLs.** Would allow genuinely untouched `import '/virtual/script/state.js'` specifiers, but adds a full SW registration/activation lifecycle (first load before SW control isn't intercepted) for a benefit narrower than what this proposal already achieves for the common case. Reconsider if the correctness cost of losing circular-import support (see above) turns out to be unacceptable in practice — Service Worker interception is the only rejected alternative that registers the whole module graph atomically and would preserve real native circular-import semantics.
- **Node.js/Deno-style loader hooks (`module.registerHooks()`).** Exactly the right primitive for this — synchronous `resolve`/`load` hooks with real virtual specifiers — but it's a Node.js/Deno-only API. No browser equivalent ships today; the closest browser-facing analog (`es-module-shims`'s "Loader Hooks" feature) explicitly falls back to the same Blob-rewriting strategy under the hood once custom hooks are used, since native passthrough is disabled in that mode.

### Out of scope

- `scopes` support (still referrer-based; still broken when the immediate referrer is a synthetic Blob URL — no worse than today for local files, but not fixed either).
- Full source-map passthrough (`sourceMap: true` + `sourcesContent` = original `.ts` text, so DevTools can step through real TypeScript) — natural follow-up, not blocking, since the pipeline already holds both original and transpiled text in memory.
- Legacy non-ESM `.js` interop (`tryEvalLegacyJsModule` eval-as-script fallback, `ts-browser.js:75-82` today). Undecided whether this survives once every module — including plain `.js` — is routed through `materialize()`/Blob, or whether it's preserved as a pre-check before a file enters the new pipeline. Needs an explicit decision before implementation, since it currently gates whether a dependency is treated as a real ES module at all.

### TODO / follow-up items

- [ ] **Only recurse into `.ts`/`.tsx` URLs (CDN https urls).** Skip AST-walking dependencies whose URL doesn't end in `.ts`/`.tsx` (external libs, `.js`, `.mjs`, extensionless CDN paths) — treat them as leaves and pass through untouched instead of fetching/parsing their internals.

### Open questions

- **When should `URL.revokeObjectURL()` be called?** Revoke a file's Blob URL right after the root module's `import()` resolves — **except** for URLs present in `dynamicImportUrls` (the set already tracked today at `ts-browser.js:109`). The distinction matters because not every Blob URL is only ever reached via nested static specifiers embedded as literal text in a parent's already-fetched source (in which case the browser's own module graph walk fetches it exactly once, as part of resolving the single root `import()` promise, and never needs it again). A URL in `dynamicImportUrls` gets its **own**, independent `import(thisBlobUrl)` call later — via `window[IMPORT_DYNAMIC]`/`importDynamic`, which persists in the closure and can fire at an arbitrary point after the root module has already resolved, e.g. on a user click loading a lazy route. Revoking that URL right after root-resolve would break the lazy import whenever it eventually fires. So: revoke the purely-statically-reached subgraph immediately; keep dynamic-import-reachable URLs alive until they've actually been imported at least once (further eviction/hot-reload policy for those is a separate, later decision).

- **How should circular imports be handled, given the hard `throw` in §2 is a documented feature regression?** README.md currently advertises that circular dependencies are supported via a `Proxy` stand-in (`makeCircularRefProxy`) that mimics TypeScript's own circular-dependency behavior, and explicitly invites bug reports "I'll think of a better way to implement circular dependencies then" — so replacing this with an unconditional error isn't an implementation detail, it's a public-behavior change that needs its own decision (and a README update either way). Three ways to keep some form of circular support inside the native-import/Blob design, in increasing order of implementation cost:

  1. **Targeted fallback to today's exact mechanism, scoped only to edges that close a cycle (recommended for v1).** Everything acyclic goes through the new placeholder/`materialize()` path. For the specific `import` statement identified — via the same in-flight/back-edge tracking §2's cycle guard already needs to do — as closing a cycle, generate code for *that one statement* the old way: `es6ToDestr` + `window[CACHE_LOADED]` + `makeCircularRefProxy`, unchanged. Requires knowing the dependency graph before code generation, which is already possible today since `getJsCode()` is called lazily, after `staticDependencies` discovery completes — cycle detection just needs to run in between and hand codegen a set of "this file→dep edge is cyclic" flags. Reuses 100% of existing, already-shipped-and-tested code; zero behavior change for the cyclic case (identical to today), full RFC benefits for everything else.
  2. **Reimplement the Proxy trick as a real ES module using `export let` bindings.** For a file that's an ancestor in a detected cycle, generate a small stub Blob module — `export let foo, bar; export function __tsbResolve(mod) { ({foo, bar} = mod); }` — with export names extracted statically from the ancestor's AST (a small, cycle-scoped addition, since export-name extraction isn't otherwise needed once `export` passes through untouched per §1). The importer inside the cycle imports the stub instead of the not-yet-existing real Blob URL; once the ancestor's real module resolves, `materialize()` calls `__tsbResolve` on the stub with the real module namespace. Reads before resolution get `undefined` instead of throwing (weaker fail-fast than today's Proxy), but reads *after* resolution are genuine live bindings — actually fixing the "live bindings" bug from Motivation even for the cyclic subset, which is strictly better than today. Extra cost: new export-name-extraction code, plus edge cases for `export default` and `export *` re-exports.
  3. **Merge each strongly-connected component into a single Blob module.** Run Tarjan's SCC algorithm over the dependency graph; for any component with more than one file, concatenate all their transpiled bodies into one shared top-level scope (renaming on collision) instead of N separate Blob URLs. Native hoisting/TDZ then resolves the cycle with no proxy/stub machinery at all — the same technique bundlers use for circular ESM. Most correct semantically, but the heaviest lift (name-collision resolution, scope merging) — best treated as a later follow-up rather than a v1 requirement.

### Testing plan

- Unit: feed `ParseTsModule_sideEffects` a two-file mock graph (parent + relative child + one bare specifier), assert placeholder substitution lands at the correct AST position and the final code is valid JS.
- Integration: real browser, a project with a genuine circular pair (A↔B) to confirm the cycle guard throws instead of silently producing `undefined` bindings.
- Manual: confirm `//# sourceURL` grouping and breakpoint persistence across reload in Chrome DevTools.
- Confirm no duplicate `createObjectURL` calls for the same `depUrl` under concurrent dependency resolution (race check on the memoization).
- Confirm cache correctness when the same physical file is reached via two different relative specifiers from different importers (see the "Caveat" note in §3) — both should resolve to a single cached `blobUrl`.
- **Memory:** with the Blob-URL cache holding entries across many dependency resolutions, verify blob URLs don't accumulate unbounded over a long session/many reloads — take a heap snapshot before/after repeated hot-reload or navigation cycles and confirm `Blob` object count returns to baseline (or grows proportionally to distinct files only, not to reload count), and decide/document the actual `revokeObjectURL` policy this test should assert against (see the "When should revokeObjectURL be called?" open question above).
