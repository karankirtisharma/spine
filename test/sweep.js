/* Paste-and-run scroll sweep. Not a module -- an expression to evaluate INSIDE the
 * page, via the Claude Browser's javascript_tool or a devtools console.
 *
 * It drives the page to a set of scroll positions expressed in vh from the START of
 * the Work section, waits for the eased camera to settle, and dumps window.__dbg()
 * at each. Save the returned JSON to test/after.json and run:
 *
 *     node test/compare.mjs test/after.json
 *
 * Offsetting from the section start rather than from the top of the track is the
 * point: the same rail position can be sampled before and after the track got
 * longer, and the numbers compared directly.
 *
 * Screenshots are deliberately not the oracle here -- see the note on window.__dbg
 * in main.js for why they cannot be one in this project.
 */
(async function sweep(offsetVh) {
  if (!window.__dbg) return 'no window.__dbg -- is this build wired?';
  /* Default the offset from the LIVE range table rather than a constant.
   *
   * It was hard-coded to 525, the Work start under the old [.. Burst 140 ..]
   * table. Burst is 520 now and Work opens at 905, so every stop landed 380vh
   * short -- the sweep was sampling burst and calling the numbers Work's, and
   * a comparison against a stored baseline would have "passed" on entirely
   * different frames. */
  if (offsetVh === undefined) {
    const R = window.__dbg().ranges;
    offsetVh = R?.ranges?.work?.startVh ?? 905;
  }
  const vh = innerHeight / 100;
  const track = document.getElementById('track');
  const trackVh = Math.round(parseFloat(getComputedStyle(track).height) / vh);

  /* Deliberately includes 0 and the far end, where the 0.06/0.94 dead zone and the
   * +-1 unit tail easing live. */
  const STOPS = [0, 1, 60, 150, 300, 475, 650, 800, 890, 949, 950];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const samples = [];

  for (const s of STOPS) {
    const px = (s + offsetVh) * vh;
    if (window.__lenis) window.__lenis.scrollTo(px, { immediate: true });
    else document.getElementById('scroll').scrollTop = px;
    // smoothProgress eases at 0.28 and the camera chases at 0.2 -- let both land
    await wait(900);
    samples.push({ workVh: s, ...window.__dbg() });
  }
  return JSON.stringify({ trackVh, offsetVh, samples });
})();
