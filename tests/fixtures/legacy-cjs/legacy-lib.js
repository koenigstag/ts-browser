// a truly-legacy (non-ESM) script - no import/export syntax at all, just
// attaches a global, the way a plain CDN <script> tag library would
window.LegacyLibGlobal = {
    sayHi: () => 'hi from legacy lib',
};
