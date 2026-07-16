
const workerPramsStr = location.hash.replace(/^#/, '');
const workerParams = workerPramsStr ? new URLSearchParams(workerPramsStr) : {};
const workerUrl = workerParams.get('workerUrl') || 'https://klesun.github.io/ts-browser/src/TranspileWorker.js';
const workerPath = workerUrl.replace(/\/[^/]+$/, '/');

const main = () => {
    self.importScripts(
        // 'https://unpkg.com/typescript@5.4.5/lib/typescript.js',
        'https://typescriptservices-min-js-builds.github.io/v5.4.5/dist/typescript.min.js',
        workerPath + '/UrlPathResolver_sideEffects.js',
        workerPath + '/actions/ParseTsModule_sideEffects.js'
    );
    const org = self.org;
    /** @type {ts} */
    const ts = self.ts;

    // keyed by referenceId - holds each pending parse's requestJsCode() closure
    // between the fast `parseTsModule_deps` response and the later, explicitly
    // driven `generateJsCode` request (which needs cyclicDepUrls, only knowable
    // in ts-browser.js once the whole dependency graph has been discovered)
    const pendingParses = new Map();

    const onmessage = (evt) => {
        const {data} = evt;
        const {messageType, messageData, referenceId} = data;
        if (messageType === 'parseTsModule') {
            const {isJsSrc, staticDependencies, dynamicDependencies, requestJsCode} =
                org.klesun.tsBrowser.ParseTsModule_sideEffects({
                    ...messageData, ts: ts,
                    addPathToUrl: org.klesun.tsBrowser.addPathToUrl,
                });
            pendingParses.set(referenceId, requestJsCode);
            self.postMessage({
                messageType: 'parseTsModule_deps',
                messageData: {isJsSrc, staticDependencies, dynamicDependencies},
                referenceId: referenceId,
            });
        } else if (messageType === 'generateJsCode') {
            const requestJsCode = pendingParses.get(referenceId);
            if (!requestJsCode) {
                throw new Error('generateJsCode: no pending parse for referenceId ' + referenceId);
            }
            pendingParses.delete(referenceId);
            const jsCode = requestJsCode(new Set(messageData.cyclicDepUrls));
            self.postMessage({
                messageType: 'generateJsCode_result',
                messageData: {jsCode},
                referenceId: referenceId,
            });
        }
    };

    self.onmessage = evt => {
        try {
            onmessage(evt);
        } catch (exc) {
            self.postMessage({
                messageType: 'error',
                messageData: {
                    message: exc.message,
                    stack: exc.stack,
                },
                referenceId: ((evt || {}).data || {}).referenceId,
            });
        }
    };
};

try {
    main();
    self.postMessage({
        messageType: 'ready',
    });
} catch (exc) {
    self.postMessage({
        messageType: 'error',
        messageData: {
            message: 'Failed to initialize worker - ' + exc,
            stack: exc.stack,
        },
    });
}
