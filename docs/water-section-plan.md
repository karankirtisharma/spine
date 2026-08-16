# The Water Section — execution plan

**Status: PLANNED, NOT STARTED. This file is the complete context. Trust it over memory.**
Written 2026-08-16 immediately before a context compaction, at the user's request, to carry
the full understanding of the hardest remaining task. Read all of it before touching code.

---

## 1. The client brief (decoded from 7 annotated screenshots + dictation)

The client rejects the current burst→work transition — the FXScrollTransition seam sweeping
the PR ENGINE card in over the deep's film. Their words: "a cutted line which feels 2D and
very bad", "the one we are using all the time, it's shit." They marked the seam with a red X.

What they want instead, image by image:

- **Img 1–3 (our site):** the deep ends on the film's foliage floor. Arrows point DOWN below
  the grass line: *something should continue below the foliage.*
- **Img 4 (= `D:\Claude\RevEng\1\water.png`, THE ASSET, now provided):** an AI-generated
  night swamp — moon upper-right, dense reed bank across mid-frame, teal-glowing shoreline
  rocks, open rippling water across the bottom third. **This is the new content below the
  foliage.**
- **Img 5:** same image annotated "New water section this" with the waterline marked — a NEW
  SCROLL SECTION of roughly this composition's height, a *continuation of the continuous
  scroll* (their phrase). Length: "what suits, refer image 4" — i.e. my call, sized so the
  image's composition plays out (decision: **140vh**, see §5).
- **Img 6 (Active Theory's site):** their ring-room-over-water → lab crossing, as
  inspiration. The client knows theirs is a full 3D scene; ours uses the image-4 backdrop
  ("for our workflow it will be better").
- **Img 7 (AT, half-submerged):** the SLANTED waterline transition into the next room —
  "that type of slanting line transition, because this is good." This is how water→work
  should cross.
- **Img 8:** the film frames rendered upside down. **FIXED** in commit `264882e`
  (ImageBitmap ignores flipY; flip moved to `createImageBitmap(..., {imageOrientation:
  'flipY'})` + `texture.flipY = false` in `src/filmseq.js`). Verified upright in the pane.

Q3 answer ("how should the section behave inside"): **like Active Theory's** — smooth,
scroll-driven. Their reference recording is `C:\Users\karan_z7alww2\Downloads\latest.mp4`
(9s screen capture of activetheory.net scrolling ring room → water → lab). Their crossing
choreography, studied frame-by-frame this session: water floor visible through the room →
camera sinks → split-screen at a bright waterline (above: room, below: next room through
murk) → fully under: caustic sheet overhead receding, next room ahead.

## 2. Current repo state (work-spine/, branch main)

- Pushed through `9aff072`. **Local, unpushed: `264882e`** (flip fix) + whatever this plan
  produces. **NEVER push without the user saying "github update" in that moment.**
- `a21b202`: the deep's film is now a **WebP frame sequence** — `assets/deep-bg/f_0001..0315.webp`
  (1080p, 33MB, from the user's Topaz 4K master `D:\Claude\RevEng\1\TopazUpscaled.mp4`),
  played by `src/filmseq.js` (LRU of decoded ImageBitmaps, 48-frame window, prefetch in
  scroll direction, `film.setProgress(t)` from the frame loop, measured 0.1ms/swap).
  `deepBgTex = film.texture` at main.js ~line 618.
- `dfe3a04` (**REVERTED by `9aff072`, recoverable**): the Active Theory water port. See §4.
- Sections: `SECTION_VH = { land:105, drift:140, gather:140, burst:380, work:1050 }`.
  Burst layout in vh-from-burst-start (all invariant to burst/section changes):
  blast hpF-driven over burst's first 140vh; coin hold ~63–110; coin rise 110–240 (RISE 22,
  exits fully); film fade-in 209–216, scrub 209–349, parked 349+; wipe band opens 365.
- hpF is PINNED to `HERO_VOLUME_VH = 420` (drift start 105vh → pins at 525vh). burstVh =
  `S.burst.progress * 380`. Neither moves when sections are added after burst.
- The descent/coin/film choreography is APPROVED — do not disturb burst's internals.

## 3. The design

### New section `water`, 140vh, between burst and work

Scroll story: deep's film parks on the vine column → seam rises from the frame's bottom
carrying the swamp's WATER first, then reeds, then moon (the wipe fills bottom-up — this IS
img 3's "water appears below the foliage") → a held swamp tableau, alive (rippling water,
its reflections, drifting mist) → the slanted waterline crossing into work (topside water
below you going out; caustic ceiling overhead coming in; card room beneath).

### The water scene's layers (back to front)

1. **Backdrop plane**: `water.png` (1672×941 — modest; see §7 upscale option), cover-fit,
   `fog:false`, at its own depth. Camera fixed (see §5).
2. **Live water plane** (AT TreeWaterShader port from `src/water.js`, §4) across the bottom
   ~38% of frame, replacing the still's own water: `tMirrorReflection` = **the backdrop
   texture itself**, flipped about the waterline's projected screen height (`uHorizonY`) —
   the research confirmed the port works with a still image directly; the reeds and moon
   then genuinely ripple. `uFilmFit` derivation must use the IMAGE's aspect (1672/941), not
   16/9.
3. **Real 3D flora** as bank silhouettes at the waterline — same trick as the live ferns
   over the film; this is what sells the still as 3D. Cheapest: a handful of flora-style
   card/fern instances (or reuse `buildFlora` prototypes) in a strip at the plane seam.
4. Optional (only if cheap): our mist sprites + a few dust motes.

### Transition A: burst → water (the "continuation")

- Enable the seam: `transitionState(..., ['drift', 'water', 'work'])` (seams filter by
  INCOMING name; outgoing is positional — transition.js:123,129).
- **Grade continuity is the whole game**: the current seam reads "2D and bad" because grade
  snaps to 0 across it. Give water `deepF = 1`-continuity arms (stageSection deepF/gradeF
  ternaries) so mixSeam crossfades nothing and the green holds across the seam.
- The film's last frame is parked 16vh before the band opens — hand-off verified natural.

### Transition B: water → work (img 7, the slanted waterline)

- The seams list edit above already makes the existing `'work'` seam a water→work wipe.
- Reinstate the **WaterCeilingShader** (underside caustic sheet) over work's rail start:
  gate `name === 'work' && S.work.progress < 0.14`, `uAlpha = 1 - smoothstep(0.05, 0.12, wp)`
  (these exact gates shipped in dfe3a04 and were verified live).
- Water section keeps its topside water visible to the seam → crossing = topside below /
  seam sweeps (already slanted 7.4°, AT's own uAngle) / ceiling overhead. That is img 7.

## 4. The reverted water port — recover it FIRST

`git revert 9aff072` re-applies `dfe3a04` onto current main. **Verified mechanically this
session on a temp branch: ONE conflict, the main.js import block only.** Resolution: keep
both sides — textures import WITH `makeCrackedIceTexture` + `import { buildFilmSequence }`
+ `import { buildWater }`.

What it restores:
- `src/water.js` — AT's TreeWaterShader + WaterCeilingShader ports, scraped from
  `https://activetheory.net/assets/shaders/compiled.vs` (chunks delimited `{@}Name{@}`),
  verified character-for-character at source. Their live uil tuning as defaults: uSpeed
  0.04, uScale 1000, uWaterUVStrength -5, uBrightness 2, uLight (-2.96,7.5,-1.93,0.04).
  Four documented departures (time→uTime; mirror RT→flat-backdrop flip about uHorizonY;
  tMRO→const 1.0; MRT bright-pass→bloom). Ceiling undulation = THEIR commented-out cnoise
  lines, resurrected.
- `makeCrackedIceTexture` in textures.js (tileable toroidal voronoi, 44 seeds, double web —
  tuned 3 rounds against the client's recording of AT).
- main.js wiring (buildWater after `const video =` line, hide-list entries, staging blocks)
  — the dfe3a04 staging gates (topside `inVolume && burstVh > 296`) belong to the OLD
  design; in the new design the topside plane moves INTO the water section's staging, so
  expect to rewrite that block rather than keep it.
- AT source access if needed again: their site exposes `window.Shaders` (all 288 shader
  chunks in plaintext) when loaded in the pane; also `window.ASSETS`, uil json
  `assets/data/uil.*.json`. matcap-test.jpg + waternormals.jpg already in `assets/at/`.

## 5. The 13-edit integration map (verified file:line this session)

1. `sections.js:58` — SECTION_ORDER: insert `'water'` between `'burst'` and `'work'`.
2. `sections.js:105` — SECTION_VH: `water: 140`. **Any length keeps work.span = 950**
   (only the LAST section clamps; travel grows by exactly W; span = (1715+W)−(765+W)).
3. Run `node test/ranges.mjs` — must pass. (compare.mjs baseline also unaffected — affine.)
4. `main.js:3040-3044` — **REQUIRED**: section resolver has no water case; without it the
   playhead in water stages 'land'. Add `: S.water.active ? 'water'`.
5. `main.js:3053` — seams `['drift','water','work']`.
6. `main.js:1085-1098` — setNavSub water label (cosmetic; falls to "<< Quantum Hop").
7. `main.js:3178` — rimOn: add water → 0 (else two full rim lights at a stale emblemPos).
8. `main.js:3288-3289` — uSaturation arm for water (default falls to 0.55; probably want
   burst's 1.0 for continuity — decide visually).
9. `main.js:2422, 2486-2487` — deepF/gradeF water arms (deepF 1, gradeF 1) for grade
   continuity across both seams. They publish to `__deepFor/__gradeFor`; mixSeam handles
   the rest. NOTE deepF=1 also enables DOF via `__deepFor` → decide: water probably wants
   uAmount 0 (publish deep 0 but grade 1 — they're separate maps, this is fine).
10. `main.js:2529, 2543-2553, 2560, 2564, 2575-2577, 2937-2938` — atmosRoot/ambienceRoot/
    heroCloud/plume/mist water values (defaults are wrong-era volume looks; simplest: hide
    atmosRoot+ambienceRoot for water, mist to taste).
11. `main.js:2583` — emblem: `name !== 'work' && name !== 'water'` (else stale mid-exit
    transform shows). Same for emblemRig via edit 7.
12. `main.js:2808` — nebula.group: hide for water (placement only covers land/volume).
13. main.js between 2617 and the land else at 2619 — water camera branch:
    `camGroup.position.set(...); camGroup.quaternion.identity(); camera.position.set(0,0,D);
    camera.rotation.set(0,0,0); setFov(30);` — pose in EMPTY world space far from all
    sections' content (e.g. y = -500). updateMatrixWorld at 2675 and the prewarm loop
    (3713-25, iterates SECTION_ORDER) cover it automatically.

Also: VOLUME stays `['drift','gather','burst']` (water is NOT the descent). Drag gating,
uFlash, wetSpec, volumetric defaults for water are all safely 0/off as-is. `wantRays`
(main.js:3429) generalizes correctly. The film transport gate `burstVh > FILM_START_VH-30`
keeps calling setProgress(1) through water/work — clamped, fine.

## 6. Execution order (with browser verification at every step)

1. **Recover port**: `git revert --no-commit 9aff072` → fix the import union → strip the
   old topside/ceiling staging gates (rewrite comes later) → syntax check → commit.
2. **Machinery** (edits 1–13) with the water camera parked at the empty pose, section
   showing nothing but fog colour → verify: scroll through land→work, every boundary,
   `front` resolves 'water' in between (probe `window.__dbg().front`), ranges test passes,
   work rail lands on card 0 exactly as before.
3. **Backdrop**: load water.png (TextureLoader, SRGB), cover-fit plane in the water camera's
   frustum → verify framing at multiple aspects (resize_window 1500×760 + default).
4. **Live water plane**: TreeWaterShader over bottom ~38%, uHorizonY = projected plane
   height (recompute per staging), uFilmFit from image aspect → verify: reeds/moon ripple
   in reflection, no seam at the plane/backdrop join (tune plane y so its horizon sits ON
   the image's own waterline ~62% height).
5. **Flora bank strip** → verify parallax on pointer/scroll entry.
6. **Transition A** (seams + grade arms) → verify: scrub 700→790vh slowly; seam carries
   water up under the film's foliage; NO colour snap (screenshot both halves mid-band).
7. **Transition B** (ceiling reinstated over work start) → verify against img 7: topside
   below, slanted seam, caustic ceiling overhead, cards beneath; then ceiling fades by
   wp 0.14.
8. Full pass land→work at user pace + reverse scrub. Commit per phase, not one blob.

## 7. Verification rituals & traps (hard-won this session — respect them)

- **Pane settle helper** (dev server never hot-reloads; always `navigate` with a fresh
  `?v=`): `window.__lenis.scrollTo(vh*(innerHeight/100),{immediate:true})` then poll
  `window.__dbg().progress` for 3 stable reads via rAF; cap iterations — the pane's rAF
  FREEZES when hidden, promises hang, and a stalled page reads as "broken code".
  Any probe of animated state must carry a page-clock stamp.
- **Stale console trap**: `read_console_messages` accumulates across loads; a dead page's
  errors persist with OLD line numbers after clear+navigate. Verify against
  `curl localhost:5188/src/main.js | sed -n 'Np'` before believing an error.
- **Wipe rule**: stageSection runs twice per wipe frame — staging must be pure assignments
  of scroll state; side effects (seeks, cache touches, lerps) live in the frame loop once.
- **Scene invariants** (sections.js header): no lights inside toggled roots (intensity at
  scene level instead), never null fog/environment, roots stay renderOrder 0.
- **depthWrite:true on any full/partial-screen transparent plane** or the DOF blurs it as
  background (film + water both learned this).
- **Volumetric hide lists** (main.js ~3457): any new lit/bright mesh visible during a
  section render must join that section's hide list or the god-rays white out.
- **refractExclude**: leave water meshes OUT so the glass/cards refract them.
- water.png is 1672×941 — acceptable, but if the client complains about softness, Topaz
  the still to 2560+ and swap (same pipeline as TopazUpscaled.mp4 → deep-bg frames).
- Screenshot pane sizes drift (556–800px wide, sometimes letterboxed top-left sub-frame);
  point-size/chunkiness judgments need resize_window 1500×760 (memory: pane-vs-display).
- Client feedback pattern: they compare against the AT recording frame-by-frame — do the
  same BEFORE presenting (extract frames with ffmpeg, compare side by side).

## 8. Standing rules

- Commit locally per coherent step, detailed messages, `Co-Authored-By: Claude <model>`.
- **Push ONLY on the words "github update".** The flip fix `264882e` is already local-only.
- Their shaders are ported verbatim with departures documented in comments — keep that
  discipline for anything else taken from `window.Shaders`.
- The user wants the browser used "perfectly for visual confirmation" — screenshot every
  beat, and when a look is contested, extract frames from their reference videos
  (`latest.mp4` = AT scroll-through; `water.png` = the target still) and compare directly.
