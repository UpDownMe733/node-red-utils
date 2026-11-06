'use strict';

// JS kernels that run the same on every GPU backend. The backend comes from
// NODE_RED_GPU_BACKEND. Run this file directly to print the results as JSON.

const { nodeRedGpuWorker } = require('../../node-red-gpu/index.js');

async function run(gpu, kernel, specs, count, countY = 1, groupsY = 1) {
    const bufs = specs.map(([dtype, init]) => {
        const b = gpu.createBuffer(count * countY, dtype);
        if (init) b.view.set(init);
        return b;
    });
    await kernel.dispatch({ buffers: bufs, pushConstants: { count, countY }, groups: Math.ceil(count / 4), groupsY });
    return Array.from(bufs[bufs.length - 1].view);
}

const io = (dtype) => [{ name: 'a', dtype, access: 'readonly' }, { name: 'result', dtype, access: 'writeonly' }];

async function runKernels() {
    const gpu = nodeRedGpuWorker();
    const results = {};
    const input = [0, 1, 2, 3, 4, 5, 6, 7];

    // 1D, anonymous function with a space before the parenthesis
    const double = gpu.registerJsKernel('double', {
        kernel: function (a, result) { return a[this.thread.x] * 2; },
        buffers: io('u32'), workgroupSize: 4
    });
    results.oneD = await run(gpu, double, [['u32', input], ['u32']], 8);

    // 2D: return writes to x + y * count
    const twoD = gpu.registerJsKernel('twoD', {
        kernel: function twoD(a, result) { return this.thread.x * 10 + this.thread.y; },
        buffers: io('u32'), workgroupSize: [4, 4]
    });
    results.twoD = await run(gpu, twoD, [['u32'], ['u32']], 5, 3);

    // GLSL-only math calls and casts
    const math = gpu.registerJsKernel('math', {
        kernel: function math(a, result) {
            const v = a[this.thread.x];
            return Math.mix(Math.clamp(v, 2.0, 6.0), Math.exp2(v), 0.5) + float(uint(v * 0.5));
        },
        buffers: io('f32'), workgroupSize: 4
    });
    results.math = await run(gpu, math, [['f32', input], ['f32']], 8);

    // Two kernels in one chain: the second reads what the first wrote
    const addOne = gpu.registerJsKernel('addOne', {
        kernel: function addOne(a, result) { return a[this.thread.x] + 1; },
        buffers: io('u32'), workgroupSize: 4
    });
    const [a, mid, out] = ['u32', 'u32', 'u32'].map(t => gpu.createBuffer(8, t));
    a.view.set(input);
    const pc = { count: 8, countY: 1 };
    await gpu.dispatchChain([
        { kernel: addOne, buffers: [a, mid], pushConstants: pc, groups: 2 },
        { kernel: double, buffers: [mid, out], pushConstants: pc, groups: 2 }
    ]);
    results.chain = Array.from(out.view);

    // Spec constant: the default, then a new value
    const scale = gpu.registerJsKernel('scale', {
        kernel: function scale(a, result) { return a[this.thread.x] * this.constants.k; },
        buffers: io('u32'), constants: { k: 'u32' },
        specConstants: { k: { dtype: 'u32', default: 2 } }, workgroupSize: 4
    });
    results.specDefault = await run(gpu, scale, [['u32', input], ['u32']], 8);
    gpu.respecializeKernel(scale, { k: 3 });
    results.specChanged = await run(gpu, scale, [['u32', input], ['u32']], 8);

    await gpu.close();
    return results;
}

module.exports = { runKernels };

if (require.main === module) {
    runKernels().then(r => console.log(JSON.stringify(r)), (err) => { console.error(err); process.exit(1); });
}
