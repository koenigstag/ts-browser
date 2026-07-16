
var org = org || {};
org.klesun = org.klesun || {};
org.klesun.tsBrowser = org.klesun.tsBrowser || {};

/**
 * bare specifier = neither root-relative (`/...`), absolute (`http(s)://...`),
 * nor dot-prefixed relative (`./...` / `../...`) - e.g. `react`, `lodash/debounce`.
 * Note: this project also historically allows omitting the `./` prefix for a
 * same-directory relative file (IDEA-style auto-import), so a "bare-looking"
 * specifier is only really bare if it's also not resolvable as a plain filename -
 * see addPathToUrl's import-map-first-else-relative-fallback logic below.
 */
org.klesun.tsBrowser.isBareSpecifier = (path) => {
    return !path.startsWith('.') &&
        !path.startsWith('/') &&
        !path.match(/^https?:\/\//);
};

/**
 * @param {string} path
 * @param {string} baseUrl
 * @param {import("./ImportMap").ImportMap} importMap
 * @returns {string}
 */
org.klesun.tsBrowser.addPathToUrl = (path, baseUrl, importMap = {imports: {}}) => {
    let result;
    if (path.startsWith('/') || path.match(/^https?:\/\//)) {
        // full path from the site root
        result = path;
    } else if (org.klesun.tsBrowser.isBareSpecifier(path) && importMap.imports[path]) {
        // resolved via <script type="importmap"> - a specifier without a "./" prefix
        // that ISN'T in the import map falls through to the relative-path branch below
        // instead of throwing, since this project also treats a dot-less specifier as
        // a same-directory relative file (see tests/UrlPathResolverTest.js "ServApi" case)
        result = importMap.imports[path];
    } else {
        const urlParts = baseUrl.split('/');
        const pathParts = path.split('/');

        if (urlParts.slice(-1)[0] !== '') {
            // does not end with a slash - script, not directory
            urlParts.pop();
        }

        // getting rid of trailing slashes if any
        while (pathParts[0] === '') pathParts.shift();
        while (urlParts.slice(-1)[0] === '') urlParts.pop();

        const resultParts = [...urlParts];
        for (const pathPart of pathParts) {
            if (pathPart === '..' && resultParts.slice(-1)[0] !== '..') {
                while (resultParts.slice(-1)[0] === '.') resultParts.pop();
                if (resultParts.length > 0) {
                    resultParts.pop();
                } else {
                    resultParts.push('..');
                }
            } else if (pathPart !== '.') {
                resultParts.push(pathPart);
            }
        }
        result = resultParts.join('/') || '.';
    }

    return result;
};

const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorker) {
    self.org = org;
} else {
    window.org = org;
}