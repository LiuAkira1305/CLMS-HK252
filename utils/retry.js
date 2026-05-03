// utils/retry.js
// FIX: retry logic added — wraps any async operation with exponential backoff.

const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 200;    // 200ms, 400ms, 800ms
const OP_TIMEOUT_MS = 8000;   // 8 s hard limit per attempt

/**
 * Wraps a promise-returning function with retry + exponential backoff.
 * Throws only after all attempts are exhausted.
 *
 * @param {() => Promise<any>} fn        - The async function to retry
 * @param {string}             label     - Human-readable label for logging
 * @param {number}             [retries] - Max attempts (default MAX_RETRIES)
 */
async function withRetry(fn, label = 'operation', retries = MAX_RETRIES) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await withTimeout(fn(), label, OP_TIMEOUT_MS);
        } catch (err) {
            lastErr = err;
            const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
            console.warn(`[Retry] ${label} attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delay}ms.`);
            if (attempt < retries) await sleep(delay);
        }
    }
    console.error(`[Retry] ${label} failed after ${retries} attempts:`, lastErr.message);
    throw lastErr;
}

/**
 * Wraps a promise with a hard timeout.
 * Rejects if the promise does not resolve within `ms` milliseconds.
 *
 * @param {Promise<any>} promise
 * @param {string}       label
 * @param {number}       ms
 */
function withTimeout(promise, label, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)),
            ms
        );
        promise
            .then((v) => { clearTimeout(timer); resolve(v); })
            .catch((e) => { clearTimeout(timer); reject(e); });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { withRetry, withTimeout };
