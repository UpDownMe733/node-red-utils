'use strict';

// The backend choice is logged once per process, not once per node or worker
let logged = false;

/** Call log(message) the first time only. */
function logBackendOnce(log, message) {
    if (logged) return;
    logged = true;
    log(message);
}

/** The fallback message: the first line of the error, without the require stack. */
function fallbackMessage(err) {
    return `node-red-gpu: Vulkan is not available (${String(err.message).split('\n')[0]}). Using the CPU backend.`;
}

module.exports = { logBackendOnce, fallbackMessage };
