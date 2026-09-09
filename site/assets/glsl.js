/**
 * Shared GLSL chunks.
 *
 * Two programs on this page need the same noise and the same colour helpers:
 * the fullscreen silk gradient, and the refractive glass form drawn over it.
 * They have to agree exactly - the glass refracts the gradient by re-evaluating
 * it at an offset coordinate rather than by sampling a texture of it, so if the
 * two copies of the noise ever drifted the refraction would show a DIFFERENT
 * gradient through the glass than the one behind it, which is the one artifact
 * that would give the whole effect away.
 *
 * ON LYGIA. The obvious move here is `#include "lygia/generative/snoise.glsl"`.
 * It is not used, and the reason is licensing rather than taste: LYGIA is
 * dual-licensed under the Prosperity License and a Patron License for sponsors,
 * and Prosperity restricts commercial use. This is a public product page, so
 * vendoring it would be a licence question nobody wants attached to a privacy
 * project. LYGIA also resolves `#include` either through a bundler or through a
 * request to lygia.xyz, and this site has no bundler and makes no third-party
 * request by design.
 *
 * What is used instead is the same primitive LYGIA itself vendors: Ashima Arts /
 * Stefan Gustavson simplex noise, which is MIT and carries its attribution
 * below. The fbm, warp, lighting and colour code is written here.
 */

/**
 * Simplex 3D noise.
 * Ashima Arts / Stefan Gustavson. MIT. Keep this attribution.
 */
export const NOISE_GLSL = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

const mat3 FBM_M = mat3( 0.00,  0.80,  0.60,
                        -0.80,  0.36, -0.48,
                        -0.60, -0.48,  0.64 );

float fbm3(vec3 p){
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++){ s += a * snoise(p); p = FBM_M * p * 1.9; a *= 0.45; }
  return s;
}
float fbm2(vec3 p){
  float s = 0.0, a = 0.6;
  for (int i = 0; i < 2; i++){ s += a * snoise(p); p = FBM_M * p * 1.95; a *= 0.4; }
  return s;
}`;

/** sRGB transfer functions and a cheap hash, shared by both programs. */
export const COLOR_GLSL = `
vec3 srgbToLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

/**
 * The silk field itself, as a FUNCTION of a screen-space coordinate.
 *
 * Pulled out of `main` so the glass program can call it with a refracted
 * coordinate. `silkField(p, t)` is the single definition of what the gradient
 * looks like anywhere on this page; both programs call it and neither
 * reimplements it.
 */
export const FIELD_GLSL = `
vec3 silkField(vec2 p, float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3,
               float uScale, float uWarp, float uSpecular, float uSaturation,
               out float outHeight){
  const float A = 0.42;
  vec2 pr = mat2(cos(A), -sin(A), sin(A), cos(A)) * p;
  vec2 sp = pr * vec2(uScale * 0.62, uScale * 1.35);

  vec3 base = vec3(sp + vec2(t * 0.55, t * 0.12), t);

  vec2 q = vec2(fbm2(base), fbm2(base + vec3(3.1, 7.4, 0.25)));
  float h = fbm3(base + uWarp * vec3(q, 0.0));
  outHeight = h;

  float band  = smoothstep(-1.15, 1.15, pr.x * 1.15 + 0.85 * q.x);
  float lift  = smoothstep(-0.35, 0.95, h * 1.7 + 0.35 * q.y);
  float crest = smoothstep( 0.52, 1.18, h * 1.4 + 0.45 * q.y + 0.30);

  vec3 col = mix(c0, c1, band);
  col = mix(col, c2, lift * 0.78);
  col = mix(col, c3, pow(crest, 2.6) * 0.78);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  return col;
}`;
