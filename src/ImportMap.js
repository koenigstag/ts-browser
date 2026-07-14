/** @typedef {{ imports: Record<string, string> }} ImportMap */

const defaultImportMap = {
    imports: {},
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
        return { imports: parsed.imports || {} };
      } catch {
        return defaultImportMap;
      }
    }

    const importMaps = Array.from(nodes).map(parseImportMap);

    // merge all import maps into a single object
    const mergedImportMap = importMaps.reduce((acc, curr) => {
      return {
        // first importmap has higher priority, later cannot override it
        imports: { ...curr.imports, ...acc.imports },
      };
    }, defaultImportMap);

    return mergedImportMap;
};
