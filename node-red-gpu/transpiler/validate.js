'use strict';

const { GpuCompileError } = require('../errors.js');
const { isReservedGlslName } = require('./glslNames.js');

const ALLOWED_BINARY_OPS = new Set([
  '+', '-', '*', '/', '%',
  '&', '|', '^', '<<', '>>',
  '==', '!=', '===', '!==',
  '<', '>', '<=', '>=',
  '&&', '||',
]);

const ALLOWED_UNARY_OPS = new Set(['-', '~', '!']);

const ALLOWED_ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<=', '>>=',
]);

const ATOMIC_FUNCS = new Set([
  'atomicAdd', 'atomicMin', 'atomicMax',
  'atomicOr', 'atomicAnd', 'atomicXor',
  'atomicExchange', 'atomicCompSwap',
]);

const ALLOWED_MATH_FUNCS = new Set([
  'abs', 'ceil', 'floor', 'round', 'sign',
  'min', 'max', 'clamp',
  'sqrt', 'pow', 'exp', 'exp2', 'log', 'log2',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'mix', 'step', 'smoothstep', 'fract', 'mod',
]);

const THREAD_PROPS = new Set(['x', 'y', 'z', 'localX', 'localY', 'localZ']);

function loc(node) {
  if (node.loc) {
    return `(line ${node.loc.start.line}, col ${node.loc.start.column})`;
  }
  return '';
}

function err(node, msg) {
  throw new GpuCompileError(
    `${msg} ${loc(node)}`.trim(),
    loc(node)
  );
}

function validateMemberExpression(node, paramNames) {
  // this.thread.x / this.thread.y / this.thread.z
  if (
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'ThisExpression' &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'thread' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    THREAD_PROPS.has(node.property.name)
  ) {
    return;
  }

  // this.constants.NAME
  if (
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'ThisExpression' &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'constants' &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return;
  }

  // Math.FUNC (validated further at CallExpression level)
  if (
    node.object.type === 'Identifier' &&
    node.object.name === 'Math' &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return;
  }

  // args[N][expr] — args is a special implicit buffer array
  if (
    node.computed &&
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'args' &&
    node.object.computed
  ) {
    walk(node.object.property, paramNames);
    walk(node.property, paramNames);
    return;
  }

  // paramName[expr] — direct buffer param access
  if (
    node.computed &&
    node.object.type === 'Identifier' &&
    paramNames.includes(node.object.name)
  ) {
    walk(node.property, paramNames);
    return;
  }

  if (node.computed && node.object.type === 'Identifier') {
    err(node, `'${node.object.name}' is not a buffer. Only buffers can be indexed, and a kernel cannot use variables from outside its function.`);
  }
  err(node, `Unsupported member expression on unknown object.`);
}

function validateCallExpression(node, paramNames) {
  // Allow barrier() call
  if (node.callee.type === 'Identifier' && node.callee.name === 'barrier') {
    if (node.arguments.length !== 0) err(node, 'barrier() takes no arguments');
    return;
  }

  // Allow type cast calls: float(x), int(x), uint(x)
  if (node.callee.type === 'Identifier') {
    const castFuncs = new Set(['float', 'int', 'uint']);
    if (castFuncs.has(node.callee.name)) {
      if (node.arguments.length !== 1) err(node, `${node.callee.name}() requires exactly 1 argument`);
      walk(node.arguments[0], paramNames);
      return;
    }
  }

  // Atomic operations: atomicAdd(buf, idx, val), atomicCompSwap(buf, idx, cmp, val)
  if (node.callee.type === 'Identifier' && ATOMIC_FUNCS.has(node.callee.name)) {
    if (node.arguments.length < 3)
      err(node, `${node.callee.name}(buffer, index, value) requires at least 3 arguments`);
    if (node.callee.name === 'atomicCompSwap' && node.arguments.length < 4)
      err(node, 'atomicCompSwap(buffer, index, compare, value) requires 4 arguments');
    for (const arg of node.arguments) walk(arg, paramNames);
    return;
  }

  if (
    node.callee.type !== 'MemberExpression' ||
    node.callee.object.type !== 'Identifier' ||
    node.callee.object.name !== 'Math' ||
    node.callee.computed ||
    node.callee.property.type !== 'Identifier'
  ) {
    err(node, `Only Math.* calls are allowed in kernel functions.`);
  }

  const funcName = node.callee.property.name;
  if (!ALLOWED_MATH_FUNCS.has(funcName)) {
    err(node, `Math.${funcName} is not a supported math function.`);
  }

  for (const arg of node.arguments) {
    walk(arg, paramNames);
  }
}

function walk(node, paramNames) {
  if (!node) return;

  switch (node.type) {
    case 'File':
      walk(node.program, paramNames);
      break;

    case 'Program':
      for (const stmt of node.body) walk(stmt, paramNames);
      break;

    case 'BlockStatement':
      for (const stmt of node.body) walk(stmt, paramNames);
      break;

    case 'ExpressionStatement':
      walk(node.expression, paramNames);
      break;

    case 'VariableDeclaration':
      if (node.kind === 'var') {
        err(node, `'var' declarations are not allowed; use 'let' or 'const'.`);
      }
      for (const decl of node.declarations) {
        if (decl.init) walk(decl.init, paramNames);
      }
      break;

    case 'AssignmentExpression':
      if (!ALLOWED_ASSIGN_OPS.has(node.operator)) {
        err(node, `Assignment operator '${node.operator}' is not supported.`);
      }
      walk(node.left, paramNames);
      walk(node.right, paramNames);
      break;

    case 'BinaryExpression':
    case 'LogicalExpression':
      if (!ALLOWED_BINARY_OPS.has(node.operator)) {
        err(node, `Binary operator '${node.operator}' is not supported.`);
      }
      walk(node.left, paramNames);
      walk(node.right, paramNames);
      break;

    case 'UnaryExpression':
      if (!ALLOWED_UNARY_OPS.has(node.operator)) {
        err(node, `Unary operator '${node.operator}' is not supported.`);
      }
      walk(node.argument, paramNames);
      break;

    case 'UpdateExpression':
      // ++ and -- only
      if (node.operator !== '++' && node.operator !== '--') {
        err(node, `Update operator '${node.operator}' is not supported.`);
      }
      walk(node.argument, paramNames);
      break;

    case 'ConditionalExpression':
      walk(node.test, paramNames);
      walk(node.consequent, paramNames);
      walk(node.alternate, paramNames);
      break;

    case 'IfStatement':
      walk(node.test, paramNames);
      walk(node.consequent, paramNames);
      if (node.alternate) walk(node.alternate, paramNames);
      break;

    case 'ForStatement': {
      if (node.init) {
        if (
          node.init.type === 'VariableDeclaration' &&
          node.init.kind === 'var'
        ) {
          err(node.init, `'var' declarations are not allowed in for-loop init; use 'let'.`);
        }
        if (
          node.init.type !== 'VariableDeclaration' &&
          node.init.type !== 'AssignmentExpression' &&
          node.init.type !== 'ExpressionStatement'
        ) {
          err(node.init, `For-loop init must be a let declaration or assignment expression.`);
        }
        walk(node.init, paramNames);
      }
      if (!node.test) {
        err(node, `For-loop must have a test condition.`);
      }
      if (!node.update) {
        err(node, `For-loop must have an update expression.`);
      }
      walk(node.test, paramNames);
      walk(node.update, paramNames);
      walk(node.body, paramNames);
      break;
    }

    case 'BreakStatement':
    case 'ContinueStatement':
      // Allowed inside for-loops; loop structure enforcement left to codegen
      break;

    case 'ReturnStatement':
      if (node.argument) walk(node.argument, paramNames);
      break;

    case 'MemberExpression':
      validateMemberExpression(node, paramNames);
      break;

    case 'CallExpression':
      validateCallExpression(node, paramNames);
      break;

    case 'Identifier':
      // Plain identifiers (variable names) are always allowed
      break;

    case 'Literal':
      if (typeof node.value === 'string') {
        err(node, `String literals are not allowed in kernel functions.`);
      }
      if (node.regex !== undefined) {
        err(node, `RegExp literals are not allowed in kernel functions.`);
      }
      // numeric literals (int / float) are fine
      break;

    case 'ThisExpression':
      // Allowed as part of this.thread.* / this.constants.*
      break;

    // --- Rejected constructs ---

    case 'WhileStatement':
    case 'DoWhileStatement':
      err(node, `'${node.type}' is not supported; use a for-loop.`);
      break;

    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      err(node, `Nested functions are not allowed in kernel functions.`);
      break;

    case 'ClassDeclaration':
    case 'ClassExpression':
      err(node, `Class declarations are not allowed in kernel functions.`);
      break;

    case 'TryStatement':
      err(node, `'try/catch' is not allowed in kernel functions.`);
      break;

    case 'ThrowStatement':
      err(node, `'throw' is not allowed in kernel functions.`);
      break;

    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ExportAllDeclaration':
      err(node, `Import/export declarations are not allowed in kernel functions.`);
      break;

    case 'TemplateLiteral':
    case 'TaggedTemplateExpression':
      err(node, `Template literals are not allowed in kernel functions.`);
      break;

    case 'ObjectExpression':
      err(node, `Object literals are not allowed in kernel functions.`);
      break;

    case 'ArrayExpression':
      err(node, `Array literals are not allowed in kernel functions.`);
      break;

    case 'NewExpression':
      err(node, `'new' expressions are not allowed in kernel functions.`);
      break;

    case 'AwaitExpression':
      err(node, `'await' is not allowed in kernel functions.`);
      break;

    case 'YieldExpression':
      err(node, `'yield' is not allowed in kernel functions.`);
      break;

    case 'ForInStatement':
      err(node, `'for...in' is not allowed in kernel functions; use a numeric for-loop.`);
      break;

    case 'ForOfStatement':
      err(node, `'for...of' is not allowed in kernel functions; use a numeric for-loop.`);
      break;

    case 'SwitchStatement':
      err(node, `'switch' is not allowed in kernel functions; use if/else.`);
      break;

    default:
      err(node, `Unsupported AST node type '${node.type}'.`);
  }
}

/**
 * Validate an acorn AST against the supported JS subset for GLSL 450 compute shader transpilation.
 *
 * @param {object} ast        - acorn AST node (Program or BlockStatement of the kernel function body)
 * @param {string[]} paramNames - names of buffer parameters declared for the kernel
 * @throws {GpuCompileError}  on first unsupported construct
 */
function validate(ast, paramNames, opts = {}) {
  walk(ast, paramNames || []);
  checkNames(ast, paramNames || [], opts);
}

/** Collect the names of all `let` and `const` variables in the kernel body. */
function collectLocals(node, locals = new Map()) {
  if (!node || typeof node !== 'object') return locals;
  if (node.type === 'VariableDeclarator') {
    if (node.id.type !== 'Identifier') err(node, 'Destructuring is not allowed in kernel functions.');
    locals.set(node.id.name, node.id);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => collectLocals(c, locals));
    else if (child && typeof child === 'object') collectLocals(child, locals);
  }
  return locals;
}

/** Find variable reads and writes that are not buffers or locals. */
function findFreeVariables(node, known, found = new Map()) {
  if (!node || typeof node !== 'object') return found;
  switch (node.type) {
    case 'Identifier':
      if (!known.has(node.name) && !found.has(node.name)) found.set(node.name, node);
      return found;
    case 'MemberExpression':
      // Math.x and this.* are allowed; a non-computed property is not a variable
      if (!(node.object.type === 'Identifier' && node.object.name === 'Math')) findFreeVariables(node.object, known, found);
      if (node.computed) findFreeVariables(node.property, known, found);
      return found;
    case 'CallExpression':
      // validate() allows only Math.*, casts, barrier() and atomics as callees
      if (node.callee.type !== 'Identifier') findFreeVariables(node.callee, known, found);
      node.arguments.forEach(a => findFreeVariables(a, known, found));
      return found;
    case 'VariableDeclarator':
      findFreeVariables(node.init, known, found);
      return found;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => findFreeVariables(c, known, found));
    else if (child && typeof child === 'object') findFreeVariables(child, known, found);
  }
  return found;
}

/**
 * Reject names that the CPU backend accepts but GLSL does not, and variables from
 * outside the kernel function, which the CPU backend cannot see either.
 */
function checkNames(ast, paramNames, opts) {
  const specNames = Array.isArray(opts.specConstants) ? opts.specConstants : Object.keys(opts.specConstants || {});
  const locals = collectLocals(ast);
  const named = [
    ...paramNames.map(n => [n, 'buffer']),
    ...Object.keys(opts.constants || {}).map(n => [n, 'constant']),
    ...specNames.map(n => [n, 'constant']),
    ...[...locals.keys()].map(n => [n, 'local variable']),
  ];
  for (const [name, kind] of named) {
    if (isReservedGlslName(name)) {
      const where = kind === 'local variable' ? ` ${loc(locals.get(name))}` : '';
      throw new GpuCompileError(`The ${kind} name '${name}' is a reserved word or built-in name in GLSL. Rename it.${where}`, where);
    }
  }
  const free = findFreeVariables(ast, new Set([...paramNames, ...locals.keys()]));
  if (free.size > 0) {
    const names = [...free.keys()].map(n => `'${n}'`).join(', ');
    const first = free.values().next().value;
    err(first, `The kernel uses ${names}, which ${free.size > 1 ? 'are not buffers or local variables' : 'is not a buffer or a local variable'}. ` +
      'A kernel cannot use variables from outside its function; pass values in this.constants.');
  }
}

module.exports = { validate, ATOMIC_FUNCS };
