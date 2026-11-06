'use strict';

// dtype → GLSL type string
function dtypeToGlsl(dtype) {
    switch (dtype) {
        case 'u8': case 'u16': case 'u32': return 'uint';
        case 'i8': case 'i16': case 'i32': return 'int';
        case 'f32': return 'float';
        case 'f64': return 'double';
        default: return dtype; // pass through if already a glsl type
    }
}

// Capitalize first letter
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Determine access qualifier string
function accessQualifier(access) {
    switch (access) {
        case 'readonly':  return 'readonly ';
        case 'writeonly': return 'writeonly ';
        case 'readwrite': return '';
        default:          return '';
    }
}

// Emit a GLSL type string from a _glslType annotation
function glslTypeStr(type) {
    if (!type) return 'float';
    switch (type) {
        case 'uint':   return 'uint';
        case 'int':    return 'int';
        case 'float':  return 'float';
        case 'double': return 'double';
        case 'bool':   return 'bool';
        default:       return type;
    }
}

// Format a numeric literal value for a given GLSL type
function formatLiteral(value, type) {
    if (type === 'uint') {
        return String(Math.trunc(value)) + 'u';
    }
    if (type === 'float' || type === 'double') {
        if (Number.isInteger(value)) {
            return String(value) + '.0';
        }
        return String(value);
    }
    return String(value);
}

// Math.* → GLSL builtin name
function mathFuncToGlsl(name) {
    const map = {
        abs: 'abs', ceil: 'ceil', floor: 'floor', round: 'round',
        sqrt: 'sqrt', log: 'log', log2: 'log2', exp: 'exp', exp2: 'exp2',
        pow: 'pow', min: 'min', max: 'max', clamp: 'clamp',
        sin: 'sin', cos: 'cos', tan: 'tan',
        asin: 'asin', acos: 'acos', atan: 'atan', atan2: 'atan',
        sign: 'sign', fract: 'fract', mix: 'mix', mod: 'mod',
        trunc: 'trunc',
    };
    return map[name] || name;
}

class GlslEmitter {
    constructor(paramNames, options) {
        this.paramNames = new Set(paramNames);
        this.options = options;
        this.indent = 0;

        // Find the first output buffer (readwrite or writeonly) for return-value writes
        const buffers = options.buffers || [];
        const outputBuf = buffers.find(b => b.access === 'readwrite' || b.access === 'writeonly');
        this.outputBufName = outputBuf ? outputBuf.name : (buffers[0] ? buffers[0].name : null);
    }

    pad() {
        return '    '.repeat(this.indent);
    }

    // Returns true if stmt is a direct assignment to the output buffer: outputBufName[expr] = expr
    _stmtWritesOutput(stmt) {
        if (stmt.type !== 'ExpressionStatement') return false;
        const expr = stmt.expression;
        if (expr.type !== 'AssignmentExpression') return false;
        const left = expr.left;
        if (left.type !== 'MemberExpression' || !left.computed) return false;
        if (left.object.type !== 'Identifier') return false;
        return left.object.name === this.outputBufName;
    }

    // Recursively scan a statement array for any direct output buffer write
    _scanForOutputWrite(stmts) {
        for (const stmt of stmts) {
            if (this._stmtWritesOutput(stmt)) return true;
            if (stmt.type === 'IfStatement') {
                const cons = stmt.consequent;
                if (cons && this._scanForOutputWrite(
                    cons.type === 'BlockStatement' ? cons.body : [cons]
                )) return true;
                const alt = stmt.alternate;
                if (alt && this._scanForOutputWrite(
                    alt.type === 'BlockStatement' ? alt.body : [alt]
                )) return true;
            }
            if (stmt.type === 'ForStatement' && stmt.body) {
                if (this._scanForOutputWrite(
                    stmt.body.type === 'BlockStatement' ? stmt.body.body : [stmt.body]
                )) return true;
            }
            if (stmt.type === 'BlockStatement') {
                if (this._scanForOutputWrite(stmt.body)) return true;
            }
        }
        return false;
    }

    emitProgram(ast) {
        // Find the kernel function body (first FunctionDeclaration or arrow in program)
        let body = null;
        for (const node of ast.body) {
            if (node.type === 'FunctionDeclaration') {
                body = node.body.body;
                break;
            }
            if (node.type === 'ExpressionStatement' &&
                node.expression.type === 'AssignmentExpression' &&
                node.expression.right.type === 'ArrowFunctionExpression') {
                body = node.expression.right.body.body;
                break;
            }
            if (node.type === 'VariableDeclaration') {
                const decl = node.declarations[0];
                if (decl && decl.init &&
                    (decl.init.type === 'ArrowFunctionExpression' ||
                     decl.init.type === 'FunctionExpression')) {
                    body = decl.init.body.body;
                    break;
                }
            }
        }
        if (!body) {
            throw new Error('emitGlsl: could not find kernel function body in AST');
        }

        // Detect if the kernel uses direct output buffer writes anywhere in the body.
        // If so, kernels are in "explicit output" mode: return expr just emits return;
        // (the return value is ignored; the kernel is responsible for its own output writes).
        this._hasDirectOutputWrite = this.outputBufName
            ? this._scanForOutputWrite(body)
            : false;

        const lines = [];
        const opts = this.options;
        const buffers = opts.buffers || [];
        const constants = opts.constants || {};
        const workgroupSize = opts.workgroupSize || 64;

        // Header
        lines.push('#version 450');
        // workgroupSize can be a number (1D) or [x, y] or [x, y, z]
        const wgs = Array.isArray(opts.workgroupSize) ? opts.workgroupSize : [opts.workgroupSize || 64];
        const wgsX = wgs[0] || 64;
        const wgsY = wgs[1] || 1;
        const wgsZ = wgs[2] || 1;
        let layoutStr = `layout(local_size_x = ${wgsX}`;
        if (wgsY > 1) layoutStr += `, local_size_y = ${wgsY}`;
        if (wgsZ > 1) layoutStr += `, local_size_z = ${wgsZ}`;
        layoutStr += ') in;';
        lines.push(layoutStr);
        lines.push('');

        // SSBO bindings and shared declarations
        const sharedDecls = [];
        let binding = 0;
        for (let i = 0; i < buffers.length; i++) {
            const buf = buffers[i];
            if (buf.shared) {
                // Emit as GLSL shared variable, not an SSBO
                const glslType = dtypeToGlsl(buf.dtype);
                sharedDecls.push(`shared ${glslType} ${buf.name}[${buf.count}];`);
                continue;
            }
            const glslType = dtypeToGlsl(buf.dtype);
            const qual = accessQualifier(buf.access);
            const blockName = capitalize(buf.name) + binding;
            lines.push(`layout(std430, binding = ${binding}) ${qual}buffer ${blockName} { ${glslType} ${buf.name}[]; };`);
            binding++;
        }
        if (binding > 0) lines.push('');
        for (const decl of sharedDecls) lines.push(decl);
        if (sharedDecls.length > 0) lines.push('');

        // Specialization constants — emitted before the push_constant block with layout(constant_id = N)
        const specConstantSet = new Set(
            Array.isArray(opts.specConstants) ? opts.specConstants : Object.keys(opts.specConstants || {})
        );
        let specId = 0;
        const constEntries = Object.entries(constants);
        for (const [name, dtype] of constEntries) {
            if (specConstantSet.has(name)) {
                lines.push(`layout(constant_id = ${specId++}) const ${dtypeToGlsl(dtype)} ${name} = ${dtypeToGlsl(dtype) === 'uint' ? '0u' : '0'};`);
            }
        }
        if (specId > 0) lines.push('');

        // Push constants — always emit count, countY, countZ for dispatch bounds
        // Spec constants are excluded from this block
        const pcConstEntries = constEntries.filter(([name]) => !specConstantSet.has(name));
        lines.push('layout(push_constant) uniform PC {');
        for (const [name, dtype] of pcConstEntries) {
            lines.push(`    ${dtypeToGlsl(dtype)} ${name};`);
        }
        lines.push('    uint count;');
        lines.push('    uint countY;');
        lines.push('    uint countZ;');
        lines.push('} pc;');
        lines.push('');

        // main()
        lines.push('void main() {');
        lines.push('    uint i_thread_x = gl_GlobalInvocationID.x;');
        lines.push('    uint i_thread_y = gl_GlobalInvocationID.y;');
        lines.push('    uint i_thread_z = gl_GlobalInvocationID.z;');
        // Same bounds and output index as the CPU backend: countY and countZ of 0 mean 1
        lines.push('    uint i_count_y = max(pc.countY, 1u);');
        lines.push('    if (i_thread_x >= pc.count || i_thread_y >= i_count_y || i_thread_z >= max(pc.countZ, 1u)) return;');
        lines.push('    uint i_out = i_thread_x + i_thread_y * pc.count + i_thread_z * pc.count * i_count_y;');
        lines.push('');

        this.indent = 1;
        for (const stmt of body) {
            const emitted = this.emitStatement(stmt);
            if (emitted) lines.push(emitted);
        }

        lines.push('}');
        return lines.join('\n') + '\n';
    }

    emitStatement(node) {
        const p = this.pad();
        switch (node.type) {
            case 'VariableDeclaration': {
                const results = [];
                for (const decl of node.declarations) {
                    const type = glslTypeStr(decl.init && decl.init._glslType);
                    const qualifier = node.kind === 'const' ? 'const ' : '';
                    const init = decl.init ? ` = ${this.emitExpr(decl.init)}` : '';
                    results.push(`${p}${qualifier}${type} ${decl.id.name}${init};`);
                }
                return results.join('\n');
            }
            case 'ExpressionStatement':
                return `${p}${this.emitExpr(node.expression)};`;
            case 'IfStatement': {
                const test = this.emitExpr(node.test);
                let s = `${p}if (${test}) {\n`;
                this.indent++;
                if (node.consequent.type === 'BlockStatement') {
                    for (const stmt of node.consequent.body) s += this.emitStatement(stmt) + '\n';
                } else {
                    s += this.emitStatement(node.consequent) + '\n';
                }
                this.indent--;
                s += `${p}}`;
                if (node.alternate) {
                    s += ` else {\n`;
                    this.indent++;
                    if (node.alternate.type === 'BlockStatement') {
                        for (const stmt of node.alternate.body) s += this.emitStatement(stmt) + '\n';
                    } else {
                        s += this.emitStatement(node.alternate) + '\n';
                    }
                    this.indent--;
                    s += `${p}}`;
                }
                return s;
            }
            case 'ForStatement': {
                const init = node.init ? this.emitForInit(node.init) : '';
                const test = node.test ? this.emitExpr(node.test) : '';
                const update = node.update ? this.emitExpr(node.update) : '';
                let s = `${p}for (${init}; ${test}; ${update}) {\n`;
                this.indent++;
                const bodyStmts = node.body.type === 'BlockStatement'
                    ? node.body.body : [node.body];
                for (const stmt of bodyStmts) s += this.emitStatement(stmt) + '\n';
                this.indent--;
                s += `${p}}`;
                return s;
            }
            case 'ReturnStatement': {
                if (node.argument && this.outputBufName) {
                    if (this._hasDirectOutputWrite) {
                        // Explicit-output kernel: kernel manages its own writes; ignore return value
                        return `${p}return;`;
                    }
                    const val = this.emitExpr(node.argument);
                    // Row-major index, as on the CPU backend
                    return `${p}${this.outputBufName}[i_out] = ${val};\n${p}return;`;
                }
                return `${p}return;`;
            }
            case 'BreakStatement':
                return `${p}break;`;
            case 'ContinueStatement':
                return `${p}continue;`;
            case 'BlockStatement': {
                let s = `${p}{\n`;
                this.indent++;
                for (const stmt of node.body) s += this.emitStatement(stmt) + '\n';
                this.indent--;
                s += `${p}}`;
                return s;
            }
            default:
                return `${p}/* unsupported: ${node.type} */`;
        }
    }

    // For-loop init can be a VariableDeclaration (without trailing semicolon) or expression
    emitForInit(node) {
        if (node.type === 'VariableDeclaration') {
            const decl = node.declarations[0];
            const type = glslTypeStr(decl.init && decl.init._glslType);
            const qualifier = node.kind === 'const' ? 'const ' : '';
            const init = decl.init ? ` = ${this.emitExpr(decl.init)}` : '';
            return `${qualifier}${type} ${decl.id.name}${init}`;
        }
        return this.emitExpr(node);
    }

    emitExpr(node) {
        if (!node) return '';
        switch (node.type) {
            case 'Literal': {
                if (typeof node.value === 'boolean') return node.value ? 'true' : 'false';
                if (typeof node.value === 'number') {
                    return formatLiteral(node.value, glslTypeStr(node._glslType));
                }
                return String(node.value);
            }
            case 'Identifier':
                return node.name;

            case 'BinaryExpression': {
                let op = node.operator;
                if (op === '===') op = '==';
                else if (op === '!==') op = '!=';

                const leftExpr = this.emitExpr(node.left);
                const rightExpr = this.emitExpr(node.right);

                // float mod → mod(left, right)
                if (op === '%') {
                    const ltype = node.left._glslType || '';
                    if (ltype === 'float' || ltype === 'double') {
                        return `mod(${leftExpr}, ${rightExpr})`;
                    }
                }
                return `(${leftExpr} ${op} ${rightExpr})`;
            }

            case 'UnaryExpression':
                return `${node.operator}(${this.emitExpr(node.argument)})`;

            case 'UpdateExpression': {
                const arg = this.emitExpr(node.argument);
                return node.prefix ? `${node.operator}${arg}` : `${arg}${node.operator}`;
            }

            case 'AssignmentExpression': {
                const left = this.emitExpr(node.left);
                const right = this.emitExpr(node.right);
                return `${left} ${node.operator} ${right}`;
            }

            case 'ConditionalExpression': {
                const test = this.emitExpr(node.test);
                const cons = this.emitExpr(node.consequent);
                const alt  = this.emitExpr(node.alternate);
                return `(${test} ? ${cons} : ${alt})`;
            }

            case 'MemberExpression': {
                // this.thread.x / this.thread.y / this.thread.z / localX / localY / localZ
                if (node.object.type === 'MemberExpression' &&
                    node.object.object.type === 'ThisExpression' &&
                    node.object.property.name === 'thread') {
                    const prop = node.property.name;
                    if (prop === 'localX') return 'gl_LocalInvocationID.x';
                    if (prop === 'localY') return 'gl_LocalInvocationID.y';
                    if (prop === 'localZ') return 'gl_LocalInvocationID.z';
                    // x/y/z → gl_GlobalInvocationID
                    return `gl_GlobalInvocationID.${prop}`;
                }
                // this.constants.NAME
                if (node.object.type === 'MemberExpression' &&
                    node.object.object.type === 'ThisExpression' &&
                    node.object.property.name === 'constants') {
                    const cname = node.property.name;
                    // Spec constants are standalone GLSL constants, not in the pc block
                    const specSet = new Set(
                        Array.isArray(this.options.specConstants)
                            ? this.options.specConstants
                            : Object.keys(this.options.specConstants || {})
                    );
                    if (specSet.has(cname)) return cname;
                    return `pc.${cname}`;
                }
                // paramName[expr] — computed member access on a buffer
                if (node.computed) {
                    const obj = this.emitExpr(node.object);
                    const prop = this.emitExpr(node.property);
                    return `${obj}[${prop}]`;
                }
                // generic dot access
                return `${this.emitExpr(node.object)}.${node.property.name}`;
            }

            case 'CallExpression': {
                // barrier() synchronization primitive
                if (node.callee.type === 'Identifier' && node.callee.name === 'barrier') {
                    return 'barrier()';
                }
                // Atomic operations: atomicAdd(buf, idx, val) → atomicAdd(buf[idx], val)
                if (node.callee.type === 'Identifier') {
                    const atomicFuncs = new Set([
                        'atomicAdd', 'atomicMin', 'atomicMax',
                        'atomicOr', 'atomicAnd', 'atomicXor',
                        'atomicExchange', 'atomicCompSwap',
                    ]);
                    if (atomicFuncs.has(node.callee.name)) {
                        const bufName = this.emitExpr(node.arguments[0]);
                        const index = this.emitExpr(node.arguments[1]);
                        if (node.callee.name === 'atomicCompSwap') {
                            const compare = this.emitExpr(node.arguments[2]);
                            const value = this.emitExpr(node.arguments[3]);
                            return `atomicCompSwap(${bufName}[${index}], ${compare}, ${value})`;
                        }
                        const value = this.emitExpr(node.arguments[2]);
                        return `${node.callee.name}(${bufName}[${index}], ${value})`;
                    }
                }
                // Type cast calls: float(x), int(x), uint(x)
                if (node.callee.type === 'Identifier') {
                    const castFuncs = new Set(['float', 'int', 'uint']);
                    if (castFuncs.has(node.callee.name)) {
                        return `${node.callee.name}(${this.emitExpr(node.arguments[0])})`;
                    }
                }
                // Math.func(args)
                if (node.callee.type === 'MemberExpression' &&
                    node.callee.object.type === 'Identifier' &&
                    node.callee.object.name === 'Math') {
                    const fn = node.callee.property.name;
                    const glslFn = mathFuncToGlsl(fn);
                    const args = node.arguments.map(a => this.emitExpr(a)).join(', ');
                    return `${glslFn}(${args})`;
                }
                // generic call
                const callee = this.emitExpr(node.callee);
                const args = node.arguments.map(a => this.emitExpr(a)).join(', ');
                return `${callee}(${args})`;
            }

            case 'LogicalExpression': {
                const lop = node.operator; // && / ||
                return `(${this.emitExpr(node.left)} ${lop} ${this.emitExpr(node.right)})`;
            }

            default:
                return `/* unsupported expr: ${node.type} */`;
        }
    }
}

/**
 * Emit a complete GLSL 450 compute shader string from a type-annotated ESTree AST.
 *
 * @param {object} ast       - ESTree program AST (from acorn) with _glslType annotations
 * @param {string[]} paramNames - ordered list of buffer parameter names
 * @param {object} options   - { buffers, constants, workgroupSize }
 * @returns {string} GLSL 450 shader source
 */
function emitGlsl(ast, paramNames, options) {
    const emitter = new GlslEmitter(paramNames, options);
    return emitter.emitProgram(ast);
}

module.exports = { emitGlsl };
