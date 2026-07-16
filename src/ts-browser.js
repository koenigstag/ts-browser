
import {addPathToUrl} from "./UrlPathResolver.js";
import WorkerManager from "./WorkerManager.js";
import {tryEvalLegacyJsModule} from "./sideEffectModules/sideEffectUtils.js";

const CACHE_LOADED = 'ts-browser-loaded-modules';
const IMPORT_DYNAMIC = 'ts-browser-import-dynamic';
// keep in sync with the identical literal in actions/ParseTsModule_sideEffects.js
const DEP_PLACEHOLDER_PREFIX = '__TSB_DEP__:';

/**
 * @module ts-browser - like ts-node, this tool allows you
 * to require typescript files and compiles then on the fly
 */

const makeCircularRefProxy = (whenModule, newUrl) => {
    // from position of an app writer, it would be better to just not use circular
    // references, but since typescript supports them somewhat, so should I I guess
    let loadedModule = null;
    whenModule.then(
        module => loadedModule = module,
        exc => console.error('Eager import of circular-fallback target ' + newUrl + ' failed:', exc),
    );
    return new Proxy({}, {
        get: (target, name) => {
            return new Proxy(() => {}, {
                apply: (callTarget, thisArg, argumentsList) => {
                    if (loadedModule) {
                        return loadedModule[name].apply(thisArg, argumentsList);
                    } else {
                        throw new Error('Tried to call ' + name + '() on a circular reference ' + newUrl);
                    }
                },
                get: (target, subName) => {
                    if (loadedModule) {
                        return loadedModule[name][subName];
                    } else {
                        throw new Error('Tried to get field ' + name + '.' + subName + ' on a circular reference ' + newUrl);
                    }
                },
            });
        },
    });
};
window[CACHE_LOADED] = window[CACHE_LOADED] || {};

/** a stable, timestamp-free virtual path - so DevTools breakpoints survive reload */
const toStableVirtualPath = (fullUrl) =>
    'ts-browser://script/' + fullUrl.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');

/**
 * Detects, over the already-fully-discovered dependency graph, which specific
 * (fromUrl, toUrl) static-import edges close a circular-dependency cycle.
 * Standard white/gray/black DFS back-edge detection, scoped to
 * staticDependencies only (dynamic-import cycles are a known, documented gap -
 * see docs/rfc-native-import-blob-urls.md "Known risks").
 *
 * State/graph-identity tracking uses canonical urls (getCanonicalUrl), since two
 * different relative specifiers (`./foo` vs `./foo.js`) can point at the same
 * physical file and must be recognized as the same graph node - but the
 * returned Set values stay in each file's own raw depUrl form, since that's
 * what requestJsCode()'s per-statement check compares against.
 *
 * @param {string} entryUrl
 * @param {Record<string, {staticDependencies: {url: string}[]}>} cachedFiles
 * @param {(url: string) => string} getCanonicalUrl
 * @returns {Map<string, Set<string>>} fileUrl -> set of ITS OWN staticDependencies' urls that are cyclic
 */
const findCyclicEdges = (entryUrl, cachedFiles, getCanonicalUrl) => {
    const state = new Map(); // canonicalUrl -> 'visiting' | 'done'
    const cyclicEdges = new Map();

    const markCyclic = (fromRawUrl, toRawUrl) => {
        if (!cyclicEdges.has(fromRawUrl)) cyclicEdges.set(fromRawUrl, new Set());
        cyclicEdges.get(fromRawUrl).add(toRawUrl);
    };

    const visit = (rawUrl) => {
        const canonicalUrl = getCanonicalUrl(rawUrl);
        state.set(canonicalUrl, 'visiting');
        const fileData = cachedFiles[rawUrl];
        const deps = (fileData && fileData.staticDependencies) || [];
        for (const {url: depRawUrl} of deps) {
            const depCanonical = getCanonicalUrl(depRawUrl);
            const depState = state.get(depCanonical);
            if (depState === 'visiting') {
                // depRawUrl is an ancestor of rawUrl on the current DFS path - back edge - cycle
                markCyclic(rawUrl, depRawUrl);
            } else if (depState === 'done') {
                // already fully explored via another path (diamond dependency) - not a cycle from here
            } else {
                visit(depRawUrl);
            }
        }
        state.set(canonicalUrl, 'done');
    };

    visit(entryUrl);
    // cachedFiles is shared/growing across the whole session (root load + every
    // dynamic-import entry point) - cover any part of it not reachable from
    // entryUrl so a file's cyclic status doesn't depend on which entry point
    // happens to discover it first
    for (const rawUrl of Object.keys(cachedFiles)) {
        if (!state.has(getCanonicalUrl(rawUrl))) visit(rawUrl);
    }
    return cyclicEdges;
};

/** ts.ScriptTarget.ES2018 */
const TS_SCRIPT_TARGET_ES2018 = 5;

/** @param {ts.CompilerOptions} compilerOptions */
const LoadRootModule = async ({
    rootModuleUrl,
    compilerOptions = {},
}) => {
    compilerOptions.target = compilerOptions.target || TS_SCRIPT_TARGET_ES2018;
    const workerManager = WorkerManager({compilerOptions});

    const cachedFiles = {};
    const urlToWhenFileData = {};
    const getFileData = url => {
        if (!urlToWhenFileData[url]) {
            urlToWhenFileData[url] = workerManager.fetchModuleData(url);
        }
        return urlToWhenFileData[url];
    };

    const dynamicImportUrls = new Set();
    const fetchDependencyFiles = async (entryUrl) => {
        dynamicImportUrls.add(entryUrl);
        const urlToPromise = {};
        urlToPromise[entryUrl] = getFileData(entryUrl);
        let entries;
        let safeguard = 10000;
        while ((entries = Object.entries(urlToPromise)).length > 0) {
            if (--safeguard <= 0) {
                throw new Error('Got into infinite loop while fetching dependencies of ' + entryUrl);
            }
            const [importingUrl, next] = await Promise.race(
                entries.map(e => e[1].then(result => [e[0], result]))
            );
            cachedFiles[next.url] = next;
            delete urlToPromise[next.url];
            for (const {url} of next.staticDependencies) {
                if (!urlToPromise[url] && !cachedFiles[url]) {
                    urlToPromise[url] = getFileData(url).catch(error => {
                        if (error instanceof Error) {
                            error.message += " - importing from " + importingUrl;
                        }
                        throw error;
                    });
                }
            }
            for (const dep of next.dynamicDependencies) {
                if (dep.url) {
                    if (!cachedFiles[dep.url] && !dynamicImportUrls.has(dep.url)) {
                        // preload dynamic dependency files for optimization
                        fetchDependencyFiles(dep.url);
                    }
                }
            }
        }
        return cachedFiles;
    };

    // resolves a possibly-not-yet-canonical url (e.g. extensionless, or a
    // relative specifier spelled two different ways by two importers) to the
    // canonical fullUrl WorkerManager resolved it to - needed so two spellings
    // of the same physical file are recognized as one graph/cache node
    const getCanonicalUrl = (url) => (cachedFiles[url] && cachedFiles[url].fullUrl) || url;

    const blobUrlCache = new Map(); // canonicalUrl -> blobUrl, never evicted for the life of this LoadRootModule call
    const cyclicFallbackTargets = new Set(); // canonicalUrls - accumulates across entry points (root + dynamic imports)

    // legacy (truly non-ESM) .js dependency detection - a legacy module is a
    // plain JS value (from eval), not a real ES module, so it can never be
    // represented as a Blob a native `import` statement can point at. Whether
    // a given .js file actually IS legacy (vs. real ESM shipped with a .js
    // extension) is only knowable by attempting the eval - so this runs as an
    // eager pass over the whole discovered graph, before any file's own
    // codegen decision is made (same reason cyclic-edge detection needs the
    // full graph up front - see docs/rfc-native-import-blob-urls.md).
    const legacyModuleValues = new Map(); // canonicalUrl -> resolved legacy module value
    const legacyTargetUrls = new Set(); // canonicalUrls confirmed to be truly-legacy
    const checkedLegacyUrls = new Set(); // canonicalUrls already probed, across entry points

    const detectLegacyModules = async () => {
        const candidates = Object.values(cachedFiles).filter(fileData =>
            fileData.isJsSrc && !checkedLegacyUrls.has(getCanonicalUrl(fileData.url)));
        await Promise.all(candidates.map(async fileData => {
            const canonicalUrl = getCanonicalUrl(fileData.url);
            checkedLegacyUrls.add(canonicalUrl);
            // cyclicDepUrls doesn't affect this file's code shape: a truly-legacy
            // (non-ESM) source has no ImportDeclaration statements at all to
            // begin with, so an empty set here is safe - it's only used to
            // sniff for the `import`/`export` syntax error eval() throws on
            // real ESM source, same check today's isJsSrc gate already made
            const probeCode = await fileData.requestJsCode(new Set());
            const loaded = tryEvalLegacyJsModule(probeCode);
            if (loaded) {
                legacyModuleValues.set(canonicalUrl, loaded);
                legacyTargetUrls.add(canonicalUrl);
                // populated now so the cyclic-fallback codegen branch (which
                // reads window[CACHE_LOADED][depUrl] at module-evaluation time,
                // always after this whole setup phase has finished) sees it
                window[CACHE_LOADED][canonicalUrl] = loaded;
            }
        }));
    };

    /**
     * Recursively materializes staticDependencies post-order (child Blob URLs
     * must exist before they can be substituted into the parent's source,
     * since Blob content is immutable once created), returning this file's
     * own Blob URL. Never called for a file that's itself a legacy target -
     * loadEntryPoint() checks that before ever calling materialize().
     *
     * blobUrlCache caches the in-flight Promise itself (same idiom as
     * urlToWhenFileData/getFileData above), not just the resolved value - so
     * two concurrent materialize() calls for the same file (e.g. a diamond
     * dependency reached from two different in-flight entry points) share one
     * createObjectURL() instead of racing to create two.
     */
    const materialize = (url, cyclicEdges) => {
        const canonicalUrl = getCanonicalUrl(url);
        if (!blobUrlCache.has(canonicalUrl)) {
            blobUrlCache.set(canonicalUrl, materializeUncached(url, canonicalUrl, cyclicEdges));
        }
        return blobUrlCache.get(canonicalUrl);
    };

    const materializeUncached = async (url, canonicalUrl, cyclicEdges) => {
        const fileData = cachedFiles[url];
        const cyclicDeps = cyclicEdges.get(url) || new Set();
        // union of "closes a cycle" and "points at a truly-legacy .js file" -
        // both need the old es6ToDestr+CACHE_LOADED codegen instead of a real
        // native import, for different reasons (see comments above)
        const fallbackDepUrls = new Set(cyclicDeps);
        for (const {url: depUrl} of fileData.staticDependencies) {
            if (legacyTargetUrls.has(getCanonicalUrl(depUrl))) {
                fallbackDepUrls.add(depUrl);
            }
        }

        let jsCode = await fileData.requestJsCode(fallbackDepUrls);

        const depsToMaterialize = fileData.staticDependencies.filter(d => !fallbackDepUrls.has(d.url));
        for (const {url: depUrl} of depsToMaterialize) {
            const childBlobUrl = await materialize(depUrl, cyclicEdges);
            const placeholder = JSON.stringify(DEP_PLACEHOLDER_PREFIX + depUrl);
            jsCode = jsCode.split(placeholder).join(JSON.stringify(childBlobUrl));
        }

        jsCode += '\n//# sourceURL=' + toStableVirtualPath(canonicalUrl);
        const blob = new Blob([jsCode], {type: 'text/javascript'});
        const blobUrl = URL.createObjectURL(blob);
        if (cyclicFallbackTargets.has(canonicalUrl)) {
            // this file is the target of some other file's cyclic edge - eagerly
            // import it now and register the (pending) result so that OTHER
            // file's es6ToDestr+CACHE_LOADED codegen has something to read from
            window[CACHE_LOADED][canonicalUrl] = makeCircularRefProxy(import(blobUrl), canonicalUrl);
        }
        return blobUrl;
    };

    /**
     * Shared by main() and importDynamic() - both are independent "entry
     * points" into the same shared cachedFiles/blobUrlCache/etc.
     */
    const loadEntryPoint = async (url) => {
        await detectLegacyModules();
        const canonicalUrl = getCanonicalUrl(url);
        let result;
        if (legacyTargetUrls.has(canonicalUrl)) {
            // the entry point itself is a truly-legacy .js file - there's no
            // Blob/import() for it at all, return the eval'd value directly,
            // same as today's loadModuleFromFiles() behavior for this case
            result = legacyModuleValues.get(canonicalUrl);
        } else {
            const cyclicEdges = findCyclicEdges(url, cachedFiles, getCanonicalUrl);
            for (const targets of cyclicEdges.values()) {
                for (const targetUrl of targets) {
                    cyclicFallbackTargets.add(getCanonicalUrl(targetUrl));
                }
            }
            const blobUrl = await materialize(url, cyclicEdges);
            result = await import(blobUrl);
        }
        // revoke every blob not (possibly) still needed by a future standalone
        // import() via importDynamic() - dynamicImportUrls may use a differently
        // -spelled (non-canonical) form of the same url, so compare canonically
        for (const [blobCanonicalUrl, whenBlobUrl] of blobUrlCache) {
            const stillNeeded = [...dynamicImportUrls].some(u => getCanonicalUrl(u) === blobCanonicalUrl);
            if (!stillNeeded) {
                URL.revokeObjectURL(await whenBlobUrl);
            }
        }
        return result;
    };

    const importDynamic = async (relUrl, baseUrl) => {
        try {
            const url = addPathToUrl(relUrl, baseUrl);
            await fetchDependencyFiles(url);
            return await loadEntryPoint(url);
        } catch (exc) {
            console.warn('Resetting transpilation cache due to uncaught error');
            WorkerManager.resetCache();
            throw exc;
        }
    };

    const main = async () => {
        window[IMPORT_DYNAMIC] = importDynamic;
        const url = addPathToUrl(rootModuleUrl, './');
        await fetchDependencyFiles(url);
        return loadEntryPoint(url);
    };

    return main();
};

/** @return {Promise<any>} */
export const loadModule = async (absUrl, compilerOptions = {}) => {
    return LoadRootModule({rootModuleUrl: absUrl, compilerOptions});
};
