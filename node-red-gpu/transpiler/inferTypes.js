'use strict';

// Type inference pass for JS→GLSL 450 compute shader transpiler.
// Walks the AST and annotates each expression node with node._glslType.
// Types: 'uint' | 'int' | 'float' | 'bool'

const DTYPE_MAP = {
    u8: 'uint', u16: 'uint', u32: 'uint',
    i8: 'int',  i16: 'int',  i32: 'int',
    f32: 'float', f64: 'float',
};

const MATH_FUNCTIONS = new Set([
    'abs', 'ceil', 'floor', 'round', 'sqrt', 'inversesqrt',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'exp', 'exp2', 'log', 'log2', 'pow',
    'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
    'fract', 'mod', 'sign', 'length', 'distance', 'dot', 'cross',
    'normalize', 'reflect', 'refract',
]);

const COMPARISON_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
const LOGICAL_OPS    = new Set(['&&', '||']);
const BITWISE_OPS    = new Set(['&', '|', '^', '<<', '>>']);

function inferTypes(ast, paramNames, options) {
    const scope = new Map();

    // Pre-populate scope with buffer parameter types
    const buffers = options.buffers || [];
    for (const buf of buffers) {
        scope.set(buf.name, DTYPE_MAP[buf.dtype] || 'float');
    }

    // Walk the AST body (array of statements)
    const stmts = Array.isArray(ast) ? ast : (ast.body || []);
    for (const stmt of stmts) {
        inferStmt(stmt);
    }

    // ── Statements ──────────────────────────────────────────────────────────

    function inferStmt(node) {
        if (!node) return;
        switch (node.type) {
            case 'VariableDeclaration':
                for (const decl of node.declarations) inferVarDeclarator(decl);
                break;
            case 'ExpressionStatement':
                inferExpr(node.expression);
                break;
            case 'ReturnStatement':
                if (node.argument) inferExpr(node.argument);
                break;
            case 'IfStatement':
                inferExpr(node.test);
                inferStmt(node.consequent);
                if (node.alternate) inferStmt(node.alternate);
                break;
            case 'BlockStatement':
                for (const s of node.body) inferStmt(s);
                break;
            case 'ForStatement':
                if (node.init)   inferStmt(node.init);
                if (node.test)   inferExpr(node.test);
                if (node.update) inferExpr(node.update);
                inferStmt(node.body);
                break;
            case 'WhileStatement':
                inferExpr(node.test);
                inferStmt(node.body);
                break;
            case 'BreakStatement':
            case 'ContinueStatement':
                break;
            default:
                // Unknown statement — try as expression
                if (node.expression) inferExpr(node.expression);
        }
    }

    function inferVarDeclarator(decl) {
        let t = 'float';
        if (decl.init) {
            inferExpr(decl.init);
            t = decl.init._glslType || 'float';
        }
        if (decl.id && decl.id.name) {
            scope.set(decl.id.name, t);
        }
        decl._glslType = t;
    }

    // ── Expressions ─────────────────────────────────────────────────────────

    function inferExpr(node) {
        if (!node) return;
        node._glslType = resolveExpr(node);
    }

    function resolveExpr(node) {
        if (!node) return 'float';
        switch (node.type) {

            // Literals
            case 'Literal': {
                const v = node.value;
                if (typeof v === 'boolean') return 'bool';
                if (typeof v === 'number') {
                    // Float if has decimal or exponent in raw source
                    const raw = node.raw || String(v);
                    if (raw.includes('.') || /e/i.test(raw)) return 'float';
                    return 'uint'; // integer literals default to uint (v1 rule)
                }
                return 'float';
            }

            // Identifiers
            case 'Identifier': {
                const t = scope.get(node.name);
                return t || 'float';
            }

            // Member expressions: this.thread.x/y/z, this.constants.NAME, buf[i]
            case 'MemberExpression': {
                return resolveMember(node);
            }

            // Assignment
            case 'AssignmentExpression': {
                inferExpr(node.right);
                const t = node.right._glslType || 'float';
                if (node.left.type === 'Identifier') {
                    scope.set(node.left.name, t);
                }
                inferExpr(node.left);
                return t;
            }

            // Binary
            case 'BinaryExpression': {
                inferExpr(node.left);
                inferExpr(node.right);
                const op = node.operator;
                if (COMPARISON_OPS.has(op)) return 'bool';
                if (BITWISE_OPS.has(op))    return 'uint';
                // Arithmetic: promote if mixed
                const lt = node.left._glslType  || 'float';
                const rt = node.right._glslType || 'float';
                if (lt === 'float' || rt === 'float') return 'float';
                if (lt === 'int'   || rt === 'int')   return 'int';
                return 'uint';
            }

            // Logical
            case 'LogicalExpression': {
                inferExpr(node.left);
                inferExpr(node.right);
                return 'bool';
            }

            // Unary
            case 'UnaryExpression': {
                inferExpr(node.argument);
                const op = node.operator;
                if (op === '!')  return 'bool';
                if (op === '~')  return 'uint';
                if (op === '-') {
                    const at = node.argument._glslType || 'float';
                    return at === 'uint' ? 'int' : at;
                }
                return node.argument._glslType || 'float';
            }

            // Update (++/--)
            case 'UpdateExpression': {
                inferExpr(node.argument);
                return node.argument._glslType || 'uint';
            }

            // Conditional / ternary
            case 'ConditionalExpression': {
                inferExpr(node.test);
                inferExpr(node.consequent);
                inferExpr(node.alternate);
                return node.consequent._glslType || 'float';
            }

            // Call expressions (Math.xxx, bare math funcs)
            case 'CallExpression': {
                for (const arg of node.arguments) inferExpr(arg);
                return resolveCall(node);
            }

            // Sequence expression — type of last
            case 'SequenceExpression': {
                for (const e of node.expressions) inferExpr(e);
                return node.expressions[node.expressions.length - 1]?._glslType || 'float';
            }

            default:
                return 'float';
        }
    }

    function resolveMember(node) {
        // this.thread.x / this.thread.y / this.thread.z / localX / localY / localZ → uint
        if (
            node.object?.type === 'MemberExpression' &&
            node.object.object?.type === 'ThisExpression' &&
            node.object.property?.name === 'thread'
        ) {
            const prop = node.property?.name;
            if (prop === 'localX' || prop === 'localY' || prop === 'localZ') {
                node._glslType = 'uint';
                return 'uint';
            }
            return 'uint';
        }

        // this.constants.NAME  → look up from options.constants
        if (
            node.object?.type === 'MemberExpression' &&
            node.object.object?.type === 'ThisExpression' &&
            node.object.property?.name === 'constants'
        ) {
            const cName = node.property?.name;
            if (cName && options.constants) {
                const dtype = options.constants[cName];
                if (dtype) return DTYPE_MAP[dtype] || 'float';
            }
            return 'float';
        }

        // bufferName[index]  — computed member access
        if (node.computed) {
            const objName = node.object?.name;
            if (objName) {
                const buf = buffers.find(b => b.name === objName);
                if (buf) {
                    if (node.index) inferExpr(node.index);
                    inferExpr(node.property); // Acorn uses property for computed
                    return DTYPE_MAP[buf.dtype] || 'float';
                }
            }
        }

        // Fallback: infer the object
        inferExpr(node.object);
        return node.object?._glslType || 'float';
    }

    function resolveCall(node) {
        const callee = node.callee;
        // barrier() — void return
        if (callee.type === 'Identifier' && callee.name === 'barrier') {
            return 'void';
        }
        // Type cast calls return their named type
        if (callee.type === 'Identifier') {
            const castTypes = { 'float': 'float', 'int': 'int', 'uint': 'uint' };
            if (castTypes[callee.name]) {
                node._glslType = castTypes[callee.name];
                // Still infer the argument
                if (node.arguments[0]) resolveExpr(node.arguments[0]);
                return node._glslType;
            }
        }
        // Atomic operations return the previous value (uint for u32 buffers, int for i32)
        if (callee.type === 'Identifier') {
            const atomicFuncs = new Set([
                'atomicAdd', 'atomicMin', 'atomicMax',
                'atomicOr', 'atomicAnd', 'atomicXor',
                'atomicExchange', 'atomicCompSwap',
            ]);
            if (atomicFuncs.has(callee.name)) {
                // Arguments are already inferred by the CallExpression case above
                // Return type matches the buffer element type
                const bufArg = node.arguments[0];
                if (bufArg && bufArg.type === 'Identifier') {
                    const bufType = scope.get(bufArg.name);
                    if (bufType) { node._glslType = bufType; return bufType; }
                }
                node._glslType = 'uint';
                return 'uint';
            }
        }
        // Math.xxx(...)  or bare identifier matching a math function name
        if (
            callee.type === 'MemberExpression' &&
            callee.object?.name === 'Math'
        ) {
            return 'float';
        }
        if (callee.type === 'Identifier' && MATH_FUNCTIONS.has(callee.name)) {
            return 'float';
        }
        return 'float';
    }
}

module.exports = { inferTypes };
