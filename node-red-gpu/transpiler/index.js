'use strict';

const acorn = require('acorn');
const { validate, ATOMIC_FUNCS } = require('./validate.js');
const { inferTypes } = require('./inferTypes.js');
const { emitGlsl } = require('./emitGlsl.js');
const { GpuCompileError } = require('../errors.js');

/**
 * Find calls that only the GPU can honor: barrier() and the atomics.
 * @returns {Set<string>} the names of the calls found
 */
function findGpuOnlyCalls(node, found = new Set()) {
    if (!node || typeof node !== 'object') return found;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
        (node.callee.name === 'barrier' || ATOMIC_FUNCS.has(node.callee.name))) {
        found.add(node.callee.name + '()');
    }
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(c => findGpuOnlyCalls(c, found));
        else if (child && typeof child === 'object') findGpuOnlyCalls(child, found);
    }
    return found;
}

/**
 * Transpile a JS kernel function to a GLSL 450 compute shader string.
 *
 * @param {Function|string} fn  - kernel function or its .toString() source
 * @param {object} options      - { buffers, constants, output, workgroupSize }
 * @returns {{ glsl: string, gpuOnlyCalls: Set<string> }} GLSL 450 compute shader source,
 *          and the calls that the CPU backend cannot run
 * @throws {GpuCompileError} on unsupported constructs or transpilation errors
 */
function transpile(fn, options) {
    const fnString = typeof fn === 'function' ? fn.toString() : fn;
    const opts = options || {};

    // Extract parameter names from the function signature
    const paramNames = (opts.buffers || []).map(b => b.name);

    // Parse the function as an expression. This accepts named and anonymous
    // functions, also `function (a, b)` with a space.
    const source = `const __kernel = (${fnString.trim()});`;

    let ast;
    try {
        ast = acorn.parse(source, {
            ecmaVersion: 2020,
            sourceType: 'script',
            locations: true,
        });
    } catch (e) {
        throw new GpuCompileError(`Failed to parse kernel function: ${e.message}`, e.message);
    }

    // Extract the function body from the AST
    const init = ast.body[0].declarations[0].init;
    if (init.type === 'ArrowFunctionExpression') {
        // An arrow function has no own `this`, so this.thread and this.constants fail on the CPU backend
        throw new GpuCompileError('The kernel is an arrow function. Use a `function` expression: arrow functions have no `this`.');
    }
    const funcBody = init.type === 'FunctionExpression' ? init.body : null;

    if (!funcBody || !funcBody.body) {
        throw new GpuCompileError('Could not extract function body from kernel source');
    }

    // Validate the AST (throws on unsupported constructs)
    validate(funcBody, paramNames, opts);

    // Infer GLSL types on AST nodes
    inferTypes(funcBody, paramNames, opts);

    // Emit the complete GLSL 450 compute shader
    return { glsl: emitGlsl(ast, paramNames, opts), gpuOnlyCalls: findGpuOnlyCalls(funcBody) };
}

module.exports = { transpile };
