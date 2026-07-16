// a plain, already-native ESM file - meant to be fetched directly by the
// browser via the page's import map, never touched by ts-browser's own
// fetch/transpile pipeline at all
export const greeting = 'Hello from external-lib (native fetch, never touched by ts-browser)';
