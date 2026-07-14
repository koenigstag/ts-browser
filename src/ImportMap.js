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

    // get first <script type="importmap"> node in the document
    const node = document.querySelector('script[type="importmap"]');

    try {
      return JSON.parse(node?.textContent || '{}').imports || defaultImportMap;
    } catch {
      return defaultImportMap;
    }
};
