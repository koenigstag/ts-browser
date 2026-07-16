import './legacy-lib.js';

// by the time this module's body runs, legacy-lib.js's side effect has
// already happened - during ts-browser's eager legacy-detection probe, which
// runs before any Blob is even created (see ts-browser.js's detectLegacyModules)
export const result = (window as any).LegacyLibGlobal.sayHi();
