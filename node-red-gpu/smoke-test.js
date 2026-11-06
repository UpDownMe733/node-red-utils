'use strict';

const { nodeRedGpuWorker } = require('./nodeRedGpuWorker.js');

const ADD_GLSL = `\
#version 450
layout(local_size_x = 256) in;
layout(std430, binding = 0) readonly  buffer A { uint a[]; };
layout(std430, binding = 1) readonly  buffer B { uint b[]; };
layout(std430, binding = 2) writeonly buffer O { uint o[]; };
layout(push_constant) uniform P { uint count; } p;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= p.count) return;
    o[i] = a[i] + b[i];
}`;

async function main() {
    const gpu = nodeRedGpuWorker();

    const kernel = gpu.registerKernel('addBuffers', {
        source: ADD_GLSL,
        language: 'glsl',
        bindings: ['readonly', 'readonly', 'writeonly'],
        pushConstants: { count: 'u32' },
        workgroupSize: 256,
        cpuFallback({ buffers: [a, b, out], pushConstants: p }) {
            for (let i = 0; i < p.count; i++) out[i] = a[i] + b[i];
        },
    });

    const N = 1024;
    const a = gpu.createBuffer(N, 'u32');
    const b = gpu.createBuffer(N, 'u32');
    const out = gpu.createBuffer(N, 'u32');

    a.view.set(Array.from({ length: N }, (_, i) => i));
    b.view.set(Array.from({ length: N }, (_, i) => i * 2));

    await kernel.dispatch({ buffers: [a, b, out], pushConstants: { count: N }, groups: Math.ceil(N / 256) });

    for (let i = 0; i < N; i++) {
        if (out.view[i] !== i + i * 2) throw new Error(`Mismatch at ${i}: got ${out.view[i]}, expected ${i + i * 2}`);
    }

    a.destroy();
    b.destroy();
    out.destroy();

    // Test 2: Dynamic loop bounds (transpiler)
    const dynKernel = gpu.registerJsKernel('dynamicLoop', {
        kernel: function(values, result) {
            let sum = 0;
            for (let j = 0; j < this.constants.loopCount; j++) {
                sum = sum + values[this.thread.x];
            }
            return sum;
        },
        buffers: [
            { name: 'values', dtype: 'u32', access: 'readonly' },
            { name: 'result', dtype: 'u32', access: 'writeonly' },
        ],
        constants: { loopCount: 'u32' },
        workgroupSize: 256,
    });

    const vals = gpu.createBuffer(N, 'u32');
    const dynOut = gpu.createBuffer(N, 'u32');
    vals.view.set(Array.from({ length: N }, (_, i) => i + 1));

    await dynKernel.dispatch({
        buffers: [vals, dynOut],
        pushConstants: { count: N, loopCount: 3 },
        groups: Math.ceil(N / 256),
    });

    for (let i = 0; i < N; i++) {
        const expected = (i + 1) * 3;
        if (dynOut.view[i] !== expected)
            throw new Error(`DynLoop mismatch at ${i}: got ${dynOut.view[i]}, expected ${expected}`);
    }

    vals.destroy();
    dynOut.destroy();

    await gpu.close();
    console.log('OK');
}

main().catch(err => { console.error(err); process.exit(1); });
