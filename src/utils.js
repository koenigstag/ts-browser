
/** kudos to https://stackoverflow.com/a/37235274/2750743 */
export const oneSuccess = (promises) => {
    return Promise.all(promises.map(p => {
        // If a request fails, count that as a resolution so it will keep
        // waiting for other possible successes. If a request succeeds,
        // treat it as a rejection so Promise.all immediately bails out.
        return p.then(
            val => Promise.reject(val),
            err => Promise.resolve(err)
        );
    })).then(
        // If '.all' resolved, we've just got an array of errors - wrap them in
        // a real Error (an array has no .message, which makes failures like
        // "file not found under any extension" show up as "undefined" to callers)
        errors => {
            const combined = new Error('All ' + errors.length + ' attempts failed: ' +
                errors.map(e => (e && e.message) || String(e)).join('; '));
            combined.errors = errors;
            return Promise.reject(combined);
        },
        // If '.all' rejected, we've got the result we wanted.
        val => Promise.resolve(val)
    );
};