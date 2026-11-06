'use strict';

const { nodeRedGpu } = require('./nodeRedGpuMain.js');
const { nodeRedGpuWorker } = require('./nodeRedGpuWorker.js');

module.exports = { nodeRedGpu, nodeRedGpuWorker };
