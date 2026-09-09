/**
 * SILK - the animated gradient behind the hero and the closing panel.
 *
 * This is a hand-written WebGL2 fullscreen-quad fragment shader, not a library.
 * The look it targets is shadergradient's `plane` preset, which is a lit 3D mesh
 * (three.js + React Three Fiber + an HDRI environment map). Measured, that stack
 * costs about 313 KB gzipped and roughly 180 ms of extra main-thread script
 * before the hero paints; this file is under 3 KB gzipped and makes no network
 * request of any kind - which matters on a site whose footer invites you to open
 * devtools and count them.
 *
 * The trick is that the mesh in shadergradient exists only to turn one noise
 * value into a surface a light can hit. A fragment shader gets there directly:
 * keep the scalar height field, synthesise the normal from its screen-space
 * derivative (free - dFdx/dFdy are core in GLSL ES 3.00), and light it with one
 * Blinn-Phong term. No geometry, no lights, no environment map, one draw call of
 * three vertices.
 *
 * FOUR THINGS HERE ARE LOAD-BEARING AND LOOK LIKE DETAILS:
 *
 * 1. ONE octave of domain warp. Two gives marble; three gives an oil slick. The
 *    reference look is enormous soft blobs, not fractal detail.
 * 2. The specular highlight is tinted toward the lightest colour stop. A WHITE
 *    highlight desaturates the whole frame into grey satin.
 * 3. The normal's z is flattened to 22. A steep normal turns the sheen into
 *    glitter.
 * 4. A hash dither of ~1.2/255. A large smooth gradient bands visibly on an
 *    8-bit display without it, and anything above ~2/255 reads as dirt once the
 *    low-resolution buffer is upscaled.
 *
 * `#version 300 es` MUST be the first byte of the shader source. A newline after
 * the backtick fails to compile with an error that does not mention newlines.
 */

const VERT = `#version 300 es
// A single oversized triangle. Cheaper than a quad and needs no attributes:
// gl_VertexID indexes a constant array, so there is no buffer to bind.
void main(){
  vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform float uScale;
uniform float uWarp;
uniform float uSpecular;
uniform float uBrightness;
uniform float uVignette;
uniform float uSaturation;

// ---------------------------------------------------------------- simplex 3D
// Ashima Arts / Stefan Gustavson, MIT. Keep this attribution.
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

// ------------------------------------------------------------------- fbm
const mat3 M = mat3( 0.00,  0.80,  0.60,
                    -0.80,  0.36, -0.48,
                    -0.60, -0.48,  0.64 );

float fbm3(vec3 p){
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++){ s += a * snoise(p); p = M * p * 1.9; a *= 0.45; }
  return s;
}
float fbm2(vec3 p){
  float s = 0.0, a = 0.6;
  for (int i = 0; i < 2; i++){ s += a * snoise(p); p = M * p * 1.95; a *= 0.4; }
  return s;
}

// ------------------------------------------------------------------ colour
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
}

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag - 0.5 * uResolution) / uResolution.y;

  float t = uTime;

  // Rotated, anisotropic sample space. This is what makes the folds read as
  // long diagonal drapes rather than as round blobs.
  const float A = 0.42;
  vec2 pr = mat2(cos(A), -sin(A), sin(A), cos(A)) * p;
  vec2 sp = pr * vec2(uScale * 0.62, uScale * 1.35);

  // The xy drift makes it FLOW; the z makes it EVOLVE. Only z boils in place;
  // only xy scrolls a rigid texture past. It needs both.
  vec3 base = vec3(sp + vec2(t * 0.55, t * 0.12), t);

  // ONE level of domain warp.
  vec2 q = vec2(fbm2(base),
                fbm2(base + vec3(3.1, 7.4, 0.25)));

  float h = fbm3(base + uWarp * vec3(q, 0.0));

  // Surface normal from the height field, via screen-space derivatives. The
  // large z flattens it - a steep normal turns the sheen into glitter.
  // The slope is CLAMPED. At an isolated noise discontinuity the derivative
  // spikes, the normal tips almost side-on, and the Blinn-Phong term returns a
  // near-1.0 highlight in a single fragment - which the 0.55 upscale then blows
  // into a visible white speck sitting on the silk like dust on a lens. Bounding
  // the tilt costs nothing and removes them; the folds are all well inside it.
  float sx = clamp(dFdx(h) * uResolution.y, -4.0, 4.0);
  float sy = clamp(dFdy(h) * uResolution.y, -4.0, 4.0);
  vec3  n  = normalize(vec3(-sx, -sy, 22.0));

  // Colour mixing, in LINEAR light. Three independent ramps: band spreads
  // colour across the sheet, lift and crest key off the height so the troughs
  // stay dark and only the folds catch the light.
  vec3 c0 = srgbToLinear(uColor0);
  vec3 c1 = srgbToLinear(uColor1);
  vec3 c2 = srgbToLinear(uColor2);
  vec3 c3 = srgbToLinear(uColor3);

  float band  = smoothstep(-1.15, 1.15, pr.x * 1.15 + 0.85 * q.x);
  float lift  = smoothstep(-0.35, 0.95, h * 1.7 + 0.35 * q.y);
  float crest = smoothstep( 0.52, 1.18, h * 1.4 + 0.45 * q.y + 0.30);

  // The ember is the CREST only, and sparingly. Blended any harder it mixes
  // with the plum through the midtones and the whole frame silts up into a
  // uniform brown - which is what "three colours" looks like when all three
  // are present everywhere at once.
  vec3 col = mix(c0, c1, band);
  col = mix(col, c2, lift * 0.78);
  col = mix(col, c3, pow(crest, 2.6) * 0.78);

  // The sheen. This is the job the HDRI environment map does in shadergradient,
  // and omitting it is why hand-rolled versions look like a flat CSS gradient.
  vec3 L = normalize(vec3(-0.35, 0.72, 0.60));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 Hv = normalize(L + V);
  float spec = pow(max(dot(n, Hv), 0.0), 11.0);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 2.5);

  col += uSpecular * spec * mix(c3, vec3(1.0), 0.30);
  col += uSpecular * 0.16 * fres * c2;

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col *= uBrightness;

  vec2 vuv = frag / uResolution;
  float vig = smoothstep(1.35, 0.30, length((vuv - 0.5) * vec2(1.10, 1.0)) * 1.55);
  col *= mix(1.0, vig, uVignette);

  vec3 outCol = linearToSrgb(col);

  // Dither only, never grain. Breaks the banding, invisible as texture.
  float g = hash12(frag + fract(t) * 137.0) - 0.5;
  outCol += g * (1.2 / 255.0);

  fragColor = vec4(clamp(outCol, 0.0, 1.0), 1.0);
}`;

const DEFAULTS = {
  // Render at a fraction of CSS pixels and let the browser upscale. This is a
  // blurry gradient: device-pixel-ratio scaling buys no visible detail and
  // costs 4x the fill rate on a retina display. The upscale actually helps -
  // it softens the dither.
  resScale: 0.55,
  fpsCap: 30,
  speed: 0.042,
  scale: 1.05,
  warp: 1.05,
  specular: 0.34,
  brightness: 1.0,
  vignette: 0.86,
  saturation: 1.4,
  colors: ['#050510', '#161046', '#7C34BE', '#FF8E7E'],
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/**
 * Mounts the shader on a canvas.
 *
 * Returns null when WebGL2 is unavailable or the shader fails to compile, and
 * the caller is expected to keep its CSS fallback visible. The CSS gradient
 * underneath is the DESIGN; this is an enhancement on top of it. That ordering
 * is deliberate - it is the reason a machine with no WebGL still gets a hero
 * worth screenshotting rather than a black rectangle.
 */
export function mountSilk(canvas, options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  let gl;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
  } catch {
    return null;
  }
  if (!gl) return null;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log || 'shader compile failed');
    }
    return s;
  };

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    }
  } catch {
    return null;
  }

  gl.useProgram(prog);

  const U = (n) => gl.getUniformLocation(prog, n);
  const uRes = U('uResolution');
  const uTime = U('uTime');
  gl.uniform3f(U('uColor0'), ...hex(cfg.colors[0]));
  gl.uniform3f(U('uColor1'), ...hex(cfg.colors[1]));
  gl.uniform3f(U('uColor2'), ...hex(cfg.colors[2]));
  gl.uniform3f(U('uColor3'), ...hex(cfg.colors[3]));
  gl.uniform1f(U('uScale'), cfg.scale);
  gl.uniform1f(U('uWarp'), cfg.warp);
  gl.uniform1f(U('uSpecular'), cfg.specular);
  gl.uniform1f(U('uBrightness'), cfg.brightness);
  gl.uniform1f(U('uVignette'), cfg.vignette);
  gl.uniform1f(U('uSaturation'), cfg.saturation);

  gl.bindVertexArray(gl.createVertexArray());

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const w = Math.max(1, Math.round(r.width * cfg.resScale));
    const h = Math.max(1, Math.round(r.height * cfg.resScale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
    return true;
  };

  const draw = (clock) => {
    if (!resize()) return;
    gl.uniform1f(uTime, clock);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let clock = cfg.phase ?? 0;
  let last = 0;
  let acc = 0;
  let raf = 0;
  let onScreen = false;
  let lost = false;

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    if (acc < 1 / cfg.fpsCap) return;
    acc = 0;
    clock += dt * cfg.speed;
    draw(clock);
  };

  const run = (on) => {
    if (lost) return;
    if (on && !raf && !reduced.matches) {
      last = performance.now();
      acc = 1;
      raf = requestAnimationFrame(frame);
    }
    if (!on && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const still = () => {
    if (!lost) draw(clock);
  };

  // Only paint while the canvas is actually on screen. A gradient animating
  // behind twelve sections the visitor has scrolled past is pure heat.
  const io = new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting;
      if (reduced.matches) {
        if (onScreen) still();
      } else {
        run(onScreen);
      }
    },
    { rootMargin: '160px' },
  );
  io.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    run(onScreen && !document.hidden);
  });

  addEventListener(
    'resize',
    () => {
      if (reduced.matches || !raf) still();
    },
    { passive: true },
  );

  reduced.addEventListener('change', () => {
    run(false);
    if (reduced.matches) still();
    else run(onScreen);
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    run(false);
    canvas.classList.remove('is-live');
  });

  // One frame immediately, so the canvas is never a black rectangle waiting for
  // the intersection observer to fire.
  draw(clock);
  canvas.classList.add('is-live');

  return {
    destroy() {
      run(false);
      io.disconnect();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
