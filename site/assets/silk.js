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

import { NOISE_GLSL, COLOR_GLSL, FIELD_GLSL } from './glsl.js';

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

${NOISE_GLSL}
${COLOR_GLSL}
${FIELD_GLSL}

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag - 0.5 * uResolution) / uResolution.y;

  float t = uTime;

  vec3 c0 = srgbToLinear(uColor0);
  vec3 c1 = srgbToLinear(uColor1);
  vec3 c2 = srgbToLinear(uColor2);
  vec3 c3 = srgbToLinear(uColor3);

  // ONE definition of the gradient, in glsl.js, called by this program and by
  // the glass that refracts it. Two copies would eventually disagree, and the
  // way that failure shows up is the lens displaying a visibly different
  // gradient from the one behind it.
  float h;
  vec3 col = silkField(p, t, c0, c1, c2, c3,
                       uScale, uWarp, uSpecular, uSaturation, h);

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

  // The sheen. This is the job the HDRI environment map does in shadergradient,
  // and omitting it is why hand-rolled versions look like a flat CSS gradient.
  vec3 L = normalize(vec3(-0.35, 0.72, 0.60));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 Hv = normalize(L + V);
  float spec = pow(max(dot(n, Hv), 0.0), 11.0);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 2.5);

  col += uSpecular * spec * mix(c3, vec3(1.0), 0.30);
  col += uSpecular * 0.16 * fres * c2;

  // Saturation is applied inside silkField, so it is deliberately NOT applied
  // again here - doing both squared it and pushed the plum to neon.
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

/**
 * EXPORTED so the glass lens in prism.js takes the same values.
 *
 * The lens refracts this gradient by re-evaluating `silkField` at an offset
 * coordinate, which only produces the right picture if it is given an identical
 * palette, scale, warp and saturation. Two hand-kept copies of these numbers
 * would look correct on the day they were written and drift the first time
 * anyone retuned the hero.
 */
export const SILK_DEFAULTS = {
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
  const cfg = { ...SILK_DEFAULTS, ...options };

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
