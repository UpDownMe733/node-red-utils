/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const { workerData } = require('worker_threads');
const { pathToFileURL } = require('url');
const { NodeRedWorkerRuntime } = require('./NodeRedWorkerRuntime');

/**
 * Loads the worker file and returns its function.
 * CommonJS: module.exports = function (worker, data) {}. ES module: export default function (worker, data) {}.
 */
async function loadWorkerFunction(file) {
    let exported;
    try {
        exported = require(file);
    } catch (error) {
        // An ES module that require() cannot load (.mjs, or "type": "module")
        if (error.code !== 'ERR_REQUIRE_ESM' && error.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw error;
        exported = await import(pathToFileURL(file).href);
    }
    const func = typeof exported === 'function' ? exported : exported && exported.default;
    if (typeof func !== 'function') {
        throw new TypeError('the worker file must export a function (worker, data): ' +
            'module.exports = function (worker, data) {} or export default function (worker, data) {}');
    }
    return func;
}

/**
 * Sets up the worker environment and initializes communication
 */
function workerRuntimeLoader() {
    const nodeRedWorker = new NodeRedWorkerRuntime({
        ConnectionsCompleteCallback: async () => {
            try {
                const developerWorkerFunc = await loadWorkerFunction(workerData.workerFile);
                developerWorkerFunc(nodeRedWorker, workerData.myWorkerData);
            } catch (error) {
                // The main thread reports it on the node (log and red status)
                nodeRedWorker.parentPorts.publish('_workerError',
                    `${workerData.workerFile}: ${error && error.message ? error.message : String(error)}`);
            }
        }
    });

    return nodeRedWorker;
}

// This file is always run as a worker, so immediately set up the environment
workerRuntimeLoader();