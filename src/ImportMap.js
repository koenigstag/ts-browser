/** @typedef {{ imports: Record<string, string>, integrity?: Record<string, string>, scopes?: Record<string, Record<string, string>> }} ImportMap */

/** @type {ImportMap} */
const defaultImportMap = {
    imports: {},
    integrity: {},
    scopes: {},
};

/**
 * @returns {ImportMap | null} parsed import map object or null if not found
 */
export const getImportMap = () => {
    if (typeof window === 'undefined' || typeof window.document === 'undefined') {
        return null;
    }

    // get all <script type="importmap"> nodes in the document
    const nodes = document.querySelectorAll('script[type="importmap"]');

    function parseImportMap(node) {
        try {
            const parsed = JSON.parse(node?.textContent || '{}');
            return {
                imports: parsed.imports || {},
                integrity: parsed.integrity || {},
                scopes: parsed.scopes || {}
            };
        } catch {
            return defaultImportMap;
        }
    }

    const importMaps = Array.from(nodes).map(parseImportMap);

    // merge all import maps into a single object
    const mergedImportMap = importMaps.reduce((acc, curr) => {
        const mergedScopes = { ...acc.scopes };
        // first scope wins in case of key conflicts within a scope
        for (const [scopeKey, specifierMap] of Object.entries(curr.scopes || {})) {
            mergedScopes[scopeKey] = {
                ...specifierMap,
                ...((acc.scopes || {})[scopeKey] || {}),
            };
        }

        return {
            // first importmap has higher priority, later cannot override it
            imports: { ...curr.imports, ...acc.imports },
            integrity: { ...curr.integrity, ...acc.integrity },
            scopes: mergedScopes,
        };
    }, defaultImportMap);

    window.ImportMap = mergedImportMap; // for debugging purposes

    return mergedImportMap;
};
