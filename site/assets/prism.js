/**
 * THE LENS - a real 3D refractive form, hand-written WebGL2.
 *
 * WHAT IT IS. A subdivided icosahedron, lit and shaded per-fragment, that
 * refracts the silk gradient behind it. Real geometry, a real perspective
 * camera, real surface normals, and the object turns under its own rotation
 * with a little parallax from the pointer.
 *
 * WHY IT IS A LENS AND NOT A LOGO. The whole page argues one thing: the agent
 * is given the SHAPE of the page and not its contents. A lens is that made
 * physical - it bends and abstracts what is behind it, so you can see there is
 * something there and not what it says. That is the only reason a 3D object
 * earns a place on a page whose other argument is restraint. A sample-asset
 * duck or helmet would be decoration on a page that spends eleven sections
 * telling you it does not decorate.
 *
 * WHY THE REFRACTION IS REAL. The usual way to fake this is to render the
 * background to a texture and sample it with an offset. This does not do that.
 * The gradient is a pure function of a screen coordinate (`silkField` in
 * glsl.js), so the glass evaluates THE SAME FUNCTION at the coordinate the
 * refracted ray lands on. There is no framebuffer, no second render target and
 * no resolution mismatch between the glass and what is behind it - and because
 * both programs import the field from one module, they cannot drift apart and
 * start showing two different gradients.
 *
 * DISPERSION is three refractions at slightly different indices, one per
 * channel, which is what produces the colour fringing at the rim. Cheap here:
 * the field is evaluated three times instead of once, and only for the pixels
 * the object actually covers.
 *
 * COST. About 4 KB of source and one draw call of 1,280 triangles. The
 * alternative route to this - three.js with a transmission material - starts at
 * 134 KB gzipped before the material, and `@react-three/drei`'s environment map
 * would fetch an HDRI from a third-party CDN, on a site whose footer invites
 * you to count its network requests.
 */

import { NOISE_GLSL, COLOR_GLSL, FIELD_GLSL } from './glsl.js';
import { SILK_DEFAULTS } from './silk.js';

const VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4  uProj;
uniform mat4  uView;
uniform mat3  uNormal;
uniform float uTime;

out vec3 vNormal;
out vec3 vWorld;

void main(){
  // The sphere IS the normal, before deformation - which is what makes a
  // subdivided icosahedron cheap to light without shipping a normal buffer.
  vec3 n = normalize(aPos);

  // A slow, low-frequency swell so the form reads as a liquid body rather than
  // a faceted rock. Kept small: past about 0.1 the silhouette stops being a
  // recognisable lens.
  float swell = 0.055 * sin(uTime * 0.7 + aPos.y * 2.3)
              + 0.045 * sin(uTime * 0.53 + aPos.x * 1.9 + 1.7);
  vec3 pos = aPos * (1.0 + swell);

  vec4 world = uView * vec4(pos, 1.0);
  vWorld  = world.xyz;
  vNormal = normalize(uNormal * n);

  gl_Position = uProj * world;
}`;

const FRAG = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
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
uniform float uSaturation;
uniform float uFade;

// Where this canvas sits inside the PAGE, so the field can be evaluated in the
// gradient's own coordinate system rather than in this canvas's.
uniform vec2  uLensOrigin;   // canvas top-left, in CSS px, relative to the hero
uniform float uLensScale;    // canvas device px per CSS px
uniform vec2  uPageSize;     // hero size in CSS px

${NOISE_GLSL}
${COLOR_GLSL}
${FIELD_GLSL}

/**
 * Maps a fragment of THIS canvas to the field coordinate the fullscreen
 * gradient would use for the same physical point on the page.
 *
 * Without this the lens evaluates the field in its own 558-pixel space while
 * the gradient behind it uses the full 1440, so the two show the same function
 * at different scales and the glass never lines up with what it is refracting -
 * which is exactly the artifact that makes a fake refraction look fake.
 *
 * gl_FragCoord.y counts up from the bottom; CSS y counts down from the top.
 */
vec2 toField(vec2 frag){
  vec2 css = uLensOrigin + vec2(frag.x, uResolution.y - frag.y) / uLensScale;
  return (css - 0.5 * uPageSize) / uPageSize.y;
}

/** The gradient, in linear light, at a field coordinate. */
vec3 fieldAt(vec2 p){
  float h;
  return silkField(p, uTime,
                   srgbToLinear(uColor0), srgbToLinear(uColor1),
                   srgbToLinear(uColor2), srgbToLinear(uColor3),
                   uScale, uWarp, uSpecular, uSaturation, h);
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vWorld);

  // Front and back faces are both drawn; a back face has to be flipped or the
  // interior lights as though it were turned inside out.
  if (!gl_FrontFacing) N = -N;

  vec2 frag = gl_FragCoord.xy;

  vec2 p = toField(frag);
  vec2 centre = toField(0.5 * uResolution);

  // MAGNIFICATION, and this is what makes the glass legible at all. Refracting
  // a very low-frequency gradient displaces the sample by a few pixels of a
  // shape that changes over hundreds, so the refracted colour comes back almost
  // identical to the colour behind it and the lens vanishes. A real lens does
  // not merely bend light, it MAGNIFIES - so the field is sampled about the
  // lens centre at a compressed coordinate, which shows a genuinely different,
  // enlarged piece of the same gradient. That reads as glass instantly.
  vec2 mag = centre + (p - centre) * 0.42;

  // The refraction offsets are in screen pixels; the field is in units of one
  // page height, so they have to be converted rather than added raw.
  float px = 1.0 / uPageSize.y;

  // DISPERSION. One refraction per channel. The spread is deliberately small -
  // large values read as a broken display rather than as glass.
  vec3 rR = refract(-V, N, 1.0 / 1.42);
  vec3 rG = refract(-V, N, 1.0 / 1.47);
  vec3 rB = refract(-V, N, 1.0 / 1.52);

  float reach = 260.0 * px;
  vec3 cr = fieldAt(mag + rR.xy * reach);
  vec3 cg = fieldAt(mag + rG.xy * reach);
  vec3 cb = fieldAt(mag + rB.xy * reach);
  vec3 refr = vec3(cr.r, cg.g, cb.b);

  // Fresnel: edge-on is mirror, face-on is window. Schlick.
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.2);
  f = mix(0.06, 1.0, f);

  // A reflection of the same field, sampled as though bounced off the surface.
  vec3 refl = fieldAt(p + reflect(-V, N).xy * 420.0 * px);

  vec3 col = mix(refr, refl, f * 0.72);

  // A small lift. Where the magnified sample lands in a trough of the gradient
  // the glass comes back darker than everything around it and reads as a hole
  // rather than as a lens - real glass gathers light, it does not subtract it.
  col = col * 1.16 + srgbToLinear(uColor2) * 0.05;

  // Specular. Tinted toward the warm stop for the same reason the background
  // is: a white highlight bleaches the whole form to grey.
  vec3 L = normalize(vec3(-0.45, 0.78, 0.62));
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 46.0);
  col += spec * mix(srgbToLinear(uColor3), vec3(1.0), 0.45) * 1.35;

  // A cool rim so the silhouette separates from a background of the same hue.
  col += pow(f, 1.6) * srgbToLinear(vec3(0.35, 0.78, 0.91)) * 0.30;

  vec3 outCol = linearToSrgb(col);
  outCol += (hash12(frag + fract(uTime) * 91.0) - 0.5) * (1.2 / 255.0);

  // Alpha carries the fresnel: the body of the lens is nearly clear and the
  // rim is where the glass is visible, which is how real glass reads.
  float a = clamp(0.30 + f * 0.72, 0.0, 1.0) * uFade;
  fragColor = vec4(clamp(outCol, 0.0, 1.0), a);
}`;

/* ────────────────────────────────────────────────────────────── geometry ── */

/**
 * A subdivided icosahedron, positions only.
 *
 * Normals are not stored: for a sphere the normalised position IS the normal,
 * and the vertex shader derives it. That halves the buffer and removes any
 * chance of the two going out of sync when the vertex shader deforms the
 * surface.
 */
function icosphere(order = 3) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  });

  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  // Midpoints are cached by edge key, so a shared edge yields one vertex rather
  // than two coincident ones - otherwise the seams show as hairline cracks
  // where the two normals disagree.
  for (let s = 0; s < order; s++) {
    const cache = new Map();
    const next = [];
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a];
      const vb = verts[b];
      const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
      const l = Math.hypot(...m);
      verts.push([m[0] / l, m[1] / l, m[2] / l]);
      const idx = verts.length - 1;
      cache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  return {
    position: new Float32Array(verts.flat()),
    index: new Uint16Array(faces.flat()),
  };
}

/* ─────────────────────────────────────────────────────────────── matrices ── */

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

/** Y then X rotation, then a translation. Column-major, as GL wants it. */
function viewMatrix(rx, ry, tx, ty, tz) {
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);

  const m00 = cy;
  const m01 = 0;
  const m02 = -sy;
  const m10 = sx * sy;
  const m11 = cx;
  const m12 = sx * cy;
  const m20 = cx * sy;
  const m21 = -sx;
  const m22 = cx * cy;

  // prettier-ignore
  return {
    view: new Float32Array([
      m00, m10, m20, 0,
      m01, m11, m21, 0,
      m02, m12, m22, 0,
      tx,  ty,  tz,  1,
    ]),
    // Rotation only, and orthonormal, so its inverse-transpose is itself.
    normal: new Float32Array([m00, m10, m20, m01, m11, m21, m02, m12, m22]),
  };
}

/* ───────────────────────────────────────────────────────────────── mount ── */

/**
 * The field parameters come from SILK_DEFAULTS, never from a copy. Only the
 * render settings are this module's own - the lens is drawn at a higher
 * resolution than the gradient because it has a silhouette and an edge, and
 * an edge is exactly what a 0.55 upscale destroys.
 */
const DEFAULTS = {
  ...SILK_DEFAULTS,
  resScale: 0.9,
  fpsCap: 30,
  order: 3,
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/**
 * Mounts the lens on a canvas.
 *
 * Returns null when WebGL2 is unavailable or the program fails to build. The
 * caller keeps whatever it had - here that is the silk gradient alone, which is
 * a finished hero on its own. The lens is the third layer on a design that is
 * already complete at the first.
 */
export function mountPrism(canvas, options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  let gl;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
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
      throw new Error(log || 'compile failed');
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

  const geo = icosphere(cfg.order);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, geo.position, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.index, gl.STATIC_DRAW);

  const U = (n) => gl.getUniformLocation(prog, n);
  const uProj = U('uProj');
  const uView = U('uView');
  const uNormalM = U('uNormal');
  const uRes = U('uResolution');
  const uTime = U('uTime');
  const uFade = U('uFade');
  const uLensOrigin = U('uLensOrigin');
  const uLensScale = U('uLensScale');
  const uPageSize = U('uPageSize');

  gl.uniform3f(U('uColor0'), ...hex(cfg.colors[0]));
  gl.uniform3f(U('uColor1'), ...hex(cfg.colors[1]));
  gl.uniform3f(U('uColor2'), ...hex(cfg.colors[2]));
  gl.uniform3f(U('uColor3'), ...hex(cfg.colors[3]));
  gl.uniform1f(U('uScale'), cfg.scale);
  gl.uniform1f(U('uWarp'), cfg.warp);
  gl.uniform1f(U('uSpecular'), cfg.specular);
  gl.uniform1f(U('uSaturation'), cfg.saturation);

  // Both faces are drawn so the back of the glass is visible through the front.
  // Depth WRITING is off for the same reason: with it on, whichever face wins
  // the depth test hides the other and the form goes solid.
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);

  // The field is evaluated in the HERO's coordinate system, so the lens needs
  // to know where it sits inside the hero and how big the hero is. Both are
  // read from layout rather than assumed, because the lens is centred with
  // percentages and its origin moves with the viewport.
  const host = canvas.closest('.hero') ?? canvas.parentElement ?? document.body;

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
      gl.uniformMatrix4fv(uProj, false, perspective(0.62, w / h, 0.1, 40));
    }

    const hr = host.getBoundingClientRect();
    gl.uniform2f(uLensOrigin, r.left - hr.left, r.top - hr.top);
    gl.uniform1f(uLensScale, canvas.width / r.width);
    gl.uniform2f(uPageSize, hr.width, hr.height);
    return true;
  };

  // Pointer parallax, heavily damped. The lens leans toward the cursor; it does
  // not track it, which would read as a toy.
  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  const onMove = (e) => {
    targetX = (e.clientX / innerWidth - 0.5) * 2;
    targetY = (e.clientY / innerHeight - 0.5) * 2;
  };
  addEventListener('pointermove', onMove, { passive: true });

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let clock = cfg.phase ?? 0;
  let last = 0;
  let acc = 0;
  let raf = 0;
  let onScreen = false;
  let lost = false;
  let fade = 0;

  const draw = () => {
    if (!resize() || lost) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    curX += (targetX - curX) * 0.045;
    curY += (targetY - curY) * 0.045;

    const rx = -0.30 + curY * 0.24;
    const ry = clock * 3.6 + curX * 0.42;
    const { view, normal } = viewMatrix(rx, ry, curX * 0.12, -curY * 0.09, -3.25);

    gl.uniformMatrix4fv(uView, false, view);
    gl.uniformMatrix3fv(uNormalM, false, normal);
    gl.uniform1f(uTime, clock);
    gl.uniform1f(uFade, fade);

    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, geo.index.length, gl.UNSIGNED_SHORT, 0);
  };

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    if (acc < 1 / cfg.fpsCap) return;
    acc = 0;
    clock += dt * cfg.speed;
    fade = Math.min(1, fade + dt * 1.1);
    draw();
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

  const io = new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting;
      if (reduced.matches) {
        if (onScreen) { fade = 1; draw(); }
      } else {
        run(onScreen);
      }
    },
    { rootMargin: '120px' },
  );
  io.observe(canvas);

  document.addEventListener('visibilitychange', () => run(onScreen && !document.hidden));
  addEventListener('resize', () => { if (reduced.matches || !raf) { fade = 1; draw(); } }, { passive: true });
  reduced.addEventListener('change', () => {
    run(false);
    if (reduced.matches) { fade = 1; draw(); } else run(onScreen);
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    run(false);
    canvas.classList.remove('is-live');
  });

  if (reduced.matches) fade = 1;
  draw();
  canvas.classList.add('is-live');

  return {
    triangles: geo.index.length / 3,
    destroy() {
      run(false);
      io.disconnect();
      removeEventListener('pointermove', onMove);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
