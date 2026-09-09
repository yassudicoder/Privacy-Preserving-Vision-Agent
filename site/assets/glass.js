/**
 * LIQUID GLASS - edge refraction on a live backdrop.
 *
 * WHAT THIS IS NOT. liquid-glass-js rasterises the whole page with html2canvas,
 * uploads it as a WebGL texture, and refracts that. Its backdrop is a one-time
 * snapshot: anything that changes after load - an animating shader, a hover
 * state, a late web font - is frozen or wrong inside the glass. On this page the
 * backdrop is a moving gradient, so that approach would show a still frame of it
 * inside every panel. It also composites its contents in a shader, so real HTML
 * cannot live inside a panel and stay selectable and accessible.
 *
 * WHAT THIS IS. `backdrop-filter: url(#id)` hands the LIVE composited backdrop
 * into an SVG filter graph. feDisplacementMap then offsets each backdrop sample
 * by `scale * (channel - 0.5)`, so a map encoding 128 as "no displacement", with
 * red as the x offset and green as the y, bends the backdrop exactly where the
 * map is painted. About 60 lines and no dependencies, with real DOM children
 * inside the panel.
 *
 * THE MAP HAS TO BE SHAPE-AWARE. feTurbulence gives random noise everywhere,
 * which is wobbly frosted glass, not this. The look is refraction concentrated
 * in a bezel at the RIM with an optically flat centre, so the map is generated
 * from the panel's own geometry: a rounded-rect signed distance field, its
 * gradient as the surface normal, and a convex thickness profile that is ~1 at
 * the rim and falls to 0 in the middle. That falloff is what reads as glass
 * rather than as a lens.
 *
 * ================================ THE GATE ================================
 * THIS EFFECT IS CHROMIUM-ONLY AND CANNOT BE FEATURE-DETECTED.
 *
 * `CSS.supports('backdrop-filter', 'url(#x)')` returns TRUE in Chrome, Firefox
 * AND Safari, because url() is valid grammar in all three - they all parse the
 * declaration and only Chromium applies it. So `@supports` is a guard that
 * always passes, and using one here would ship the effect to engines that
 * cannot render it.
 *
 * Firefox drops the unsupported filter and renders unfiltered, which is fine
 * now but was not always: in some older builds `backdrop-filter: url(...)` made
 * the element VANISH, taking its text with it. Safari is worse than
 * unsupported - the open WebKit bug reports the GPU process crashing repeatedly
 * for as long as the page is open. Both are therefore excluded BY ENGINE, by
 * name, rather than by capability.
 *
 * And note the blur is deliberately not in the same declaration. A filter list
 * is one value: an engine that cannot honour the url() part discards the entire
 * list and takes the blur with it. Blur lives in the base CSS rule; this module
 * only ever adds a separate override.
 * ==========================================================================
 *
 * The refraction is garnish. The blur-and-bevel panel in styles.css is the
 * design that gets signed off and screenshotted; this runs on exactly two
 * surfaces for the roughly 70% of visitors who can see it. If the refraction
 * were load-bearing, the design would be wrong.
 */

/** Chromium only. Not a capability test - see the note above. */
function isChromium() {
  if (typeof CSS === 'undefined' || !CSS.supports) return false;
  const firefox = CSS.supports('-moz-appearance', 'none');
  const safari = CSS.supports('-webkit-hyphens', 'none');
  return !firefox && !safari && CSS.supports('backdrop-filter', 'blur(1px)');
}

/**
 * Paints the displacement map for one panel size.
 *
 * Encodes the outward surface normal of a rounded rectangle, weighted by a
 * thickness profile, into the red and green channels. Blue is unused and held
 * at the neutral 128 so it contributes nothing if an engine reads it.
 */
function buildMap(w, h, radius, bezel) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(w, h);
  const d = img.data;

  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(radius, hw, hh);

  // Signed distance to a rounded rectangle. Negative inside.
  const sdf = (x, y) => {
    const qx = Math.abs(x - hw) - (hw - r);
    const qy = Math.abs(y - hh) - (hh - r);
    const mx = Math.max(qx, 0);
    const my = Math.max(qy, 0);
    return Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - r;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dist = sdf(x + 0.5, y + 0.5);

      // Normal from the SDF gradient, by central differences.
      const gx = sdf(x + 1.5, y + 0.5) - sdf(x - 0.5, y + 0.5);
      const gy = sdf(x + 0.5, y + 1.5) - sdf(x + 0.5, y - 0.5);
      const len = Math.hypot(gx, gy) || 1;

      // Thickness profile of a convex squircle: ~1 at the rim, 0 in the flat
      // centre. This specific falloff is what makes it read as glass.
      const t = Math.min(Math.max(-dist / bezel, 0), 1);
      const mag = dist > 0 ? 0 : 1 - Math.pow(1 - Math.pow(1 - t, 4), 0.25);

      d[i] = 128 + (gx / len) * mag * 127;
      d[i + 1] = 128 + (gy / len) * mag * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

let uid = 0;

/**
 * Applies refraction to one element.
 *
 * Chromatic aberration is three displacement passes off the SAME map at
 * slightly different scales, each masked to one channel and recombined with
 * screen blending - the screen of pure red, pure green and pure blue is exact
 * channel reconstruction, so the only difference from a single pass is the
 * per-channel offset that produces the fringe.
 */
export function refract(el, { radius = 20, bezel = 26, scale = 42, blur = 0.4 } = {}) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 24) return null;

  // The map is stretched to the border box, so its own resolution can be well
  // below the panel's. Generating it per pixel would be a quarter-million sqrt
  // calls on a large panel for no visible gain.
  const mw = Math.min(Math.round(rect.width), 420);
  const mh = Math.min(Math.round(rect.height), 260);
  const sx = mw / rect.width;
  const href = buildMap(mw, mh, radius * sx, bezel * sx);

  const id = `lg${++uid}`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';

  svg.innerHTML = `
    <filter id="${id}"
            x="0%" y="0%" width="100%" height="100%"
            color-interpolation-filters="sRGB">
      <feImage href="${href}" preserveAspectRatio="none" result="map"/>

      <feDisplacementMap in="SourceGraphic" in2="map" scale="${scale * 1.06}"
        xChannelSelector="R" yChannelSelector="G" result="dr"/>
      <feColorMatrix in="dr" type="matrix" result="dr"
        values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>

      <feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}"
        xChannelSelector="R" yChannelSelector="G" result="dg"/>
      <feColorMatrix in="dg" type="matrix" result="dg"
        values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"/>

      <feDisplacementMap in="SourceGraphic" in2="map" scale="${scale * 0.94}"
        xChannelSelector="R" yChannelSelector="G" result="db"/>
      <feColorMatrix in="db" type="matrix" result="db"
        values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>

      <feBlend in="dr" in2="dg" mode="screen" result="rg"/>
      <feBlend in="rg" in2="db" mode="screen" result="rgb"/>
      <feGaussianBlur in="rgb" stdDeviation="${blur}"/>
    </filter>`;

  document.body.appendChild(svg);
  el.style.setProperty('--lg-filter', `url(#${id})`);
  el.classList.add('is-refracted');

  return {
    destroy() {
      el.classList.remove('is-refracted');
      el.style.removeProperty('--lg-filter');
      svg.remove();
    },
  };
}

/**
 * Enhances every `[data-refract]` element, if the engine and the visitor's
 * preferences allow it.
 *
 * Skipped on coarse pointers and narrow viewports: cost scales with backdrop
 * pixel area times device pixel ratio, and phones are 2-3x DPR on much weaker
 * GPUs. Measured on desktop, displacement is free up to about four panels of
 * on-screen glass and then halves the frame rate, which is why this site never
 * has more than two refracted surfaces.
 */
export function initGlass() {
  if (!isChromium()) return;
  if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return;
  if (matchMedia('(pointer: coarse), (max-width: 820px)').matches) return;

  const handles = new Map();

  const apply = () => {
    for (const el of document.querySelectorAll('[data-refract]')) {
      handles.get(el)?.destroy();
      const h = refract(el, {
        radius: Number(el.dataset.refractRadius || 20),
        bezel: Number(el.dataset.refractBezel || 26),
        scale: Number(el.dataset.refractScale || 42),
      });
      if (h) handles.set(el, h);
    }
  };

  apply();

  // Regenerating the map is a per-pixel loop; do not run it on every resize
  // tick, and skip it entirely when the rounded size has not actually changed.
  let last = `${innerWidth}x${innerHeight}`;
  let timer = 0;
  addEventListener(
    'resize',
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = `${innerWidth}x${innerHeight}`;
        if (now === last) return;
        last = now;
        apply();
      }, 220);
    },
    { passive: true },
  );
}
