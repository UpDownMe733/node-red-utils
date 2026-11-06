'use strict';

// Names that a JS kernel must not use for a buffer, a constant or a local variable.
// The CPU backend accepts them, but glslangValidator rejects them (or the generated
// GLSL breaks), so the check runs at registration on every backend.

// GLSL 4.50 keywords and words reserved for future use (spec section 3.6)
const KEYWORDS = `
const uniform buffer shared attribute varying coherent volatile restrict readonly writeonly
atomic_uint layout centroid flat smooth noperspective patch sample invariant precise
break continue do for while switch case default if else subroutine in out inout
int void bool true false float double discard return uint struct lowp mediump highp precision
common partition active asm class union enum typedef template this resource goto inline noinline
public static extern external interface long short half fixed unsigned superp input output
filter sizeof cast namespace using sampler sampler3DRect`;

// Built-in functions. A local with one of these names hides the function, and the
// transpiler emits calls such as min(), max() and mix() for Math.* calls.
const BUILTIN_FUNCTIONS = `
radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh
pow exp log exp2 log2 sqrt inversesqrt
abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep
isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat fma frexp ldexp
packUnorm2x16 packSnorm2x16 packUnorm4x8 packSnorm4x8 unpackUnorm2x16 unpackSnorm2x16
unpackUnorm4x8 unpackSnorm4x8 packHalf2x16 unpackHalf2x16 packDouble2x32 unpackDouble2x32
length distance dot cross normalize faceforward reflect refract
matrixCompMult outerProduct transpose determinant inverse
lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not
uaddCarry usubBorrow umulExtended imulExtended bitfieldExtract bitfieldInsert bitfieldReverse
bitCount findLSB findMSB
textureSize textureQueryLod textureQueryLevels textureSamples texture textureProj textureLod
textureOffset texelFetch texelFetchOffset textureProjOffset textureLodOffset textureProjLod
textureProjLodOffset textureGrad textureGradOffset textureProjGrad textureProjGradOffset
textureGather textureGatherOffset textureGatherOffsets
atomicCounterIncrement atomicCounterDecrement atomicCounter atomicCounterAdd atomicCounterSubtract
atomicCounterMin atomicCounterMax atomicCounterAnd atomicCounterOr atomicCounterXor
atomicCounterExchange atomicCounterCompSwap
atomicAdd atomicMin atomicMax atomicAnd atomicOr atomicXor atomicExchange atomicCompSwap
imageSize imageSamples imageLoad imageStore imageAtomicAdd imageAtomicMin imageAtomicMax
imageAtomicAnd imageAtomicOr imageAtomicXor imageAtomicExchange imageAtomicCompSwap
dFdx dFdy dFdxFine dFdyFine dFdxCoarse dFdyCoarse fwidth fwidthFine fwidthCoarse
interpolateAtCentroid interpolateAtSample interpolateAtOffset noise1 noise2 noise3 noise4
EmitStreamVertex EndStreamPrimitive EmitVertex EndPrimitive
barrier memoryBarrier memoryBarrierAtomicCounter memoryBarrierBuffer memoryBarrierShared
memoryBarrierImage groupMemoryBarrier`;

// Names in the GLSL that the transpiler generates
const GENERATED = 'main pc i_thread_x i_thread_y i_thread_z i_count_y i_out';

const RESERVED = new Set(`${KEYWORDS} ${BUILTIN_FUNCTIONS} ${GENERATED}`.split(/\s+/).filter(Boolean));

// Vector, matrix, sampler and image type names
const RESERVED_PATTERN = /^(gl_|[ibudhf]?vec[234]$|d?mat[234](x[234])?$|[iu]?(sampler|image|texture)[0-9A-Z]|[iu]?subpassInput)|__/;

/** Return true if `name` cannot be used as a GLSL identifier in a JS kernel. */
function isReservedGlslName(name) {
    return RESERVED.has(name) || RESERVED_PATTERN.test(name);
}

module.exports = { isReservedGlslName };
