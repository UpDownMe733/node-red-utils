'use strict';

// Checks JS kernels on the CPU backend of node-red-gpu. Needs no Node-RED.
// If the Vulkan addon is built, also checks that Vulkan gives the same output.

process.env.NODE_RED_GPU_BACKEND = 'cpu';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeRedGpuWorker } = require('../node-red-gpu/index.js');
const { runKernels } = require('./helpers/gpu-kernels.js');

const ADDON = path.join(__dirname, '..', 'node-red-gpu', 'native', 'build', 'Release', 'gpu_addon.node');
const input = [0, 1, 2, 3, 4, 5, 6, 7];
let cpu;

it('JS kernels give the expected output on the CPU backend', async () => {
    cpu = await runKernels();
    assert.deepEqual(cpu.oneD, input.map(v => v * 2), 'anonymous function (a, b)');
    const twoD = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) twoD[x + y * 5] = x * 10 + y;
    assert.deepEqual(cpu.twoD, twoD, '2D return writes to x + y * count');
    const clamp = (v) => Math.min(Math.max(v, 2), 6);
    assert.deepEqual(cpu.math, input.map(v => (clamp(v) + 2 ** v) / 2 + Math.floor(v / 2)), 'clamp, exp2, mix and casts');
    assert.deepEqual(cpu.chain, input.map(v => (v + 1) * 2), 'dispatchChain');
    assert.deepEqual(cpu.specDefault, input.map(v => v * 2), 'spec constant default');
    assert.deepEqual(cpu.specChanged, input.map(v => v * 3), 'respecializeKernel');
});

it('atomics and barrier() throw at registration on the CPU backend', () => {
    const gpu = nodeRedGpuWorker();
    const buffers = [{ name: 'dst', dtype: 'u32' }];
    assert.throws(() => gpu.registerJsKernel('atomic', {
        kernel: function atomic(dst) { atomicAdd(dst, 0, 1); },
        buffers
    }), /atomicAdd\(\).*Vulkan/);
    assert.throws(() => gpu.registerJsKernel('sync', {
        kernel: function sync(dst) { barrier(); dst[this.thread.x] = 1; },
        buffers
    }), /barrier\(\).*Vulkan/);
    gpu.close();
});

it('GLSL reserved and built-in names, free variables and arrow functions throw at registration', () => {
    const gpu = nodeRedGpuWorker();
    const io = (name) => [{ name: 'a', dtype: 'u32', access: 'readonly' }, { name, dtype: 'u32', access: 'writeonly' }];
    const reg = (kernel, opts = {}) => () => gpu.registerJsKernel('k', { kernel, buffers: io('result'), ...opts });
    assert.throws(() => gpu.registerJsKernel('k', { kernel: function (a, output) { return a[this.thread.x]; }, buffers: io('output') }),
        /buffer name 'output' is a reserved word/);
    assert.throws(() => gpu.registerJsKernel('k', { kernel: function (a, gl_x) { return 1; }, buffers: io('gl_x') }), /'gl_x'/);
    assert.throws(reg(function (a, result) { return a[this.thread.x] * this.constants.texture; }, { constants: { texture: 'u32' } }),
        /constant name 'texture'/);
    assert.throws(reg(function (a, result) { const mix = a[this.thread.x]; return mix; }), /local variable name 'mix'/);
    assert.throws(reg(function (a, result) { let vec3 = 1; return vec3; }), /local variable name 'vec3'/);
    const scale = 3;
    assert.throws(reg(function (a, result) { return a[this.thread.x] * scale; }), /uses 'scale', which is not a buffer/);
    assert.throws(reg(function (a, result) { lookup[0] = 1; }), /'lookup' is not a buffer/);
    assert.throws(reg((a, result) => a[0]), /arrow function.*`function`/);
    // Allowed: buffers, locals, this.*, Math.*, casts
    gpu.registerJsKernel('ok', {
        kernel: function (a, result) { const v = float(a[this.thread.x]); for (let i = 0; i < 2; i++) result[i] = uint(Math.max(v, 1.0)); },
        buffers: io('result')
    });
    gpu.close();
});

it('a missing push constant throws at dispatch and names it', async () => {
    const gpu = nodeRedGpuWorker();
    const k = gpu.registerJsKernel('scale', {
        kernel: function (a, result) { return a[this.thread.x] * this.constants.k; },
        buffers: [{ name: 'a', dtype: 'u32', access: 'readonly' }, { name: 'result', dtype: 'u32', access: 'writeonly' }],
        constants: { k: 'u32' }, workgroupSize: 4
    });
    const bufs = [gpu.createBuffer(4, 'u32'), gpu.createBuffer(4, 'u32')];
    await assert.rejects(k.dispatch({ buffers: bufs, pushConstants: { k: 2 }, groups: 1 }), /'scale'.*'count'/);
    await assert.rejects(k.dispatch({ buffers: bufs, groups: 1 }), /'k', 'count'/);
    await assert.rejects(gpu.dispatchChain([{ kernel: k, buffers: bufs, pushConstants: { count: 4 }, groups: 1 }]), /'k'/);
    await assert.rejects(gpu.dispatchChain([{ kernelHandle: k._handle, buffers: bufs, groups: 1 }]), /spec 0 needs a kernel/);
    // countY and countZ may be left out
    bufs[0].view.set([1, 2, 3, 4]);
    await k.dispatch({ buffers: bufs, pushConstants: { count: 4, k: 2 }, groups: 1 });
    assert.deepEqual(Array.from(bufs[1].view), [2, 4, 6, 8]);
    gpu.close();
});

it('createBuffer can return a released buffer with its old contents', () => {
    const gpu = nodeRedGpuWorker();
    const a = gpu.createBuffer(4, 'u32');
    a.view.set([1, 2, 3, 4]);
    gpu.releaseBuffer(a);
    const b = gpu.createBuffer(4, 'u32');
    assert.equal(b, a);
    assert.deepEqual(Array.from(b.view), [1, 2, 3, 4], 'the README says that contents are not cleared');
    gpu.close();
});

it('the Vulkan fallback logs one line per process, and the cache follows the userDir', () => {
    // Without the addon, auto mode falls back to the CPU and logs the reason
    const script = `
        process.env.NODE_RED_GPU_BACKEND = 'auto';
        const { nodeRedGpu, nodeRedGpuWorker } = require(${JSON.stringify(path.join(__dirname, '..', 'node-red-gpu', 'index.js'))});
        const RED = { settings: { userDir: '/tmp/ud' }, log: { info: console.log, warn: console.warn } };
        const Node = nodeRedGpu(class {});
        const thisNode = { status() {}, error() {}, on() {} };
        new Node(RED, thisNode, {}); new Node(RED, thisNode, {});
        nodeRedGpuWorker().close(); nodeRedGpuWorker().close();
        console.log(process.env.NODE_RED_GPU_CACHE);`;
    const env = { ...process.env };
    delete env.NODE_RED_GPU_CACHE;
    const r = require('child_process').spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim().split('\n');
    assert.equal(out.pop(), path.join('/tmp/ud', 'gpu-cache'));
    if (fs.existsSync(ADDON)) {
        // With the addon, the device name is logged once
        assert.equal(out.length, 1, r.stdout);
        return assert.match(out[0], /^node-red-gpu: using Vulkan device ".+"$/);
    }
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^node-red-gpu: Vulkan is not available \(.*\)\. Using the CPU backend\.$/);
});

it('the Vulkan backend gives the same output as the CPU backend', (t) => {
    if (!fs.existsSync(ADDON)) return t.skip('Vulkan addon not built');
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'gpu-kernels.js')],
        { env: { ...process.env, NODE_RED_GPU_BACKEND: 'vulkan' }, encoding: 'utf8' });
    const vk = JSON.parse(stdout.trim().split('\n').pop());
    for (const key of Object.keys(cpu)) {
        if (key === 'math') {
            // GPU math functions may differ in the last bits
            vk.math.forEach((v, i) => assert.ok(Math.abs(v - cpu.math[i]) < 1e-3, `math[${i}]: ${v} vs ${cpu.math[i]}`));
        } else {
            assert.deepEqual(vk[key], cpu[key], key);
        }
    }
});
