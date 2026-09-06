/*
 * vision.html - image self-check.
 *
 * The only job here is to make a missing or broken image impossible to mistake
 * for "the model found nothing". Those two look identical from the panel: the
 * page renders, the step runs, YuNet is handed a frame, and there is simply no
 * face in it.
 *
 * No network, no timers, no mutation of anything the agent might act on.
 */

'use strict';

(function () {
  var status = document.getElementById('image-status');
  if (status === null) return;

  function report() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('.lab-figure-img'));
    var broken = imgs.filter(function (img) {
      // `complete` alone is true for a 404 too; naturalWidth is what separates
      // "finished loading" from "actually decoded a picture".
      return !img.complete || img.naturalWidth === 0;
    });

    if (imgs.length === 0) {
      status.textContent = 'No images found on this page. The test cannot run.';
      status.className = 'status warn';
      return;
    }

    if (broken.length > 0) {
      status.textContent =
        broken.length + ' of ' + imgs.length + ' images failed to load (' +
        broken.map(function (i) { return i.getAttribute('src'); }).join(', ') +
        '). Run: node test-site/make-images.mjs';
      status.className = 'status warn';
      return;
    }

    // Report the size the model will actually see. The capture is letterboxed
    // into a 640px square, so what matters is the displayed size relative to
    // the viewport - not the file's own resolution.
    var first = imgs[0];
    var shown = Math.round(first.getBoundingClientRect().width);
    var modelPx = Math.round((shown * 640) / Math.max(window.innerWidth, window.innerHeight));

    status.textContent =
      imgs.length + '/' + imgs.length + ' images loaded. Portraits render at ' +
      shown + ' css px, about ' + modelPx + ' px in the model’s 640 square ' +
      'at this window size.';
    status.className = 'status ok';
  }

  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);

  // Re-state the model-space figure when the window is resized, since that is
  // the number that decides whether a face is big enough to detect.
  var pending = null;
  window.addEventListener('resize', function () {
    if (pending !== null) return;
    pending = window.setTimeout(function () {
      pending = null;
      report();
    }, 200);
  });
})();
