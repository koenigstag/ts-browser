// dynamically importing a legacy .js file AS ITS OWN ENTRY POINT - exercises
// loadEntryPoint()'s "the entry point itself is a legacy target" branch,
// which returns the eval'd value directly instead of calling materialize()/import()
export const loadLegacyDynamically = async () => {
    const mod = await import('./legacy-lib2.js');
    return mod;
};
