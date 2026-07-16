
var org = org || {};
org.klesun = org.klesun || {};
org.klesun.tsBrowser = org.klesun.tsBrowser || {};

/**
 * @param {ts.ImportClause} importClause - `{Field1, Field2}`
 */
const es6ToDestr = (tsCode, importClause) => {
    const {pos, end} = importClause;
    const text = tsCode.slice(pos, end);
    const {namedBindings = null, name = null} = importClause;
    if (namedBindings) {
        const {elements = [], name = null} = namedBindings;
        if (elements.length > 0) {
            // `import {A, B, C as Cc} from './module';`
            let items = [];
            for (let el of elements) {
                if (el.propertyName) {
                    // name as propertyName
                    items.push(el.propertyName.escapedText + ": " + el.name.escapedText);
                } else {
                    // just name
                    items.push(el.name.escapedText);
                }
            }
            if (importClause.name && importClause.name.escapedText) {
                // import Api, {createUuid} from "./modules/Api";
                items.push('default: ' + importClause.name.escapedText);
            }
            return 'const {' + items.join(", ") + "}";
        } else if (name && name.escapedText) {
            return 'const ' + name.escapedText;
        } else {
            const exc = new Error('Unsupported namedBindings');
            exc.data = {namedBindings, text};
            throw exc;
        }
    } else if (name && name.escapedText) {
        // `import DefaultClass from './module';`
        return 'const {default: ' + text + '}';
    } else {
        const exc = new Error('Unsupported importClause');
        exc.data = {importClause, text};
        throw exc;
    }
};

// still needed: es6ToDestr()+CACHE_LOADED are the fallback codegen for the
// specific import edges that close a circular-dependency cycle (see
// requestJsCode() below) - everything else goes through native import/export.
const CACHE_LOADED = 'ts-browser-loaded-modules';
const IMPORT_DYNAMIC = 'ts-browser-import-dynamic';
// keep in sync with the identical literal in ts-browser.js - materialize()
// there substitutes this token for a resolved Blob URL via string split/join.
const DEP_PLACEHOLDER_PREFIX = '__TSB_DEP__:';

/**
 * Swaps only the moduleSpecifier's source range inside a statement's own
 * full text (leading trivia/comments and everything else untouched), so the
 * emitted statement is still a real `import ... from "<newSpecifierLiteral>"`
 * that the native module linker binds for free.
 */
const replaceSpecifier = (statement, sourceFile, newSpecifierLiteral) => {
    const fullText = statement.getFullText(sourceFile);
    const stmtFullStart = statement.getFullStart();
    const spec = statement.moduleSpecifier;
    const specStart = spec.getStart(sourceFile) - stmtFullStart;
    const specEnd = spec.getEnd() - stmtFullStart;
    return fullText.slice(0, specStart) + newSpecifierLiteral + fullText.slice(specEnd);
};

const transformStatement = ({statement, sourceFile, baseUrl, ts, importMap}) => {
    const dynamicDependencies = [];

    const getNodeText = node => {
        return node.getFullText(sourceFile);
    };

    const resultParts = [];
    /** @param {ts.Node} node */
    const consumeAst = (node) => {
        if (ts.SyntaxKind[node.kind] === 'CallExpression' &&
            ts.SyntaxKind[(node.expression || {}).kind] === 'ImportKeyword' &&
            (node.arguments || []).length === 1
        ) {
            const arg = node.arguments[0];
            const isLiteral = ts.SyntaxKind[arg.kind] === 'StringLiteral';
            const bareMapped = isLiteral &&
                org.klesun.tsBrowser.isBareSpecifier(arg.text) &&
                !!importMap.imports[arg.text];

            if (bareMapped) {
                // leave the whole call untouched - native dynamic import()
                // resolves a bare specifier against the page's import map itself
                resultParts.push(getNodeText(node));
                return;
            }

            // Dynamic import targets (literal or computed) stay on today's exact
            // runtime-resolved rewrite for BOTH cases, unlike static imports - a
            // literal target could turn out to be a truly-legacy (non-ESM) .js
            // file, which has no Blob to embed as a static specifier at all, and
            // window[IMPORT_DYNAMIC] (ts-browser.js's importDynamic()) already
            // knows how to resolve either a real module or a legacy value. Only
            // the bare-mapped case above skips this - everything else, migrating
            // dynamic imports to the placeholder/Blob path is left as a follow-up.
            const ident = 'window[' + JSON.stringify(IMPORT_DYNAMIC) + ']';
            // the leading space is important, cuz transpiler glues `await` to `window` otherwise
            const newCallCode = ' ' + ident + '(' +
                getNodeText(arg) + ', ' +
                JSON.stringify(baseUrl) +
            ')';
            resultParts.push(newCallCode);
            const url = isLiteral ? org.klesun.tsBrowser.addPathToUrl(arg.text, baseUrl, importMap) : null;
            dynamicDependencies.push({
                url: url,
                ...(url ? {} : {
                    raw: getNodeText(arg),
                    kind: ts.SyntaxKind[arg.kind],
                }),
            });
            return;
        }
        const childCount = node.getChildCount(sourceFile);
        let hasChildren = childCount > 0;
        if (!hasChildren) { // leaf node
            resultParts.push(getNodeText(node));
        } else {
            let started = false;
            for (let i = 0; i < childCount; ++i) {
                const child = node.getChildAt(i, sourceFile);
                if (!started && child.pos > node.pos) {
                    // following JSDOC node contents are duplicated here for some
                    // reason, hope this check will cover all similar cases
                } else {
                    started = true;
                    consumeAst(child);
                }
            }
        }
    };
    const nodeText = getNodeText(statement);
    let tsCode;
    // processing the syntax tree here is awfully slow - about
    // same time as how long typescript takes to transpile it
    if (nodeText.match(/\bimport\(/)) {
        consumeAst(statement);
        tsCode = resultParts.join('');
    } else {
        tsCode = nodeText;
    }
    return {tsCode, dynamicDependencies};
};

/**
 * @param {ts} ts
 * @param {ts.CompilerOptions} compilerOptions
 * @param {import("../ImportMap").ImportMap} [importMap]
 */
org.klesun.tsBrowser.ParseTsModule_sideEffects = ({
    fullUrl, tsCode, compilerOptions, ts, addPathToUrl, importMap = {imports: {}},
}) => {
    const extension = fullUrl.replace(/^.*\./, '');
    const sourceFile = ts.createSourceFile(
        'ts-browser-generated-file.' + extension, tsCode, compilerOptions.target
    );
    const getNodeText = node => node.getFullText(sourceFile);

    const staticDependencies = [];
    const dynamicDependencies = [];
    // codegen for each top-level statement is decided lazily inside
    // requestJsCode(), once the caller (ts-browser.js) knows which of this
    // file's own dependency urls close a circular-dependency cycle - a plain
    // relative `import` cannot tell that from parsing this one file alone.
    const codegenPlan = [];

    for (const statement of sourceFile.statements) {
        const kindName = ts.SyntaxKind[statement.kind];
        if (kindName === 'ImportDeclaration') {
            const relPath = statement.moduleSpecifier.text;
            const {importClause = null} = statement;

            if (importClause && importClause.isTypeOnly) {
                // leaving a blank line so that stack trace matched original lines
                codegenPlan.push({kind: 'blank'});
                continue; // ignore `import type ...` statements
            }

            const bareMapped = org.klesun.tsBrowser.isBareSpecifier(relPath) &&
                !!importMap.imports[relPath];
            if (bareMapped) {
                // covered by a flat <script type="importmap"> entry - leave
                // completely untouched, browser resolves/fetches/integrity-checks
                // it itself, no dependency tracked at all
                codegenPlan.push({kind: 'literal', text: getNodeText(statement) + '\n'});
                continue;
            }

            const depUrl = addPathToUrl(relPath, fullUrl, importMap);
            staticDependencies.push({url: depUrl});
            if (!importClause) {
                // side-effectish `import './some/url.css';` - no binding, but the
                // statement itself must survive so the native module graph walk
                // still discovers and evaluates the dependency
                codegenPlan.push({kind: 'sideEffectImport', statement, depUrl});
            } else {
                codegenPlan.push({kind: 'boundImport', statement, importClause, depUrl});
            }
        } else {
            const transformed = transformStatement({
                statement, baseUrl: fullUrl, sourceFile, ts, importMap,
            });
            dynamicDependencies.push(...transformed.dynamicDependencies);
            codegenPlan.push({kind: 'literal', text: transformed.tsCode + '\n'});
        }
    }
    const isJsSrc = extension === 'js';

    /**
     * @param {Set<string>} cyclicDepUrls - this file's own staticDependencies
     *   urls that are known to close a circular-dependency cycle
     */
    const requestJsCode = (cyclicDepUrls = new Set()) => {
        let assembled = '';
        for (const plan of codegenPlan) {
            if (plan.kind === 'literal') {
                assembled += plan.text;
            } else if (plan.kind === 'blank') {
                assembled += '\n';
            } else if (plan.kind === 'sideEffectImport') {
                if (cyclicDepUrls.has(plan.depUrl)) {
                    // no binding to protect - materialize()'s cyclicFallbackTargets
                    // eager-import of the cyclic partner already guarantees this
                    // dependency gets evaluated, same as today's manual recursion did
                    assembled += '\n';
                } else {
                    assembled += replaceSpecifier(plan.statement, sourceFile,
                        JSON.stringify(DEP_PLACEHOLDER_PREFIX + plan.depUrl)) + '\n';
                }
            } else if (plan.kind === 'boundImport') {
                if (cyclicDepUrls.has(plan.depUrl)) {
                    // today's exact destructuring + CACHE_LOADED codegen, unchanged
                    const assignedValue = 'window[' + JSON.stringify(CACHE_LOADED) + '][' + JSON.stringify(plan.depUrl) + ']';
                    assembled += es6ToDestr(tsCode, plan.importClause) + ' = ' + assignedValue + ';\n';
                } else {
                    assembled += replaceSpecifier(plan.statement, sourceFile,
                        JSON.stringify(DEP_PLACEHOLDER_PREFIX + plan.depUrl)) + '\n';
                }
            }
        }
        return isJsSrc ? assembled : ts.transpile(assembled, {
            module: 5, // es6 imports
            ...compilerOptions,
        });
    };

    return {isJsSrc, staticDependencies, dynamicDependencies, requestJsCode};
};
