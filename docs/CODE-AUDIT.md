# CODE AUDIT — bugs, dead code, dead assets, optimizations

Generated 2026-08-20 against commit `dd3ad0a`. **Nothing in this document has been executed** — it is the checklist to fix from.

**Method.** 12 reader agents covered every file in the repo end to end (main.js in thirds, every module, index.html, all tooling, every file under `assets/` checked for references including dynamically-built paths). Every "dead — safe to delete" claim was then re-verified by adversarial agents whose only job was to prove it alive (dynamic paths, query flags, `window.__*` debug handles, tooling references); every medium+ bug was re-read in context. Verdicts are marked throughout. Treat UNSURE as *do not delete without the stated check*.

---
## 1. Verified bugs

16 confirmed by in-context re-reading. Ordered by severity.

### 1.1 [MEDIUM] Transition render targets are CSS-pixel sized while the composer chain runs at DPR 1.5 — the outgoing half of every wipe renders soft and glass materials mis-sample the screen
**Where:** `src/main.js:1572`

transitionRT, transitionDepth and transitionDofRT (lines 1572-1585) are created at innerWidth x innerHeight, and applySize (4484-4488) resizes them to w x h. But the EffectComposer's ping-pong targets are pixel-ratio scaled (vendor/three/examples/jsm/postprocessing/EffectComposer.js:69/320 multiplies by renderer.getPixelRatio(), which is DPR = min(devicePixelRatio, 1.5) from main.js:44/65). Two consequences on any DPR>1 display, during every wipe: (1) the outgoing section is rendered into a buffer with 1/DPR^2 (~44%) of the incoming half's pixels, so one half of the mixed frame is visibly softer than the other — exactly the artifact the comment at 4482-4483 says this target is full-resolution to avoid, and the same class of cross-seam asymmetry the HalfFloatType comment at 1564-1571 was written to remove; (2) materials that compute screenuv = gl_FragCoord.xy / resolution with resolution bound to shared.uResolution in DEVICE pixels (emblem.js:163/278; the home columns and cards use the same pattern) mis-normalize when drawn into the 1x transitionRT: gl_FragCoord spans w x h but resolution is w*1.5 x h*1.5, so during the land->drift wipe the outgoing emblem/columns sample only the bottom-left ~2/3 of the refraction snapshot — displaced refraction content on the outgoing half only.

**Fix:** Create and resize the three transition buffers at DPR scale: new THREE.WebGLRenderTarget(Math.round(innerWidth*DPR), Math.round(innerHeight*DPR), ...) and in applySize use transitionRT.setSize(Math.round(w*DPR), Math.round(h*DPR)) (same for transitionDofRT and the transitionDepth image dims). The transitionPass 'resolution' uniform is only used for aspect (resolution.x/resolution.y) so it can stay in CSS px.

### 1.2 [MEDIUM] Water sink window (360..405) now overlaps the film scrub (209..399): the surface rises and the camera sinks while the footage still plays, breaking the documented invariant
**Where:** `src/main.js:743`

WATER_SINK_A_VH=360 was chosen when FILM_SPAN_VH was 150 (film last frame at 209+150=359; the comment at 736-742 states the guard is 'unconditional': 'at every frame the film is up, the water is still parked at WATER_Y_FROM'). FILM_SPAN_VH was later extended to 190 (line 2690, comment there: last frame lands at 399, 'hands off to the water the moment it arrives'), but the sink window was never moved. Current behavior for burstVh 360..399: the scrub is still advancing frames (line 3811-3813 maps (burstVh-209)/190), while (a) the world-fixed surface climbs from -14.6 toward -12.4 (lines 3420-3421 use smoothstep(WATER_SINK_A_VH, WATER_SINK_B_VH, burstVh) — ~87% of the 2.2-unit rise is done by 399) and (b) the camera sinks up to ~4 units of WATER_SINK=4.2 (waterTailDrop, line 778, subtracted from camGroup.y at 3133). The film plane is eye-locked so it sinks with the eye, but the water is world-fixed, so the risen surface enters the bottom of the frame (roughly 10-15% of frame height by burstVh ~380 by the file's own frustum arithmetic at 683-687) while the footage is still mid-scrub — the exact condition the 150-cut was made at 'the client's explicit direction' to prevent ('without letting the water into the film's frame', 2670-2673). The filmDrift 'C1-smooth hand-off into the sink' premise (817-821) is also void: drift now ends at 399, 39vh after the sink opens.

**Fix:** Re-derive the window from the film constants so they cannot drift apart: const WATER_SINK_A_VH = FILM_START_VH + FILM_SPAN_VH + 1; const WATER_SINK_B_VH = WATER_SINK_A_VH + 45; (requires moving the declaration after line 2690 or into a function evaluated at call time, as filmDrift already does). If the overlap is actually the newly intended look, update the invariant comments at 736-742 and 817-821 instead.

### 1.3 [MEDIUM] home.update() is called with 5 arguments but accepts 4 — the AT particle-group rotation is silently discarded
**Where:** `src/main.js:3214`

Line 3213 documents the fifth argument as Active Theory's `particles.group.rotation.y = radians(-20) + rotation + scrollTarget`, and lines 3214-3215 (and 3295 in the land branch) pass `radians(-20) + dragRotation + scrollTarget` as a fifth argument. But home.js's returned `update(progress, visible, logoPos, logoRotY)` (src/home.js:578) takes only four parameters and never rotates the plume or its group anywhere in its body (verified: no `plume.rotation` / `group.rotation` writes in home.js). JavaScript silently drops the extra argument, so the particle field never receives the scroll/drag rotation the call site computes and documents — the mark and tails rotate with drag/scroll while the plume stays fixed, contradicting the transcription the comment claims.

**Fix:** Add a fifth parameter to home.js's update (e.g. `update(progress, visible, logoPos, logoRotY, groupRotY)`) and apply it to the particle system (`plume.rotation.y = groupRotY`, matching AT's particles.group), or delete the fifth argument and the line-3213 comment if the rotation is intentionally dropped.

### 1.4 [MEDIUM] Ousted video card's uVideoBlend tween keeps running and pins it at 1
**Where:** `src/main.js:3939`

When `nearest` changes, line 3939 snaps the previous card's uVideoBlend to 0 and line 3941 starts a tween on the NEW card's uniform. tweenUniform (line 1326) de-dupes only tweens on the same uniform object, so the OLD card's still-running tween (500ms + 300ms delay, started when it became nearest) stays in `tweens[]`. stepTweens runs at line 3614 every frame and keeps overwriting the ousted card's uniform from its captured `from` toward 1, finishing at exactly 1 and deleting itself — leaving that card permanently crossfaded to the shared video texture (cards.js line 328 mixes tMap->tVideo by uVideoBlend). Any handover inside the 800ms window — i.e. normal fast scrubbing through the helix — leaves one or more non-nearest cards stuck showing the video blend alongside the real nearest card, defeating the documented invariant 'every other card snaps to 0' (line 3937).

**Fix:** Before zeroing, cancel the ousted card's pending tween: `if (activeVideoCard) { const i = tweens.findIndex(tw => tw.u === activeVideoCard.pMat.uniforms.uVideoBlend); if (i > -1) tweens.splice(i, 1); activeVideoCard.pMat.uniforms.uVideoBlend.value = 0; }` (or add a cancelTween(uniform) helper next to tweenUniform).

### 1.5 [MEDIUM] Hover picking and click navigation are not gated to the work section
**Where:** `src/main.js:3904`

Hover picking (lines 3901-3904) runs every frame in every section. THREE.Raycaster does not test ancestor visibility: outside work `workRoot` is invisible, but each card holder's own `visible` flag is set true by the cull window (lines 3892-3898 — wp is 0 in land so focusIdx=0 and cards 0-2 pass), so `cards.filter(c => c.holder.visible)` still feeds their panels to the raycaster, and their matrixWorld stays updated (updateMatrixWorld ignores `visible`). In land the camera sits at z≈15 with cards at radius 3.8 around the origin — inside the frustum — so `hovered` becomes non-null when the pointer crosses an invisible card. The global click handler (lines 1407-1411) checks only `hovered._dist > 30`, and in land `_dist` (line 3918, distance to camGroup at the origin) is 3.8-11. Result: a plain click on the landing/volume sections silently pushState's `/work/<perma>` and rewrites document.title.

**Fix:** Gate picking on the fronting section: `hovered = (front === 'work' && hits.length) ? cards.find(c => c.panel === hits[0].object) : null;` (or skip the raycast entirely unless `front === 'work' || TR.active`, which also saves the per-frame filter/map allocations).

### 1.6 [MEDIUM] God rays ramp back in across the burst->work wipe because __exitFor blends toward work's 0
**Where:** `src/main.js:4196`

__exitFor is the mark's ray RELEASE (rayFade, line 2795): burst stages 1 from burstVh≈198 on, and the comment at 2746-2749 states the wipe band (exitF 0.86 by then) must 'never sweep a lit beam'. But work stages __exitFor 0 (it has no mark, exitF=0 at 2789-2792), and line 4195-4196 lerps `markExit` between the two by TR.t. Through the 160vh band markExit falls 1->0, so uVolumetricStrength (line 4220, wantRays stays true all band via VOLUME.includes(TR.outgoing)) climbs from 0 to ~rayGain(0.5)*HERO.fog(0.65)*deepRay ≈ 0.33, then snaps to 0 the frame the band closes. For TR.t<0.5 the volumetric pass re-renders with the mark ~22 units above the frame — the fan-with-no-apex artifact the release exists to prevent (comment 4181-4190) — plus a full extra occlusion scene render per frame; for TR.t>=0.5 raySource is null (line 4231) so the rising strength multiplies a FROZEN tVolumetricBlur from mid-band. Net: a ray/glow wash fades in over the seam and pops off at its end — the exact 'lights changing at the seam' class this file documents fighting.

**Fix:** Never let a section that stages no mark read as 'not released': `const markExit = TR.active ? Math.max(_ef[TR.outgoing] ?? 0, _ef[front] ?? 0) : (_ef[front] ?? 0);` — max leaves the land->drift seam bit-identical (both stage 0) and holds burst's release at 1 across the work band.

### 1.7 [MEDIUM] Leaf-atlas row index ignores CanvasTexture flipY — every card kind draws the wrong atlas row
**Where:** `src/flora.js:978`

makeLeafAtlas() paints cells 0-3 (single leaves) in the TOP half of the canvas and cells 4-7 (fern/fern/sprig/grass) in the BOTTOM half (cell() translates to Math.floor(i/4)*C from the top, flora.js:314). The texture is a THREE.CanvasTexture, and the vendor three.js Texture base sets flipY = true (three.core.js:7122; CanvasTexture does not override it), so texture v=0 samples the canvas BOTTOM. The shader computes vUvA = (uv + iCell) * vec2(0.25, 0.5) with iCell.y = Math.floor(ci/4) pushed at line 978 — i.e. row counted from the canvas TOP. Result: iCell.y=0 (cells 0-3, kinds 'leaf') samples v in [0,0.5] = canvas bottom half = the fern/sprig/grass paintings, and iCell.y=1 (cells 4-7, kinds 'fern'/'sprig'/'grass') samples the single-leaf row. Within-cell orientation happens to stay upright (bases are painted at the bottom of each cell), so the swap is silent: main.js beds authored as card:fern (e.g. 'floor ferns', main.js:474) actually render ovate single leaves, card:leaf banks render frond/sprig/grass silhouettes, card:sprig renders a broad leaf, card:grass renders the willow leaf. CARD_CELLS kind selection (flora.js:374) is therefore never honored.

**Fix:** At flora.js:978 push the row flipped to account for flipY: `B.cell.push(ci % 4, 1 - Math.floor(ci / 4));`. (Setting tex.flipY = false instead would invert the within-cell base/tip orientation and break the aH bend weighting, so flipping the row index is the minimal correct fix.)

### 1.8 [MEDIUM] vWorldNormal uses mat3(modelMatrix) while the mesh carries a non-uniform 1.5x y-scale
**Where:** `src/jelly.js:118`

The comment at D:/Claude/RevEng/1/work-spine/src/jelly.js:115-117 justifies skipping the inverse-transpose with 'Uniform group scale', but the mesh itself is non-uniformly scaled: body.scale.y = AT_Y_STRETCH (1.5) at jelly.js:641 and clone.scale.y = AT_Y_STRETCH at jelly.js:712. For M = R*S with S = diag(1,1.5,1), the correct normal transform is proportional to R*S^-1, but mat3(modelMatrix)*normal computes R*S*normal — the normal's y component is multiplied by 1.5 instead of divided by it, a 2.25x relative error before normalize(). Every normal tilts toward +/-Y, so the matcap lookup (reflectMatcap at jelly.js:271, whose input is this vWorldNormal plus the nmap perturbation) is systematically skewed toward the matcap's poles across the whole creature. The view-space path (vNormal = normalMatrix * normal, jelly.js:120) is unaffected because three.js's normalMatrix is the inverse-transpose of modelViewMatrix — only the world-space matcap path is wrong.

**Fix:** Compensate the known constant stretch before the matrix multiply: pass a uniform (e.g. uNormalYComp = 1.0/(AT_Y_STRETCH*AT_Y_STRETCH)) and compute vWorldNormal = normalize(mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * (normal * vec3(1.0, uNormalYComp, 1.0))); (R*S*(S^-2 n) = R*S^-1 n). Alternatively compute a proper world normal matrix on the CPU and upload it.

### 1.9 [MEDIUM] Green-core band constants were tuned for the deleted hand-built geometry; on the loaded AT model the glow sits mid-body, not at the bell base
**Where:** `src/jelly.js:382`

coreBand = smoothstep(0.16, -0.04, vY) * smoothstep(-0.46, -0.22, vY) peaks over object-space y in [-0.22, -0.04] and is zero above y=0.16. But per this file's own measurements of the loaded model (jelly.js:14-15, 25-29: 2.052 units tall, centred on the origin, with the bell occupying the 80-90% height band), vY spans about [-1.026, +1.026] and the bell's underside — 'where the bell meets the column', the stated target at jelly.js:368-369 — sits near vY ≈ +0.6. At that height the band evaluates to exactly 0, so the signature glow ('The signature of the chosen reference', jelly.js:359) renders as a stripe roughly 40% of the way down the trailing body, ~0.8 object units below the junction it is documented to mark. The surrounding comment block (jelly.js:374-381) still describes the old lathe frame ('margin plus throat', 'the surface now continues 1.8 units below it' — the loaded model extends only ~1.03 below origin), confirming the constants were never rescaled when the hand-built mesh was replaced by the AT asset. Verifiable by logging geometry.boundingBox after load (computed at jelly.js:513).

**Fix:** Derive the band from the measured bounding box after the decode resolves (loadJellyModel already computes it): junction ≈ bb.min.y + 0.8 * size.y; upload the band edges as two uniforms (e.g. peak [junction-0.05, junction+0.1], fading out by junction-0.35) instead of hard-coded constants, or minimally shift the four constants up by ~0.65 to (0.80, 0.58, 0.14, 0.38).

### 1.10 [MEDIUM] makeStrandTexture seam blend weights are swapped, so the claimed x-wrap does not tile
**Where:** `src/textures.js:215`

The comment (line 212) says the texture is 'Wrapped in x by blending the seam against the same noise sampled a period away'. The code computes `streak = (a * (u) + b * (1 - u)) * 0.5 + 0.5` with a = n(u*3, v*24) and b = n((u-1)*3, v*24). For a seamless wrap the blend must be g(u) = a*(1-u) + b*u, which gives g(0) = g(1) = n(0, v). As written, the value at u=0 is n(-3, v) and the limit at u->1 is n(3, v) — two uncorrelated noise values (the permutation-noise lattice period is 256, and lacunarity 2.03 destroys any shorter period), so texel column 0 and column 63 are discontinuous at full noise amplitude. The texture is set RepeatWrapping (line 235) and is the shipped tMap of the home columns (main.js:1039 -> home.js:205, added at 0.5 strength), so the seam renders as a hard line where the strand geometry's u wraps. Additionally, nothing makes the texture periodic in v at all — n(., v*24) at v=0 vs v=1 compares lattice y 0 vs 24, uncorrelated — yet home.js:198 scrolls texUV.y continuously (`texUV.y += time * 0.1 - cameraPosition.y * 0.03`), so a horizontal discontinuity line permanently exists somewhere on each strand and travels along it as time advances.

**Fix:** Swap the weights to `const streak = (a * (1 - u) + b * u) * 0.5 + 0.5;`. To also fix the scrolled y seam, apply the same period blend in v (bilinear 4-corner blend: sample additionally at (u, v-1) and (u-1, v-1) and weight by (1-v)/v), keeping the *0.5+0.5 remap outside the blend.

### 1.11 [MEDIUM] Module-level RNG stream is still order-dependent across the two racing async chains
**Where:** `src/flower-cloud.js:9`

The header comment (lines 3-7) claims that keying `rand = makeRng(0xF10E12)` to a constant makes 'every consumer get the same numbers regardless of order'. That is only true versus rng.js's global stream. Within this module, ONE stream is shared by consumers on BOTH racing chains: the cloud chain (main.js:200-309 -> retintToPalette x2, buildFlowerCloud x2 at line 403, buildFoliage -> buildRawCloud line 662) and the alcove decode (alcove.js:238 -> buildRawCloud line 662, which draws total*4 values because that cloud has no baked `random`). Chain A has await points at loadFlowerCloud and loadTreeCloud (main.js:202, 292); the alcove chain's draw can land before all of chain A's draws, in the middle (during the tree fetch/decode), or after — so which slice of the stream each consumer gets depends on decode/network timing. Consequences: the foliage walls' and clouds' aRandom changes between loads at a fixed seed (outer-spiral membership `step(0.95, random.y)` is layout-visible), and because measureTransformed (line 453) consumes the aRandom array, even the spine cloud's fitted scale/centring can differ run to run — exactly the nondeterminism rng.js documents this pattern as preventing ('A subsystem that builds asynchronously takes ONE of these', rng.js:58-59, singular per subsystem).

**Fix:** Give each consumer its own stream created inside the call: e.g. in buildFlowerCloud, buildRawCloud, retintToPalette and loadTreeCloud, `const rnd = makeRng(0xF10E12 ^ SALT)` (distinct SALT per function, optionally xor an opts.seed for instance variety), instead of drawing from one module-level stream.

### 1.12 [MEDIUM] Growth cloud steals randoms from flower-cloud's seeded stream inside a racing async chain, breaking cross-load determinism
**Where:** `src/alcove.js:238`

buildRawCloud is called with {position: gpos, color: gcol, count: total} and no `random` array, so buildRawCloud's fallback (flower-cloud.js:661-662) generates count*4 = ~384,000 values from flower-cloud.js's module-level stream `makeRng(0xF10E12)`. That same stream is consumed by the flower-cloud chain (buildFlowerCloud rand draws at flower-cloud.js:403, retintToPalette jitter at :540) which runs in a separate async IIFE (main.js:202-274) racing the alcove's own `await Promise.all` of 7 fetch+Draco decodes (alcove.js:116-124). Whichever chain resolves first takes the earlier slice of the stream, so the aRandom (sparkle/wobble) values of the hero/spine flower clouds shift between loads at a fixed seed — exactly the failure class rng.js:44-56 documents and that alcove.js's own header (line 6: 'Own stream — built inside an async Promise.all that races the cloud chain') claims was closed. The makeRng(0xA1C07E) isolation covers only alcove's direct rand() calls; the indirect consumption through buildRawCloud's fallback pierces it. This silently undermines the project's pixel-reproducibility guarantee for visual regression (rng.js:1-8), even though the alcove group itself is invisible.

**Fix:** In alcove.js, fill a `const grnd = new Float32Array(total * 4)` from the module's own `rand` inside the sampling loop and pass it: buildRawCloud(shared, { position: gpos, color: gcol, random: grnd, count: total }, ...). buildRawCloud already prefers cloud.random when length === count*4.

### 1.13 [MEDIUM] Gate test proves a scroll table that no longer exists (burst 140 vs shipped 520)
**Where:** `test/ranges.mjs:27`

ranges.mjs hardcodes LENGTHS = { land:105, drift:140, gather:140, burst:140, work:1050 } (1575vh track) and asserts total 1575, work.startVh 525, B4 = 525/1475. src/sections.js:112 ships SECTION_VH = { ..., burst: 520, ... } — a 1955vh track with Work starting at 905vh. The test still exits PASS because it is self-consistent, so the repo's stated gate ('Run it before changing any length', README:257) now green-lights without proving anything about the shipped table. The load-bearing invariant (work span clamps to 950vh) does still hold for the real table (1855 travel − 905 start = 950), but the test no longer demonstrates it.

**Fix:** Update LENGTHS.burst to 520 and the expectations: total 1955, travel 1855, drift/gather/burst starts 105/245/385 unchanged, work.startVh 905, B4 = 905/1855; keep the span-950 and affine-commute assertions as-is.

### 1.14 [MEDIUM] Sweep default offsetVh=525 samples 380vh before the Work section
**Where:** `test/sweep.js:17`

The IIFE is invoked with no argument, so offsetVh is always the default 525. Work now starts at 905vh (src/sections.js:112: burst 520). Stops 0..~380 land mid-burst where work-local wp is clamped to 0 (they happen to reproduce the wp=0 rail pose), but every later stop samples the wrong rail position — e.g. workVh 475 lands at absolute 1000vh, wp = (1000−905)/950 ≈ 0.10 instead of 0.5 — so compare.mjs reports a wall of spurious camPos/camQuat/uScroll FAILs against baseline.json and the harness is unusable until the constant is hand-corrected.

**Fix:** Change the default to 905, or better, derive it in-page: compute the work start from the track height minus the known 950vh span, or expose RANGES on window and read ranges.work.startVh.

### 1.15 [MEDIUM] Committed 'PNG' is actually Active Theory's index.html — the emblem's authored normal map never loads
**Where:** `assets/at/jungle_soil_normal.png:1`

The file begins '<!DOCTYPE html>...<title>Active Theory · Creative Digital Experiences' — it is activetheory.net's SPA index page saved under a .png name (verified on disk AND in the HEAD blob via git cat-file; committed in e3f54e5). Mechanism: scripts/fetch-assets.mjs:106-107 validates only res.ok, and activetheory.net answers the missing path 'assets/images/jungle_soil_normal.png' (fetch-assets.mjs:62) with 200 + index.html, so the HTML was saved and then committed via the .gitignore:46 whitelist. Consequence: textures.js loadLogoNormal() (line 142) can never decode it, so the error callback always fires and the emblem's AboutLogoShader silently runs on the procedural water-normal fallback — the authored screen-space 'liquid glass' relief (uNormalStrength 0.24, emblem.js:24) ships for no one, and the console message 'missing — npm run fetch:assets' misdirects because re-fetching returns the same HTML. Side effect: this file is also the one .gitattributes:7-9 documents as 'smudged from 5,952 to 5,996 bytes' by CRLF conversion — git classified it as text because it IS text; the corruption incident was diagnosed without noticing the file was never a PNG.

**Fix:** Find the real URL (the sibling normal lives under assets/images/pbr/ — try assets/images/pbr/jungle_soil_normal.png, or read the path from AT's versioned uil.<cache>.json), re-fetch, verify magic bytes (\x89PNG), and recommit. Also make scripts/fetch-assets.mjs reject non-asset payloads: check content-type and/or first bytes before writeFileSync, so a SPA 200-fallback can never be saved as an asset again.

### 1.16 [LOW] Normals transformed with mat3(modelMatrix)*mat3(instanceMatrix) under non-uniform instance scale
**Where:** `src/world.js:40`

iridescentMaterial's vertex shader computes `vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal)`. The instances are non-uniformly scaled — vertebrae use s.set(r, 0.5|0.8, r) (line 88) and blades s.set(sc, sc*(0.7+rand()), sc) (line 112) — and transforming normals by the plain upper-3x3 of a non-uniform matrix skews them (correct is the inverse-transpose). The fresnel term `dot(N, viewDir)` is therefore wrong on every squashed instance, biasing the rim glow. Impact is limited: this material only renders on the fallback proxy (hidden unless the GLB fails or ?spine=off), which is why it has gone unnoticed.

**Fix:** Compute the normal matrix per instance in the shader as `transpose(inverse(mat3(modelMatrix * instanceMatrix)))` (WebGL2 is available) or pre-normalise by dividing the columns by their squared lengths; alternatively accept it and note it, since the proxy is a fallback.

---
## 2. Low-confidence bugs

Reported by readers, not individually re-verified (severity low). Leads — verify before fixing.

- **`src/main.js:1634`** — Bloom high-pass NaN scrub uses mix(), whose 0*NaN arithmetic is not guaranteed to remove NaN — the 'structurally unable to propagate' claim does not hold on all GPUs. *Fix:* Replace the mix with a selection that performs no arithmetic on the suspect value. The bloom shaders compile as GLSL ES 3.00 under WebGL2 in three r180, so use isnan: 'texel.rgb = clamp(texel.rgb, vec3(0.0), vec3(6.0e4));\nif (any(isnan(texel.rgb))) texel.rgb = vec3(0.0);' — or per-channel ternaries (texel.r = texel.r == texel.r ? texel.r : 0.0; etc.) if ESSL1 compatibility is wanted.
- **`src/main.js:2902`** — stageSection computes dofPass uFocusDist from the PREVIOUS staging's camera/emblem poses. *Fix:* Move the uFocusDist block to the end of stageSection, after camGroup.updateMatrixWorld(true) (line 3199) and the emblem placement (3217-3223), keeping the existing `dofFocusV.y -= markExitY` compensation.
- **`src/main.js:3193`** — Land camera 'look back at the artifact' counter-rotation has inverted sign (and ~1/7 the needed magnitude). *Fix:* Use `camera.rotation.set(-(driftY + camPar.y) / ABOUT_CAM_Z, (driftX + camPar.x) / ABOUT_CAM_Z, 0)` (or fix the comment if the tiny same-direction wobble is the intended look).
- **`src/main.js:3181`** — Land idle drift runs on raw clock.elapsedTime, so a tab switch teleports the camera — against the file's own one-clock rule. *Fix:* Use the module-level `animTime` instead of `clock.elapsedTime` for ft (stageSection already lives in the same module scope).
- **`src/main.js:3248`** — faceOn is re-rounded every frame during the square-to-camera blend; a drag across a ±180° boundary steps the mark's rotation by squareF·2π in one frame. *Fix:* Latch faceOn once when squareF first exceeds 0 (reset when it returns to 0), or round `markRot` sampled at the blend's start instead of the live value.
- **`src/main.js:4465`** — applySize never reconciles devicePixelRatio changes. *Fix:* Track the ratio in applySize: `const dpr = LOW ? 1 : Math.min(devicePixelRatio || 1, 1.5);` and when it differs from the current one call renderer.setPixelRatio(dpr) and composer.setPixelRatio(dpr) before the existing sizing (also drop the module-const DPR reads in favour of the tracked value).
- **`src/flora.js:475`** — Growth sweep never completes for centre-most instances: grow tops out at 0.87 at full reveal. *Fix:* Raise the headroom so the worst case reaches 1 at uReveal=1: use `uReveal * 2.05` (2.05 >= 1 + 0.85 + 0.18 + epsilon), or reduce the offsets, e.g. `(1.0 - iGrow) * 0.75 - iRand.z * 0.15` with the 1.9 multiplier.
- **`src/flora.js:497`** — Silhouette jitter assumes unsigned noise: '- 0.5' biases displacement inward on signed simplex. *Fix:* Drop the '- 0.5' and halve the amplitude to keep the intended magnitude: `posL += normal * cnoise(position * 7.0 + iRand.w * 19.0) * 0.0225;`
- **`src/flora.js:988`** — Dust is sampled from variant-0 geometry even for instances that render variant 1 or 2. *Fix:* Sample from the geometry the instance actually rides: `const g = bedIsCard ? geos[bed.proto] : variants[bed.proto][B.vid[B.vid.length - 1]];` (the vid was pushed at line 955, just above).
- **`src/flora.js:774`** — Dust point-size clamp is a fixed 4 physical pixels while the size term scales with resolution — DPR/resolution gap. *Fix:* Scale the ceiling with the same resolution factor so the cap is '4 px at 680p': `gl_PointSize = clamp(uSizePx * (uResolution.y / 680.0) * (22.0 / len), 0.0, 4.0 * (uResolution.y / 680.0));` — or clamp the pre-resolution term instead: `clamp(uSizePx * 22.0 / len, 0.0, 4.0) * (uResolution.y / 680.0)`. If the 4-physical-px cap is intentional for the DOF depth-footprint argument (line 1199), the comment at 772-773 should say the proportionality only holds below the cap.
- **`src/comet.js:372`** — Head-first drift integrates without bound, keeps running while the comet is hidden, and is never reset. *Fix:* Track cumulative travel in update() and clamp it (e.g. stop adding once |offset| exceeds a few units, or ease the offset back toward zero), or expose a reset() that main.js calls when the section is re-staged; alternatively skip integration when the group is not visible in the scene.
- **`src/textures.js:247`** — makeNormalTexture is not actually tileable despite its 'Tiling water-style normal map' contract. *Fix:* Make the height field genuinely periodic before differentiating: either integer-frequency lattice-wrapped noise (frequencies 4/8/16 with lacunarity 2.0 and lattice coordinates taken mod frequency), or blend the existing field across both edges (bilinear blend of n(u,v), n(u-1,v), n(u,v-1), n(u-1,v-1) with weights (1-u)(1-v) etc.) and derive the normals from that.
- **`src/textures.js:168`** — makeEnvTexture equirect fallback has a longitude seam in the horizon band. *Fix:* Blend the cloud term across the u seam: `cloud = (n(u*5, v*5,4) * (1-u) + n((u-1)*5, v*5, 4) * u) * 0.5 + 0.5` (correct weight order — value at u=0 and u=1 both become n(-5.., .) i.e. n(0-shifted) — or use an integer-period wrapped noise).
- **`src/flower-cloud.js:498`** — Stacked copies rotate about the group origin, not the cloud's centroid, so each copy sits laterally off the column. *Fix:* Compensate the rotation inside the loop: after setting dup.rotation.y = a, set dup.position.x = fitStats.cx - (Math.cos(a)*fitStats.cx + Math.sin(a)*fitStats.cz) and dup.position.z = fitStats.cz - (-Math.sin(a)*fitStats.cx + Math.cos(a)*fitStats.cz) (local units, in addition to the existing y shift), so each copy rotates about the cloud's own centroid.
- **`src/flower-cloud.js:399`** — buildFlowerCloud crashes on a colourless bake, silently dropping the entire environment chain. *Fix:* In buildFlowerCloud, guard: `if (!color) throw new Error(cloud.meta?.name + ': no colour data — pass opts.color')` (or synthesise a flat colour array), so the failure is explicit and near its cause.
- **`src/flower-cloud.js:672`** — uSparkle default 0 leaves the load-transient sparkle flash permanently ON for consumers that never drive it. *Fix:* Default `uSparkle: { value: 2.0 }` in buildRawCloud (transient fully faded) and let callers that want the load flash reset it to 0 and accumulate — or drive growthUniforms.uSparkle in alcove's update like foliage.js does.
- **`src/home.js:157`** — COLUMN_VS vTop smoothstep degenerates to equal edges (division by zero) whenever uVisible <= 0.8. *Fix:* Floor the fade width and gate the appearance explicitly: `float w = 2.0 * smoothstep(0.8, 1.0, uVisible); vTop = smoothstep(9.8, 9.8 - max(w, 1e-3), pos.y) * smoothstep(0.8, 0.83, uVisible);` — removes the zero division and converts the one-frame pop into a short fade while keeping the tube hidden through the early entrance.
- **`src/about.js:157`** — About layer is permanently aria-hidden while its service links stay keyboard-focusable. *Fix:* Toggle visibility with the .on class so hidden links leave the tab order: `.AboutDOM { visibility: hidden; transition: opacity .5s ease-out, visibility 0s .5s } .AboutDOM.on { visibility: visible; transition-delay: 0s }`; and in setActive also do `root.setAttribute('aria-hidden', String(!active))` (or add the service links to the GLA11y mirror if the GL-layer-always-hidden pattern is intended).
- **`src/transition.js:34`** — uRatio never set from viewport aspect — the wipe's aspect-corrected incline is inert. *Fix:* In applySize (src/main.js, next to line 4489) add `transitionPass.uniforms.uRatio.value = w / h;` (or compute the incline from the existing `resolution` uniform inside the shader, as squareUV already does at line 74). The 0..1+inclination span remap at lines 89/95/123 already handles any inclination, so no other change is needed.
- **`src/filmseq.js:390`** — First setProgress call discards undrained skeleton queue entries permanently. *Fix:* After the lookahead wants in setProgress (line 405-408), re-want any skeleton frame not yet cached: `if (loaded === FRAME_COUNT) { for (let i = 0; i < FRAME_COUNT; i += SKELETON_STRIDE) want(i); want(FRAME_COUNT - 1); }` — 41 cheap checks per call, and they sit at the queue tail so the playhead keeps priority.
- **`src/filmseq.js:379`** — Exact-frame rebind bypasses the monotonic-display guard, so the film can still step backward against travel. *Fix:* Apply the same acceptance test to the exact frame: at line 379, `if (show && shownIdx !== showIdx && !(shownIdx >= 0 && (showIdx - shownIdx) * lastDir < 0)) { blit(show); shownIdx = showIdx; }` — a true reversal flips lastDir, so legitimate backward playback is unaffected.
- **`src/cards.js:466`** — Mobile/desktop card layout latched at build while uPhone follows resize — the two disagree after rotation. *Fix:* Either rebuild the per-card placement and camTargets in applySize when the portrait flag changes (re-running lines 472-508's position math in place), or make the two consistent by setting uPhone once at build from the same latched `mobile` flag instead of flipping it in resize.
- **`src/glsl-chunks.js:78`** — inverseTransformDirection has an extra matrix premultiply, making it a no-op — reflection()/refraction() return view-space, camera-locked directions. *Fix:* Change line 78 to `return normalize((vec4(n, 0.0) * matrix).xyz);` (drop the leading `matrix *`).
- **`src/physarum.js:110`** — Diffuse kernel offsets by a full texel instead of half — zero centre weight, trail field decouples into two checkerboard lattices. *Fix:* Offset by half a texel: sample at vUv ± vec2(0.5*uTexel.x, 0.5*uTexel.y) (all four diagonal combinations), keeping sum*0.25*uDecay.
- **`src/planets.js:39`** — Custom fog uses squared radial view distance while three.js FogExp2 uses planar depth — planets fog harder off-axis than the scene around them. *Fix:* Use planar depth to match the engine: `vFog = 1.0 - exp(-uFogK * uFogK * mv.z * mv.z);` (mv.z is negative; squaring handles it). Same change in canopy.js:108.
- **`src/fluid.js:374`** — update() 'restores' a hardcoded black clear color instead of the caller's. *Fix:* Capture `renderer.getClearColor(tmp)` and `getClearAlpha()` at the top of update() and restore those values at the end, as volumetric.js does.
- **`src/fluid.js:377`** — dispose() leaks all eight ShaderMaterials (compiled programs stay in the renderer cache). *Fix:* In dispose(), call .dispose() on each ShaderMaterial (and depositMat in physarum.js).
- **`shot.mjs:18`** — wp:N/M stop mapping applies the rail dead-zone to global progress, but the rail runs on work-local progress. *Fix:* Remap into Work's global window: const B4 = 905/1855; return B4 + (0.06 + invSmoothstep(N/M) * 0.88) * (1 - B4); (or read the range table from the page).
- **`package.json:5`** — Documented `npm run vendor` script does not exist. *Fix:* Add "vendor": "node scripts/vendor.mjs" to package.json scripts.
- **`scripts/vendor.mjs:120`** — vendor/ is deleted before inputs are validated. *Fix:* Pre-flight: verify every ENTRIES[0] and RAW_COPIES[0] path exists (fail before touching OUT), or build into vendor.tmp/ and rename over vendor/ only on success.
- **`index.html:208`** — NavUI Work/Contact links are inert — no anchors, no handler. *Fix:* Wire a click handler that lenis.scrollTo()s to RANGES.work.startVh * vh (and a contact target), or remove the hrefs/pointer styling until navigation exists.
- **`.gitignore:2`** — package-lock.json is ignored — dependency installs are not reproducible. *Fix:* Delete line 2 and commit package-lock.json.
- **`test/compare.mjs:63`** — Zero compared samples still exits PASS. *Fix:* After the loop: if (compared === 0) { console.error('FAIL: no samples compared'); process.exit(1); }
---
## 3. Dead files (source)

Whole source files nothing imports. Verified: zero references outside their own definitions.

### `src/fluid.js — entire module (FluidBackground, 383 lines): the Stam fluid backdrop is never instantiated`
- **Where:** src/fluid.js:179 (export class FluidBackground)
- **Evidence:** Greps run over the whole repo (glob !node_modules): `FluidBackground|fluid\.js|PhysarumBackground|physarum` (case-insensitive) → matches only README.md:193-202, shot.mjs comments (67, 73), and the two files themselves; `\bfluid\b` (case-insensitive) → same plus an unrelated flora.js prose comment; `import\(` repo-wide → only a comment in scripts/vendor.mjs; index.html loads a single module (line 251: src/main.js) and main.js's import block (lines 10-31) contains neither file. main.js:79 sets scene.background to a flat THREE.Color, so no background texture consumer exists. README.md:199-202 documents the file deliberately (license/attribution narrative), and shot.mjs:67 still sweeps the mouse 'so the fluid backdrop has something to show' — a stale assumption.
- **Fix:** Delete src/fluid.js (or re-wire it as the scene.background it was written for); update README.md:199-202 and drop the shot.mjs:67-72 pointer sweep.

### `src/physarum.js — entire module (PhysarumBackground, 374 lines): the slime-mould fiber backdrop is never instantiated`
- **Where:** src/physarum.js:179 (export class PhysarumBackground)
- **Evidence:** Same greps as fluid.js: `PhysarumBackground|physarum` (case-insensitive, repo-wide, !node_modules) → only README.md:193-194, shot.mjs:73 comment, and the file itself; no static import in any src file, no dynamic import() anywhere, index.html loads only src/main.js. Kept described in README's attribution section. Consequence of the staleness: shot.mjs:73-74 still waits 6000 ms per scroll stop 'for the transport network to emerge' — pure dead time in every screenshot run.
- **Fix:** Delete src/physarum.js (or re-wire it); remove the 6 s wait at shot.mjs:73-74 and update README.md:193-194.

### `feedback-report.txt — untracked, unignored debugging note`
- **Where:** feedback-report.txt
- **Evidence:** git status --short shows it as the sole '??' entry in the repo; nothing references it (grep -rn feedback-report over *.md/*.mjs/*.js/*.json/*.html finds no hits). It is a 342-byte note from a feedback-sources GPU debugging session (Aug 17). It is the only incoherence in the otherwise clean tracked-vs-ignored state.
- **Fix:** Delete it, or move its content into docs/ and commit, or add it to .gitignore.

### `Capture debris directories: cmp_raw/, cmp_high/, cmp_max/, frames/, shots/, glitchshots/`
- **Where:** cmp_raw
- **Evidence:** cmp_* hold Jul 31 shot.mjs runs (p033/p047.png pairs) comparing the spine GLB presets; frames/ holds Aug 17 Capture-Frames.ps1 output (vh1000-vh1030); shots/ holds Jul 31 shot.mjs output; glitchshots/ is empty. grep -rn 'cmp_' over all source/docs finds zero references. All six are covered by .gitignore (cmp_*/, *shots/, frames/) and none is tracked — coherent, pure local debris.
- **Fix:** Safe to delete locally at any time; no repo change needed.

---
## 4. Dead assets

Nothing in src/, index.html, scripts/ or tooling loads these; dynamic path construction was checked. Sizes included — this is the deletable weight.

### `test/after.json — stale 1575vh-era sweep capture`
- **Where:** test/after.json
- **Evidence:** Its trackVh is 1575 with offsetVh 525 and programs 23; the current build is a 1955vh track with 57 programs. The file is correctly gitignored (.gitignore:14) and regenerated per verification run — the on-disk copy is just a leftover from the Aug 7 run.
- **Fix:** None needed in git; delete locally or regenerate with the corrected offset (see sweep.js bug).

### `damaged_road_normal.png — 2,082,201 bytes (~2.0 MB)`
- **Where:** assets/at/damaged_road_normal.png
- **Evidence:** Greps run: 'damaged_road' across src/, index.html, scripts/, test/, *.mjs, README.md, docs/, .gitignore, Capture-Frames.ps1 — zero matches anywhere (only the initial combined grep listed the pattern; no file hit). Not in fetch-assets.mjs FILES/ENV_FILES, not whitelisted in .gitignore (git check-ignore confirms ignored; git ls-files confirms untracked). Local leftover dated Aug 8.
- **Fix:** Delete the local file (untracked, so no repo change needed).

### `flower_spine-1024.bin — 7,319,229 bytes (~7.0 MB)`
- **Where:** assets/at/flower_spine-1024.bin
- **Evidence:** Greps run: 'flower_spine-1024', '1024.bin', 'flower_spine-' repo-wide. Only comment mentions: flower-cloud.js:14 (LOD family list) and fetch-assets.mjs:26 which explicitly says '1024 is 7.3 MB, so only the two middle LODs are pulled by default'. No loader call and no LOD query flag exists — main.js:202 hard-codes 'assets/at/flower_spine-512.bin'. Untracked (gitignored, not whitelisted).
- **Fix:** Delete the local file, or add a ?cloud= LOD flag if the 1M-point tier is wanted.

### `flower_spine-256.bin — 488,380 bytes; fetched on every `npm run fetch:assets` (incl. deploy builds) but never loaded`
- **Where:** assets/at/flower_spine-256.bin (fetched by scripts/fetch-assets.mjs:27)
- **Evidence:** Greps run: 'flower_spine-256' repo-wide — only scripts/fetch-assets.mjs:27. The app loads only the 512 tier (main.js:202); no dynamic `flower_spine-${...}` construction exists (grep 'flower_spine-'). Untracked. Header oddity: its embedded AT container name is 'flower_spiral-256', not 'flower_spine-256'.
- **Fix:** Remove line 27 from FILES in scripts/fetch-assets.mjs (saves 488 KB per fetch/deploy) and delete the local file, or wire an LOD fallback that actually uses it.

### `black.jpg — 1,129 bytes (4x4 black JPEG)`
- **Where:** assets/at/black.jpg
- **Evidence:** Greps run: 'black.jpg' / 'black\.jpg' repo-wide. Only hit is a comment (textures.js:47) documenting AT's uil binding 'assets/images/_scenelayout/black.jpg'; nothing loads 'assets/at/black.jpg'. Not in fetch-assets.mjs FILES (removed at some point — file dated Jul 31), not whitelisted, untracked.
- **Fix:** Delete the local file; keep the textures.js documentation comment.

---
## 5. Dead code in live files

- **spinePath import in main.js** — `src/main.js:11`
  - grep -n "\bspinePath\b" src/main.js -> only line 11 (the import). Repo-wide grep (src/, scripts/, test/, *.mjs, index.html, README.md): spinePath is used in src/cards.js, src/spine-glb.js and src/world.js via their own imports from world.js; main.js never references it after importing.
  - *Fix:* Remove spinePath from the import list on line 11 (keep the export in world.js — other modules use it).
- **CARD_ORBIT and CAM_ORBIT imports in main.js** — `src/main.js:28`
  - grep -n "CARD_ORBIT\|CAM_ORBIT" src/main.js -> line 28 (import), line 125 (comment), line 210 (comment). Both are only referenced in comments; code uses them nowhere in main.js. Repo-wide grep shows they are defined and used inside src/cards.js (lines 45-46, 477).
  - *Fix:* Change line 28 to import { buildCards } from './cards.js'; the comments can keep citing the constants by name.
- **Composite uniform uScrollDelta — declared and written every frame, never read in the composite fragment shader** — `src/main.js:1643 (value), 1690 (GLSL declaration), 4052 (per-frame write)`
  - Grep `uScrollDelta` repo-wide: live uses are shared.uScrollDelta (main.js:139/3616/3639, world.js:295/315/331, plus comet.js/nebula.js doc comments). In the composite, `sed -n '1741,2066p' src/main.js | grep uScrollDelta` → zero occurrences in the shader body; only the declaration at 1690. Line 4052 (`u.uScrollDelta.value = shared.uScrollDelta.valu
  - *Fix:* Remove the uniform entry at 1643, the declaration at 1690, and the write at 4052.
- **Unused constant ABOUT_LOGO_SCALE (8.05 / 3.22)** — `src/main.js:2434`
  - Greps: `grep -rn ABOUT_LOGO_SCALE src index.html scripts test README.md *.mjs` → only main.js:2434 defines the bare identifier; the other two hits (2466, 3276) are the DIFFERENT constant ABOUT_LOGO_SCALE_XY. The land branch scales the emblem with ABOUT_LOGO_SCALE_XY (3276) and computes its own y-travel with a direct lerp (3273). The comment block a
  - *Fix:* Delete line 2434 (its rationale is already preserved in the 2431-2433 comment).
- **Dead call: `const t = about.logoTransform(landPF, dragRotation)` — result never used** — `src/main.js:3264`
  - In the land branch, `t` is never read: emblemPos is set from a direct lerp at 3273 and the rotation at 3282-3284 explicitly does 'NOT t.rotY' (comment 3277). about.logoTransform (src/about.js:190-196) is pure — it returns a fresh object literal `{y, rotY}` with no side effects or internal state. Greps: `grep -rn logoTransform src test scripts docs 
  - *Fix:* Delete line 3264 (the AT formula it wraps is already quoted in about.js for reference).
- **unused `const t = about.logoTransform(landPF, dragRotation)` in the land branch** — `src/main.js:3264`
  - Ran `grep -rn logoTransform src` — definition at about.js:190 (pure: returns {y, rotY}, no side effects) and this sole call. Within the branch (3264-3296) `t` appears only in the comment 'NOT t.rotY'; neither t.y nor t.rotY is read. Executed on every land staging for nothing.
  - *Fix:* Delete the call; the comment explaining why t.rotY is not used can stand on its own.
- **protoVine() and the PROTOS.vine entry — the 'hanging vine' prototype is never instantiated** — `src/flora.js:194-214 (function), src/flora.js:261 (PROTOS registration)`
  - Prototypes are only reachable via PROTOS[bed.proto] where bed.proto strings come from the single buildFlora call site. Greps run: (1) `vine` case-insensitive across the whole repo (src/, docs/, index.html, scripts, *.md) — hits are only comments (flora.js:16,21,217,812; main.js:327,601; docs/water-section-plan.md:96), no `proto: 'vine'` anywhere; (
  - *Fix:* Delete protoVine and its PROTOS entry (and update the header list), or leave with a comment noting it is an unused alternative to 'creeper'.
- **`rad` — a THREE.Vector3 allocated for the interact() closure and never referenced** — `src/flora.js:1300 (`const cp = new THREE.Vector3(), rad = new THREE.Vector3();`)`
  - Grep `\brad\b` across the repo (*.js, *.mjs, *.html, *.md): the only hit in flora.js is the declaration itself; the flower-cloud.js:349-351 and nebula.js:319 hits are an unrelated local and a comment. `cp` in the same declaration IS used (line 1402). Likely a leftover from the removed radial-force version (the comments at 1267-1268 and 1395-1396 em
  - *Fix:* Remove `, rad = new THREE.Vector3()` from line 1300.
- **`vEdge` varying — written by the vertex shader, declared in the fragment shader, never read** — `src/flora.js:453 (VS declaration), 580 (VS write `vEdge = iEdge;`), 631 (FS declaration)`
  - Grep `vEdge` across the repo: only flora.js:453/580/631 plus canopy.js:53/74/122/139 — canopy.js is a separate, unrelated shader that does consume its own vEdge. In FLORA_FS main() (lines 635-742) vEdge is never referenced; the iEdge attribute itself is live (rim shrink at VS line 479), only the varying plumb to the fragment stage is dead.
  - *Fix:* Delete `vEdge` from both varying declaration lists and remove the write at line 580 (drops one interpolated float per fragment).
- **COLOR_UTILS GLSL chunk injected into JELLY_FS (and its import) is never referenced by the shader** — `src/jelly.js:159 (injection), src/jelly.js:2 (import)`
  - grep -n 'rgb2hsv|hsv2rgb|crange' src/jelly.js matches only comment lines 436 and 439 (which say the crange-based fade was removed) — none of COLOR_UTILS's three functions (rgb2hsv, hsv2rgb, crange, per src/shaders.js:61-78) is called anywhere in JELLY_FS or JELLY_VS. Repo-wide grep for buildJelly consumers (src/main.js only) shows no dynamic shader
  - *Fix:* Delete `${COLOR_UTILS}` from JELLY_FS and drop COLOR_UTILS from the import on line 2 (NOISE is still used).
- **resolution uniform entries on both comet materials; neither shader declares `resolution`** — `src/comet.js:325 (filMat) and src/comet.js:347 (sparkMat)`
  - grep -n 'resolution' src/comet.js matches only lines 325 and 347 — the identifier does not appear in FILAMENT_VS, FILAMENT_FS, SPARK_VS, or SPARK_FS. three.js silently skips uniforms with no active location, so this is inert. Repo-wide grep (src/, scripts/, test/, *.mjs, index.html, README.md) shows comet is consumed only via src/main.js:1153/3330-
  - *Fix:* Delete the `resolution: shared.uResolution,` line from both uniform bags (or add the declaration if screen-space work is ever intended).
- **aRnd.w spark attribute channel is written with rand() but never read** — `src/comet.js:158 (write); SPARK_VS/SPARK_FS read only .x, .y, .z`
  - SPARK_VS (comet.js:240-262) reads aRnd.x and aRnd.y; SPARK_FS (comet.js:265-289) reads vRnd.x and vRnd.z; .w is only copied through the varying. The seeding comment at comet.js:134 explicitly documents the lane as 'unused', so it is kept deliberately — but it still costs a per-vertex float and an RNG draw. Grep of the whole repo shows no other cons
  - *Fix:* Either leave as documented padding, or shrink aRnd to a vec3 and drop the fourth rand() call in seedSparks.
- **The mist instance's aurora ribbon is a permanently disabled feature: buildNebula always constructs it, but the mist is created with aurora: 0 and its uAurora is never raised** — `src/nebula.js:338-359 (unconditional construction); src/main.js:1177 (mist = buildNebula(shared, { clouds: MIST_CONFIG, aurora: 0 }))`
  - grep -n 'uAurora' src/main.js → only line 3541, which writes nebula.uniforms.uAurora (the other instance); mist's only uniform write is mist.uniforms.uNebula at main.js:3551. So the mist's 6x34 aurora plane (768 tris, DoubleSide, frustumCulled=false at nebula.js:358) exists solely to render at alpha 0 forever. See the matching perf entry for the fr
  - *Fix:* Gate construction: if ((opts.aurora ?? 1) > 0) build the aurora, else skip the geometry/material/mesh entirely (return aurora: null and guard the stats line).
- **Unused return-surface members: jelly `get body()` and `get stats()`, comet `stats`, nebula `stats` and `aurora`** — `src/jelly.js:683 (get body), src/jelly.js:733 (get stats); src/comet.js:383-388 (stats); src/nebula.js:364 (aurora), src/nebula.js:387-391 (stats)`
  - Repo-wide greps excluding vendor/node_modules: grep -rn '\.stats\b' → only flowers/heroCloud/foliage/flora/emblem/alcove in src/main.js (223, 282, 309, 522, 890, 967) — never jelly/comet/nebula/mist; grep -rn 'jelly\.body|\.ready\b' src scripts test index.html *.mjs README.md → only alcove.ready (main.js:967); grep -rn '\.aurora\b' src scripts test
  - *Fix:* Leave if wanted as console-debug surface (matching the pattern main.js uses for flowers/foliage), or delete the getters/objects to shrink the API.
- **makeStudioEnv() — 46-line HDR studio environment generator, exported and never called** — `src/textures.js:322-367`
  - Greps run: `grep -rn makeStudioEnv --include=*.js --include=*.html --include=*.mjs --include=*.md .` (node_modules excluded) and case-insensitive `grep -rni studioenv src scripts test index.html *.mjs` — only the definition matches. emblem.js imports only loadJellyMatcap/loadLogoNormal, and its header (emblem.js:17) says the emblem 'was MeshPhysica
  - *Fix:* Delete the function (and its export), or park it in docs/git history if the old material may return.
- **makeSpineGlitterTextures() — ~190-line basecolor/normal/roughness/thickness bake for the spine, exported and never called** — `src/textures.js:386-576`
  - Greps run: `grep -rn makeSpineGlitterTextures ...` (same include set, whole repo) and case-insensitive `grep -rni 'spineglitter\|glittertextures'` — only the definition. spine-glb.js imports no textures module (its imports are three, GLTFLoader, MeshoptDecoder, world.js); the spine now ships a GLB with authored maps, so this whole procedural bake i
  - *Fix:* Delete the function; it is the largest single block of dead code in the file.
- **buildWater's `filmTex` parameter — destructured, never used** — `src/water.js:564`
  - Grep `filmTex` in src/water.js: only the destructure (564) and the doc comment (558-560), which itself says 'unused since the underside became the same water'. Sole caller main.js:939 still passes `filmTex: deepBgTex`. Deliberately kept per that doc comment.
  - *Fix:* Drop the parameter from the signature, the JSDoc, and the call site in main.js.
- **CHUNKS GLSL block — six helper functions (scaleUV, rgb2hsv, hsv2rgb, blendOverlayF, blendOverlay, luma), all unused** — `src/water.js:51-79`
  - Grep `CHUNKS` repo-wide: only water.js lines 51 (definition) and 303 (injection into CEILING_FS). Grep each function name in water.js: only the definitions inside CHUNKS — CEILING_FS's main() (317-382) calls none of them since the rewrite that removed the cracked-ice/video shading. The GLSL compiler dead-strips them, but they cost compile time on a
  - *Fix:* Delete the CHUNKS constant and the `${CHUNKS}` interpolation at line 303.
- **Topside's PlaneGeometry(110, 70) — dead on arrival: the only caller disposes and replaces it immediately** — `src/water.js:652`
  - main.js:945-946: `water.topside.geometry.dispose(); water.topside.geometry = new THREE.PlaneGeometry(260, 260);` right after buildWater returns. The sizing comment at water.js:648-651 ('110 x 70: wider than any frustum ... Position is the caller's') describes geometry that never renders and would mislead a maintainer about the shipped surface size.
  - *Fix:* Accept the size (or a {size} option) in buildWater and build the 260x260 plane directly; update the comment.
- **GLSL variable `radius` in FLOWER_VS — `float radius = mix(0.5, 3.0, pow(random.w, 2.0));`** — `src/flower-cloud.js:172`
  - Read the full shader string: `radius` is declared at line 172 under the 'Outer Spiral' comment and never referenced again — lines 173-174 use the literal 25.0, and the JS mirror measureTransformed (lines 327-384) reproduces the spiral without it. Greps: `grep -n radius src/flower-cloud.js` shows only the declaration plus the unrelated fit-radius JS
  - *Fix:* Delete line 172.
- **varying vWorldPos in FLOWER_VS/FLOWER_FS — written in the vertex stage, never read in the fragment stage** — `src/flower-cloud.js:145, 192, 234`
  - `grep -n vWorldPos src/flower-cloud.js` returns exactly lines 145 (VS declaration), 192 (VS write), 234 (FS declaration); the FS main() (lines 266-311) never references it. (world.js's particle shader has its own vWorldPos which IS used — do not confuse the two.) The linker will strip it, but it is dead source.
  - *Fix:* Remove the varying declaration from both stages and the `vWorldPos = worldPos;` assignment (keep the local `worldPos`, which still feeds vDist).
- **Unreachable ternary arm in loadFlowerCloud: `posAttr.array.buffer === undefined ? posAttr.array : posAttr.array.slice()`** — `src/flower-cloud.js:100-101`
  - Every TypedArray has a .buffer property, and DRACOLoader's default attributeTypes decode position as Float32Array (vendor/three/examples/jsm/loaders/DRACOLoader.js:73-78), so the condition is always false and the first arm can never be taken. The surviving path `new Float32Array(x.slice())` also copies the 3.1 MB position array twice (slice() copie
  - *Fix:* Replace with `const position = posAttr.array.slice();` (one copy, already Float32Array).
- **Unreachable fallback `|| geometry.getAttribute('COLOR')` in loadFlowerCloud** — `src/flower-cloud.js:97`
  - With the vendored DRACOLoader, non-uniqueID decodes name attributes by the lowercase keys of defaultAttributeIDs/defaultAttributeTypes ('position','normal','color','uv' — DRACOLoader.js:73-78 and the worker's `for (const attributeName in attributeIDs)` loop at ~line 582), so an attribute literally named 'COLOR' can never exist on the returned geome
  - *Fix:* Drop the `|| geometry.getAttribute('COLOR')` clause, or keep it with a comment noting it is for foreign DRACOLoader builds only.
- **Constant-false colour-normalisation heuristic: `colAttr.normalized || src instanceof Uint8Array ? 1/255 : 1`** — `src/flower-cloud.js:109`
  - loadFlowerCloud passes attributeTypes = null, so DRACOLoader uses defaultAttributeTypes with color: 'Float32Array' (DRACOLoader.js:73-78); the worker constructs the requested Float32Array (`self[attributeTypes[attributeName]]`, ~line 584), and DRACOLoader.js:287 sets `attribute.normalized = (array instanceof Float32Array) === false` — i.e. false he
  - *Fix:* Simplify to `const norm = 1;` (or delete norm entirely), or explicitly request/handle byte colours if a future bake ships them.
- **makeNoise3's returned `noise` property is never consumed** — `src/world.js:163 (return { noise, fbm })`
  - `grep -rn makeNoise3 src` -> world.js:131 (def) and world.js:192, which destructures only `{ fbm }`. `noise` is used internally by fbm but the returned reference is dead surface. Repo-wide grep finds no other caller.
  - *Fix:* Return only `{ fbm }` (or just the fbm function).
- **heroDrives' `halo` return field — computed every frame, consumed nowhere** — `src/intro.js:171`
  - `grep -n "HERO\." src/main.js` — only .density (2974), .attract (2978), .shock (2979), .push (3139), .nebula (3540), .bloom (4020), .flash (4027), .fog (4220). `grep -rn "halo"` across src/, index.html, README.md, scripts/, test/, *.mjs — only intro.js definitions plus unrelated uses of the word in physarum.js/water.js/main.js comments.
  - *Fix:* Remove the field and its comment (also from the dead introState if that is kept).
- **buildAbout's returned `root` property** — `src/about.js:173`
  - `grep -n "about\." src/main.js` — only about.logoTransform (3264) and about.setActive (3731); `about.root` is read nowhere in src/, test/, scripts/, *.mjs, index.html.
  - *Fix:* Drop the property, or keep it knowingly as a debug handle.
- **loadEmblem's update(dt) method — the idle spin + rotation.x nod is never invoked** — `src/emblem.js:303-310`
  - `grep -rn -E "emblem\.update|e\.update" src/ index.html test/ scripts/ *.mjs` — no call anywhere; the per-frame .update(dt) calls in main.js are jelly (4119), foliage (4120), comet (4121). main.js instead overwrites emblem.mesh.rotation wholesale every frame (3252-3253 in the volume, 3282-3284 in land), which would clobber the nod even if update ra
  - *Fix:* Delete the method and opts.spin, or route main.js's per-frame rotation writes through it.
- **`env: null` in loadEmblem's return object — leftover of the removed PMREM environment** — `src/emblem.js:302`
  - `grep -rn "\.env\b" src/` — only cards.js:153 `deps.env`, a different bag. The header (emblem.js:16-31) documents that the PBR/PMREM stack this belonged to was replaced by the unlit AboutLogoShader port.
  - *Fix:* Remove the property.
- **uAlpha uniform on the emblem shader — never driven, and inert on an opaque material** — `src/emblem.js:88, 203, 284`
  - `grep -n "uAlpha" src/main.js` — every writer targets water/comet/cards/home materials; the generic uAlpha staging loop (main.js:3043-3062) traverses workRoot and filters `isPoints`, so it can never reach the emblem. The material is `transparent: false` (emblem.js:290), so `color.a *= uAlpha` cannot affect blending even if driven.
  - *Fix:* Delete the uniform and the multiply; if an emblem fade is ever wanted it would also need transparent: true, so wire both at that point.
- **buildHome's `stats` return object (plume count, seedTries, columnTris) — never read** — `src/home.js:597-600`
  - `grep -rn "home\.stats|seedTries|columnTris"` across src/, test/, scripts/, *.mjs, index.html, README.md — definitions only. The stats console.logs in main.js cover flowers (223), heroCloud (282), foliage (309), flora (522), emblem (890) and spine (914), never home.
  - *Fix:* Delete the object and seedPlume's `tries` counter, or console.log it like the sibling modules.
- **Varyings written in home.js vertex shaders but never read in their fragment shaders: COLUMN vPos and vWorldPos, PLUME vRippleDist** — `src/home.js:149-150 (decl), 168-169 (assign), 184-185 (FS decl); 239, 322, 388 (vRippleDist)`
  - Read the shader strings line by line: COLUMN_FS main (191-217) reads only vUv and vTop; PLUME_FS main (396-450) reads vLightColor, vPos, vRandom, vScale, vRipple and vWorldPos but never vRippleDist. Likely carried over from the AT source during transcription.
  - *Fix:* Delete the three varyings and their assignments; frees interpolator slots on the 30k-point additive pass.
- **Emblem LOGO shader varyings vPos and vWorldPos never read by LOGO_FS** — `src/emblem.js:63-64, 74-75, 95-96`
  - LOGO_FS main (129-208) reads vUv, vNormal, vViewDir and vMUV only. vWorldPos is consumed solely inside the vertex shader (reflectMatcap input at line 79) and needs no varying; vPos is assigned and never used in either stage's downstream code.
  - *Fix:* Delete the vPos varying entirely; convert vWorldPos to a local vec3 in the vertex shader.
- **Builder option knobs no caller ever passes: home.js columnRadius / columnOffset / plumeAlpha / plumeSizeBias / plumeMaxSize; emblem.js url / matcap / normalMap / normalStrength / spin** — `src/home.js:470, 487, 520, 545, 546; src/emblem.js:215, 279, 280, 282, 307`
  - `grep -rn -E "columnRadius|columnOffset|plumeAlpha|plumeSizeBias|plumeMaxSize|normalStrength|rimLights" src/ index.html scripts/ test/ *.mjs README.md docs/` — only the defining lines match (main.js:1277's `plumeAlpha:` is a debug-log key reading the uniform's value, not the option; the normalStrength hit in jelly.js is that module's own option). b
  - *Fix:* Acceptable to keep as API surface; note that passing main.js's existing jellyMatcap as loadEmblem's `matcap` would remove a duplicate texture upload (see perf).
- **Unused import { spinePath, SPINE_TOP } from './world.js'** — `src/cards.js:7`
  - Neither identifier appears anywhere else in cards.js (in-file scan). Ran `grep -rn 'spinePath|SPINE_TOP' src index.html test scripts *.mjs README.md`: real uses are only in world.js, spine-glb.js and main.js; the cards.js hit is the import line alone.
  - *Fix:* Delete the import line.
- **getFresnel result `float f` never used; uFresnelPow uniform feeds only this dead value** — `src/cards.js:271 (uniform at 155/216)`
  - In the panel fragment shader main(), `f` is assigned at line 271 and never referenced again (full-body scan; the `f` locals in liquidField/fbm2 are separate scopes). `grep -rn uFresnelPow src index.html test scripts *.mjs` hits only cards.js:155/216/271. Likely a port remnant — emblem.js's equivalent `f` (emblem.js:153) IS consumed there. GLSL comp
  - *Fix:* Delete line 271, the uFresnelPow uniform entry (line 155) and its GLSL declaration (line 216).
- **uDistortStrength uniform declared in JS and GLSL, never referenced in any shader body** — `src/cards.js:156, 216`
  - `grep -rn uDistortStrength src index.html test scripts *.mjs` returns only the uniform definition (156) and the GLSL declaration (216); no expression uses it. The line comment marks it as a UIL transcription ('UIL: uDistortStrength = 0'), so it may be kept deliberately as part of the port — listing it regardless.
  - *Fix:* Delete both lines, or keep with a comment stating it is transcribed-but-unused like transition.js does for uVelocity.
- **uScale uniform is a permanently-inert knob: initialized (1,1), never written, scaleUV by identity is a no-op** — `src/cards.js:162 (used at 289)`
  - `grep -rn uScale src index.html test scripts *.mjs`: only cards.js:162/219/289 for this material (water.js's uScale is a different shader's own uniform). main.js writes pMat uniforms uCull/uHover/uFocus/uPointer/uPointerPrev/uVideoBlend/uPhone only (main.js:3892-3941, 4497) — never uScale. `videoUV = scaleUV(videoUV, uScale)` with (1,1) is the iden
  - *Fix:* Delete the uniform and line 289, or wire it to the video texture aspect as the original presumably did.
- **Dead varyings in the panel material: vBackface, vDist, vReflection (plus the reflection() call feeding it)** — `src/cards.js:178/183/186 (writes at 200, 207, 209)`
  - All three are written in the vertex shader and declared in the fragment (line 221-222) but never read in the fragment body (full scan; fragment uses vSide, vWorldPos, vNormal, vViewDir, vRefraction, vPos only). `grep -rn vReflection src` hits only cards.js. Note vBackface is also only conditionally written (line 209) — an uninitialized varying on f
  - *Fix:* Delete the three varyings, the vDist/vReflection assignments and the `vBackface = 1.0` statement (keep the vUv.x flip).
- **Dead varyings in the label material: vPos, vWorldPos, vCameraPos** — `src/cards.js:403 (writes at 409-411, fragment decl at 421)`
  - Label fragment body (lines 426-453) reads only vUv and vViewDir. `grep -rn vCameraPos src` hits only cards.js:403/411/421. Written every vertex, never consumed; likely carried over from the compiled.vs port.
  - *Fix:* Trim the varying lists to vUv and vViewDir and drop the three assignments.
- **sectionState's `visible` output (and its enterVh parameter and per-frame `enter` computation) has no consumer** — `src/sections.js:159, 166, 170`
  - `grep -rn sectionState src test scripts index.html`: three call sites, all in main.js (1222, 3660, 4630), all two-argument. `grep -n 'S\.(land|drift|gather|burst|work)' src/main.js` shows only `.progress` and `.active` reads; no `.visible` on section state anywhere (checked the stageSection/prewarm loops at main.js:4575-4712 as well). The doc block
  - *Fix:* Remove the enter/visible computation and parameter, or leave a one-line note that no consumer exists yet.
- **sectionState's `range: r` output field has no consumer** — `src/sections.js:171`
  - `grep -rn '\.range\b' src/main.js` returns nothing; consumers that need range data read the buildRanges table directly as RANGES.ranges.<name> (main.js:3785, 3794, 4631-4637).
  - *Fix:* Drop the field.
- **CARD_SDF export (sdRoundBox + sdCardShape chamfered-corner silhouette)** — `src/shaders.js:82-94`
  - Greps: `CARD_SDF|sdCardShape|sdRoundBox` repo-wide (!node_modules) → shaders.js definition plus cards.js:232/264 only — and cards.js defines its OWN inline sdRoundBox ('card silhouette — rounded rect, all corners equal') rather than importing the chunk; no file imports CARD_SDF. The chunk's comment ('the card silhouette used throughout the original
  - *Fix:* Delete the CARD_SDF export from src/shaders.js.
- **SEED export (and the `export` keyword on reseed) in rng.js** — `src/rng.js:79 (SEED), src/rng.js:23 (reseed)`
  - Greps: `reseed|SEED` repo-wide (!node_modules) → only rng.js itself plus the prose word 'reseeds' in a main.js:1245 comment and the unrelated FALLBACK_RANGE constant in filmseq.js; `SEED` is imported nowhere (src, test/, scripts/, *.mjs, index.html checked); reseed() is called only internally at rng.js:77. Note the adjacent ?seed= URL override (rng
  - *Fix:* Drop the unused SEED export and un-export reseed (keep it module-internal); keep the ?seed= override.
- **opts.poolTex parameter of buildAlcove — documented, passed by the caller, never read** — `src/alcove.js:94 (JSDoc), src/main.js:965 (caller)`
  - Grep `poolTex` in src/alcove.js → only the JSDoc line 94; the function body never references it (grep `opts\.` → width, video ×2, matcap only). The pool sprite it fed was removed per the comment at alcove.js:261-264 ('NO pool sprite at the mark'). main.js:965 still calls loadPoolTexture() to supply it — and since THREE.Cache is disabled by default,
  - *Fix:* Remove `poolTex: loadPoolTexture()` from the main.js:965 call and delete the @param line at alcove.js:94.
- **.gitignore 'framames/' entry — typo, matches nothing** — `.gitignore:78`
  - No directory named framames exists (ls) and grep -rn framames over the repo hits only this line; it sits directly above the correct 'frames/' entry with a comment describing Capture-Frames.ps1 output.
  - *Fix:* Delete line 78.
- **.gitignore 'glitchshots/' entry — redundant** — `.gitignore:6`
  - Line 5's '*shots/' glob already matches glitchshots/ (and shots/). Verified: git status --ignored shows shots/ ignored with no dedicated rule; glitchshots/ is currently empty.
  - *Fix:* Delete line 6.
- **NavSub id attribute and opacity transition** — `index.html:215`
  - grep -n navSub src/main.js: only querySelector('.NavSubLabel')/('.NavSubCode') — getElementById('navSub') never called; and nothing ever changes .NavSub's opacity, so the 'transition: opacity .45s ease-out' (index.html:79) never fires — setNavSub swaps textContent only.
  - *Fix:* Drop the id and the transition line, or actually fade the pill on section changes.
- **poolTex option to buildAlcove — a texture is loaded and passed but the parameter is never read** — `src/main.js:965 (`poolTex: loadPoolTexture()`), src/alcove.js:94`
  - Grep 'poolTex|loadPoolTexture' across src/: alcove.js mentions opts.poolTex ONLY in its @param docstring (line 94) — the function body never reads it (the pool sprite was deliberately removed, alcove.js:261-264 'NO pool sprite at the mark'). Effect: main.js:965 triggers a second fetch + decode of assets/at/env/_lightvolume_light.jpg (foliage.js:168
  - *Fix:* Delete `poolTex: loadPoolTexture()` from the buildAlcove call in main.js:965, drop loadPoolTexture from that import if then unused there, and remove the stale @param in alcove.js:94.

---
## 6. Do NOT delete

Claimed dead by a reader; the adversarial pass proved them ALIVE. Listed so nobody deletes them later.

- **buildParticles' entire output is permanently disabled at runtime on any asset-present deployment (the main.js:222 question)** — The claim's own qualifier is false. main.js:221-222 reads `// kept visible under ?only=emblem: the glass needs something behind it` / `if (ONLY !== 'emblem') particles.visible = false;` — so on an asset-present deployment with the README-documented `?only=emblem` flag (README.md:27), particles stay visible, and the `?only=emblem` block at main.js:~
- **buildSpine proxy + QUALITY_FILES 'high'/'max'/'raw' are query-flag-only / failure-only paths** — The characterization is accurate but these paths are live and deliberately kept. README.md:25 documents `?spine=` with values `sharp · high · max · raw · off` as a user-facing flag; README.md:124-130 maps each QUALITY_FILES entry to a committed asset (`spine.opt.glb` = ?spine=high, `spine.min.glb` = ?spine=max) and notes ?spine=raw needs the uncomm
- **--baropacity CSS variable / scrollbar-thumb opacity animation** — The variable is referenced outside its definition and is functionally load-bearing. index.html:22 consumes it: ::-webkit-scrollbar-thumb { background: rgba(255,255,255,var(--baropacity,0.9)) }. The page has a real scrollbar: .FXScroll (index.html:44-47) is a fixed full-viewport element with overflow-y: scroll — the virtual scroll track driving the 
- **"Toggle Audio" control that toggles no audio** — The element is live UI, not dead code. The #wave canvas (index.html:209) is the nav waveform: main.js:2277 grabs it, main.js:4126 calls drawWave(t) every frame of the render loop, so it renders an animated 3-pass sine in the nav capsule continuously. The click handler (main.js:2280) toggles audioOn, and main.js:2284 uses it as the amplitude — click
- **spine.opt.glb (2,903,216 B) and spine.min.glb (1,235,116 B) are reachable only via query flags — ?spine=high / ?spine=max** — These are referenced by live, shipped code: src/spine-glb.js:32-33 QUALITY_FILES maps 'high' -> assets/spine.opt.glb and 'max' -> assets/spine.min.glb, selected at runtime by QUERY.get('spine') at src/main.js:910. The flags are user-facing and documented (README.md:25 flag table; README.md:124-125 lists both as committed with their flags), compress

---
## 7. Unsure — check before deleting

Kept-by-intent per a comment, or the verifier could not prove dead. Each entry says what would settle it.

- **[code] spineGroup module variable — write-only handle** — `src/main.js:896, 913`
  - Factually write-only: exactly two references repo-wide (declaration at 896, assignment at 913), never read, not exposed via window. But line 913's inline comment — 'kept as a handle; no longer a god-ray source' — is an explicit deliberate-keep marker, which per policy makes this ALIVE-by-intent. Deletion needs the auth
- **[code] flowerRotation — the ported resetWork rotation bump is unimplemented, so the spine flower cloud's uRotate is permanently** — `src/main.js:176, 4065`
  - The factual claim is confirmed: flowerRotation is declared 0 at 176, never reassigned anywhere (no resetWork port exists in the repo), so fu.uRotate at 4065 lerps toward 0 forever and the spine flower cloud never gets the rotation bump. However it fails the zero-reference bar for CONFIRMED_DEAD — it is read in live cod
- **[code] uHorizon composite feature — inclined-horizon shader branch permanently disabled** — `src/main.js:1682 (uniform), 1907-1913 (shader branch), 4033 (driver)`
  - Facts verified: the only runtime write is 'u.uHorizon.value.x = 0' at 4033, executed unconditionally every frame; no query flag, no __over override, no window/test/script path sets .x > 0.001, so the guarded block at 1907-1914 never executes (docs/water-section-plan.md's uHorizonY is a different, planned identifier). B
- **[code] Composite uniforms uUIColor and uUIBlend — declared in GLSL, never read by the shader; uUIBlend is even updated every fr** — `src/main.js:1651 (values), 1690/1692 (GLSL declarations), 3951 (per-frame write)`
  - The technical facts hold: the composite fragment shader body never references either uniform — the corner glow builds its hue from hard-coded vec3(0.40, 0.78, 0.37) at 1916 and its strength from constants at 1923 — so the per-frame write at 3951 has no visual effect. But three comments assert deliberate keeping and int
- **[code] The inclined-horizon feature (uHorizon uniform + shader block) — permanently disabled, deliberately kept** — `src/main.js:1682 (uniform), 1705 (declaration), 1907-1914 (shader block)`
  - Same feature as the earlier uHorizon claim, and this claim itself already concedes 'deliberately kept'. Verified: sole write pins .x = 0 at 4033, .y never varies, the guard never passes, and no external path (query flag, __over, window.__passes tooling, tests, docs) drives it. The comment at 4028-4032 states it stays i
- **[code] compositePass uniform uUIBlend + its per-frame driver block** — `src/main.js:1651 (JS decl), 1690 (GLSL decl), 3946-3952 (per-frame driver)`
  - Ran `grep -rn uUIBlend src index.html scripts test *.mjs README.md` — hits only at main.js 1651, 1690, 1842 (comment), 3951. The fragment shader body never reads it: the corner-glow term at 1922-1923 is `0.022 + pow(cornerNoise * gNoise, 2.0)` with no uUIBlend factor. NOT deliberate — the comments at 1842-1844 and 3948
- **[code] compositePass uniform uUIColor** — `src/main.js:1651 (JS decl), 1692 (GLSL decl)`
  - Ran `grep -rn uUIColor src index.html scripts test *.mjs README.md` — hits only at 1651, 1692 and comments 1839/3948. The GLSL builds the corner-glow gradient from the hard-coded literal vec3(0.40, 0.78, 0.37) at line 1916; uUIColor is never referenced in the shader body despite the comment 'Ours is built from uUIColor
- **[code] alcove display path — alcove.group is staged permanently invisible** — `src/main.js:3381 (unconditional `alcove.group.visible = false`), 3570`
  - ALIVE-by-intent. The runtime facts confirm it never displays: visible is written only at 3381 (unconditional, every frame) and 3570 (FLORA_SOLO branch), both false; no query flag or debug path flips it on. But the comment at 3376-3380 ends 'The module stays built so the room can be revisited deliberately' — an explicit
- **[code] foliage.burstGroup — built, added to scene, never visible** — `src/main.js:305/308, 3521, 3575 (visible=false in all three writers)`
  - Ran `grep -rn burstGroup src index.html scripts test *.mjs README.md` — built in foliage.js:140-190, added at main.js:305, set false at 308/3521/3575, set true nowhere. KEPT DELIBERATELY per comment 3518-3520 ('the vignette group stays built for later play but never shows').
- **[code] composite horizon branch — uHorizon.x pinned to 0 every frame** — `src/main.js:4033 (driver), 1907-1914 (GLSL branch)`
  - ALIVE-by-intent. Runtime deadness confirmed: initial value x=0 at 1682, the only x-write anywhere is the unconditional `u.uHorizon.value.x = 0` at 4033 executed every frame (which also clobbers any console poke through window.__passes), so the `if (uHorizon.x > 0.001)` branch at 1907-1914 can never execute; docs/water-
- **[code] query-flag-only paths: FLORA_SOLO (?flora=solo) and ONLY (?only=emblem)** — `src/main.js:3560-3584 (FLORA_SOLO override block), 2761/3731/3857/4509-4526 (ONLY)`
  - ALIVE-by-intent, not dead-by-accident. No script/test constructs these URLs (grep of shot.mjs, clip.mjs, Capture-Frames.ps1, test/, scripts/, index.html found zero hits), but they have references outside their definitions and explicit deliberate-keep markers: README.md:27 documents `?only=emblem` in the flags table ('I
- **[code] opt-in flora debug probe (window.__floraDbgOn / __floraDbg)** — `src/main.js:4107-4112`
  - ALIVE-by-intent. Repo-wide grep confirms __floraDbg is written only at main.js:4108 and read nowhere (no hits in scripts/, test/, index.html, *.mjs, README.md). But the adjacent comment (main.js:4104-4106) is an explicit deliberate-keep marker: 'debug probe, opt-in: seven objects and three mapped arrays per frame in th
- **[code] resolution uniform declared but unused in both nebula fragment shaders (kept deliberately per inline comment)** — `src/nebula.js:120 (CLOUD_FS) and src/nebula.js:221 (AURORA_FS)`
  - ALIVE-by-intent. Both declarations carry the inline comment 'part of the shared bag contract; unused here' (nebula.js:120, 221), and the JS side still wires it (resolution: shared.uResolution at nebula.js:307 and 347). Verified the shader bodies never read `resolution` (only those 4 lines match in the file), so it is f
- **[code] makeCrackedIceTexture() — toroidal-voronoi cracked-ice texture, exported and never called (deliberately retired)** — `src/textures.js:665-724`
  - Zero call sites confirmed repo-wide — but not zero references, and the retirement is explicitly deliberate: main.js:929-933 ('crackTex null on purpose ... calling it would shift every later consumer off the approved look') documents the decision not to call it and warns against ever calling it; water.js:44-47 still des
- **[code] makeNormalTexture's `export` keyword — never imported by any module (function itself is live as an internal fallback)** — `src/textures.js:241`
  - ALIVE-by-intent. No code imports it: the only importers of src/textures.js are src/cards.js:6, src/emblem.js:4, src/main.js:29, src/world.js:2, and none names makeNormalTexture; no dynamic imports, no references in index.html, test/, or the capture scripts. But scripts/fetch-assets.mjs:9-10 documents the export as deli
- **[code] uAlpha fade path on both water materials — initialized 0, only ever set to 1, the fade it exists for was abandoned** — `src/water.js:634 and 679`
  - The factual claim checks out: the only writes are `= 1` (main.js:948 for topMat at setup, main.js:3434 for ceilMat in the same staging pass that makes the ceiling visible, including the prewarm at main.js:4603-4609), and the generic uAlpha-arrive loop at main.js:3045-3062 cannot reach the water — it traverses workRoot 
- **[code] introState() and INTRO_DURATION — the entire timed five-phase intro sampler** — `src/intro.js:48-121`
  - Code-dead is confirmed: repo-wide grep (src/, index.html, scripts/, test/, *.mjs, *.ps1, README, docs/, .superdesign/, feedback-report.txt) finds introState and INTRO_DURATION only inside src/intro.js; main.js imports only heroDrives (main.js:24) and the only query flags wired in main.js are q/only/spine/flora. But thi
- **[code] introBypass() — the '?intro=off' steady-state path for a query flag that no longer exists** — `src/intro.js:194-202`
  - Code-dead is confirmed: introBypass appears only at its definition (src/intro.js:194-202); the ?intro flag it serves is wired nowhere — main.js's only QUERY.get calls are q (43), only (56), spine (906/910) plus the flora=solo param (189), and README's URL-flag table (README.md:23-27) lists no ?intro. However its own do
- **[code] about.js logoTransform() — called once and its result entirely discarded** — `src/about.js:190-196`
  - The discard is confirmed: the single call `const t = about.logoTransform(landPF, dragRotation)` at main.js:3264 is the only code reference, `t` is never read afterward (the only later occurrence of `t` in that scope is inside the comment 'NOT t.rotY...' at main.js:~3277), and the function is pure (about.js:190-196 retu
- **[code] planar-UV fallback branch `if (!geometry.attributes.uv)` — never taken for the shipped asset** — `src/emblem.js:255-268`
  - The factual claim is verified: I parsed assets/emblem.opt.glb's JSON chunk directly and the sole primitive carries TEXCOORD_0 (VEC2, componentType 5123 Uint16 normalized, count 282,074), which GLTFLoader maps to geometry.attributes.uv, so the guard is provably untaken today, and no caller ever passes opts.url to load a
- **[code] Film debug surface entirely unconsumed: stats (calls/hits/misses/decodes/maxGap/fallbacks/missRate/reset), cached, ready** — `src/filmseq.js:126-129, 418-422`
  - ALIVE-by-intent. No code consumer exists (film.preload/.texture/.setProgress at main.js:631/632/3812 are the only property reads, and grep for missRate/loadedCount/frameCount/stats across the repo finds nothing), BUT main.js:661 reads `window.__film = film;   // debug: frame index, cache state, load progress` — a delib
- **[code] uVelocity and uAngleVelocity uniforms and the inclination2 computation — declared/computed, never used** — `src/transition.js:35-36, 80`
  - Functionally dead is correct: no runtime code writes these uniforms (repo-wide grep hits only transition.js and fluid.js's unrelated sampler of the same name), and inclination2 is never read after assignment. But this is ALIVE-by-intent: the header comment at src/transition.js:11-14 says the fragment shader 'is transcr
- **[code] foliage burstGroup (8 cloud instances) and setBurstReveal() — built, exported, permanently hidden** — `src/foliage.js:140-161 (build), src/foliage.js:193-196 (setBurstReveal)`
  - Functionally dead is correct — setBurstReveal is called nowhere (only its definition matches), and burstGroup is added to scene at main.js:305, then set visible=false at 308, 3521, and 3575 with no code path ever setting it true or querying it. But this is ALIVE-by-intent: main.js:3517-3520 says 'The hand-placed burst 
- **[code] The alcove room + canopy field — a fully built, permanently disabled feature (src/alcove.js and its sole consumer's outp** — `src/alcove.js (whole runtime path), src/canopy.js:156 (buildCanopy, only imported by alcove.js:4)`
  - ALIVE-by-intent. The claimed evidence is accurate (alcove.group.visible = false at main.js:3381 and 3570, never true; alcove.setReveal never called — only planets.setReveal/flora.setReveal exist; buildCanopy imported only by alcove.js:4), but main.js:3376-3380 says explicitly: 'The alcove is OFF... The module stays bui
- **[code] Entire ChatDOM panel: markup (index.html:220-233), ~65 lines of CSS (index.html:88-154), and the textarea focus/blur han** — `index.html:220`
  - ALIVE-by-intent. The mechanics check out (main.js:3736 adds 'off' unconditionally every frame; no classList.remove/toggle of 'off' anywhere, so the wrapper is permanently opacity:0 + pointer-events:none), but main.js:3732-3735 states: 'The DOM is kept because it is a faithful recreation of theirs; removing it would los
- **[code] fetch-assets.mjs --soft flag (report-but-exit-0 path)** — `scripts/fetch-assets.mjs:97`
  - Zero in-repo invokers confirmed: no vercel.json, no .vercel/, no .github/, no package.json script, no .ps1/.md/.mjs passes --soft (only definition+uses at scripts/fetch-assets.mjs:91-137). BUT the comment at :91-96 declares deliberate intent: 'This runs as Vercel's build step (see vercel.json)... a missing asset should
- **[asset] flower_spine-256.bin fetch entry — downloaded but never loaded** — `scripts/fetch-assets.mjs:27`
  - The 'never loaded' half is verified: the only runtime load is assets/at/flower_spine-512.bin (src/main.js:202); no dynamic LOD path construction exists (no `flower_spine-${...}` anywhere); .gitignore:30 un-ignores only -512; README names only -512. The -256 string appears only at scripts/fetch-assets.mjs:27 and in flow
- **[asset] 16 of 24 committed assets/at/env files (~1.62 MB) unused by any code** — `assets/at/env`
  - The reference count is verified: exactly 8 of 24 env files are referenced in code — 7 decoded by src/alcove.js:117-123 (tree_room_structure, tree_room_pillars, panels_2x3, room_bush, room_bush_instances, tree_room_rocky_soil, tree_room_walls) plus _lightvolume_light.jpg in src/foliage.js:33; the other 16 (arealights.js
- **[asset] matcap3.png — 6,734 bytes, COMMITTED and fetched but never loaded by any code** — `assets/at/matcap3.png (committed via .gitignore:49; fetched by scripts/fetch-assets.mjs:65)`
  - Verified no runtime loader: every bubble-matcap consumer calls procedural makeBubbleMatcap() (src/main.js:209,240,297,1041; src/world.js:292), and 'matcap3' greps to only .gitignore:47-49 and fetch-assets.mjs:63-65. But both of those are deliberate-keep comments — .gitignore:47-49 un-ignores it stating 'the bubble spri
- **[asset] 16 of 24 committed assets/at/env/ files are loaded by nothing — 1,620,582 bytes (~1.55 MB) of repo weight: _lighting_are** — `assets/at/env/ (all committed; !assets/at/env/** at .gitignore:57)`
  - The load-set claim verifies: only 7 meshes (src/alcove.js:117-123) plus _lightvolume_light.jpg (src/foliage.js:33) are loaded, all via literal paths — no dynamic 'assets/at/env/${...}' construction exists — and none of the 16 basenames appear anywhere else outside scripts/fetch-assets.mjs:75-89. But retention is explic

---
## 8. Optimizations

### Medium impact

- **`src/main.js:190`** — 220k-point procedural particle cloud is fully built and uploaded on every load, then hidden forever on the happy path
  - buildParticles(shared, 220000) runs unconditionally at module eval: a rejection-sampled CPU loop with 6 fbm() gradient evaluations per accepted point (world.js:230-267) plus ~8MB of position/color/random Float32 attributes uploaded to the GPU. When the baked flower cloud lands (~1s later, the normal case), line 222 only sets particles.visible = false — the geometry, material and GPU buffers stay r
  - *Fix:* After the flower cloud succeeds (line 222), when ONLY !== 'emblem': workRoot.remove(particles); particles.geometry.dispose(); particles.material.dispose(). Alternatively build the fallback lazily inside the catch block at line 310.
- **`src/main.js:3045`** — workRoot.traverse runs on every stageSection call — every frame in every section, up to 7x per wipe frame
  - The 'arrive' block (3043-3063) walks the entire workRoot subtree (spine GLB, proxy column, 14 cards' holders/panels/labels, particles, flower cloud, work foliage — 100+ nodes) on EVERY stageSection call, even when name !== 'work' and arrive has been 0 for thousands of consecutive frames (it rewrites the same 0 into the same uniforms). stageSection is called once per normal frame (3871) but up to 7
  - *Fix:* Cache the last-applied value at module level (`let lastArrive = -1;`) and skip the traverse when the newly computed arrive equals it (both are pure functions of scroll, so within a frame the same name always yields the same value; land/volume steady state computes 0 every time and skips, settled wor
- **`D:/Claude/RevEng/1/work-spine/src/main.js:4125`** — video.update(t) repaints and re-uploads a canvas texture every frame in every section
  - makeSharedVideoTexture.update (textures.js:635-653) fills a 256x144 canvas with 7 radial gradients and sets needsUpdate, forcing a full texture re-upload per frame. It is called unconditionally at line 4125, but the texture is only sampled by the work cards' panel shader (cards.js tVideo) — the other consumer, the alcove, is permanently invisible. Through land/drift/gather/burst (the sections that
  - *Fix:* Gate it on the card room being on screen: `if (front === 'work' || TR.active) video.update(t);` (TR.active keeps the incoming work half live through the wipe).
- **`src/flora.js:1397`** — flowAt() runs for every instance every frame before any distance gate
  - In the interact() hot loop, `const ft = flowAt(px, py, pz, now)` (8 sin/cos calls + Math.hypot + 3 divides) executes unconditionally per instance, BEFORE the rod in-range test (line 1405, requires d < cfg.radius=7.5 and dz < 1) and the per-ripple reach tests (line 1424). Whenever the pointer is over the burst section, rodAmp >= cfg.idle*cfg.push = 0.408 > 0, so the mesh-level early-out at 1375 nev
  - *Fix:* Evaluate the flow field lazily: `let ft = null;` then inside the rod branch after the `d < cfg.radius && dz < 1` check and inside the ripple branch after the `d <= reach` check, do `if (!ft) ft = flowAt(px, py, pz, now);`. Instances outside every mask then skip the trig entirely.
- **`src/flora.js:1375`** — Idle early-out never engages while the pointer is over the section: settled meshes still integrate and re-upload every frame
  - The skip condition `if (rodAmp === 0 && !anyRipple && S.settled) continue;` requires rodAmp === 0, but while the pointer is inside the section rodAmp is at least idle*push = 0.408 (line 1358). The rod only ever touches instances within 7.5 units of the ray, yet all ~16 meshes (5 organic protos x 3 variants + card) integrate ALL their instances and set `S.attr.needsUpdate = true` (line 1461) every 
  - *Fix:* Track whether any force was actually applied to the mesh during the pass (set a `touched` flag inside the rod and ripple branches when amp > 0). After the loop: `if (!touched && S.settled) continue-upload` — i.e. only set `S.attr.needsUpdate = true` when touched or not settled; the integration loop 
- **`src/nebula.js:354`** — Aurora mesh renders every frame at zero intensity — permanently for the mist instance, and through drift/gather/burst for the main nebula
  - The aurora is a 6x34-unit DoubleSide plane with frustumCulled = false (nebula.js:358), whose fragment runs a 5-octave fbm (25 cnoise evaluations via shaders.js:54-58) plus an extra cnoise and an rgb2hsv/hsv2rgb round trip per fragment. The mist instance (src/main.js:1177) is built with aurora: 0 and its uAurora is never written again, yet the mesh is drawn every frame in every section because ambi
  - *Fix:* Two lines: skip constructing the aurora when (opts.aurora ?? 1) === 0 (covers the mist permanently), and in update() add `aurora.visible = uAurora.value > 1e-3;` so the main instance stops drawing it outside land.
- **`src/world.js:213`** — 220k-particle CPU rejection-sampling build runs synchronously at boot, then is permanently hidden one second later
  - main.js:190 calls buildParticles(shared, 220000) at module evaluation, before the first frame. The clump loop targets 204,600 accepted points at roughly 50% acceptance; each rejected try costs a 4-octave + 3-octave fbm (7 noise evals) and each accepted point 6 more 2-octave fbms (12 evals) — ~5M noise evaluations plus ~7.9 MB of Float32 attributes, i.e. a low-hundreds-of-ms main-thread stall on th
  - *Fix:* Build lazily: construct and add the particles only in the flower-chain catch (main.js:310) and in the ?only=emblem branch, where they are actually shown. Alternatively keep the eager build but at main.js:222 remove the object and dispose geometry/material/matcap instead of just hiding it (only when 
- **`D:/Claude/RevEng/1/work-spine/src/home.js:413`** — Full 3D simplex noise evaluated per fragment on the additive plume
  - PLUME_FS computes `cnoise(vWorldPos * 0.05 - time * 0.2 + length(vWorldPos) * 0.05)` for every fragment of a 30k-point additive pass whose sprites reach the 26px uMaxSize ceiling — an overdraw-heavy pass that also feeds bloom. At input frequency 0.05 the noise value varies imperceptibly across any single point sprite, so the per-fragment evaluation (a ~50-op simplex) buys nothing over a per-point 
  - *Fix:* Evaluate the cnoise term once in PLUME_VS and pass it as `varying float vNoise`; identical look, one simplex per vertex instead of one per covered pixel.
- **`D:/Claude/RevEng/1/work-spine/src/emblem.js:166`** — 56 dependent texture taps per emblem fragment for the refraction frost
  - `radialBlur(tRefraction, refractionuv, 8.0, 8.0)` executes 8 directions x 7 samples = 56 texture reads per fragment (see RADIAL_BLUR in glsl-chunks.js:57-74), on a coin that can cover a large share of the frame at full DPR. The source refractionRT is a half-res snapshot rendered once per frame, so the same blur work is redone for every covered pixel every frame.
  - *Fix:* Pre-blur refractionRT once per frame with a two-pass separable gaussian into a second small RT and sample it once here; or reduce quality to 4 (24 taps), which is visually indistinguishable under the frost.
- **`src/cards.js:279`** — Every card pays the full 38-tap fragment shader twice: the box's rear quad always rasterizes and composites
  - The panel is a BoxGeometry with side: THREE.DoubleSide (line 145) and depthWrite: false (line 144), so the -z quad is never culled and never depth-rejected against the +z quad — both faces run the complete fragment shader (radialBlur = 8 dirs x 4 steps = 32 taps of refractionRT at line 279, plus 2x getRGB 3-tap fetches at 326-327 and the noise work) and both blend into the frame (BoxGeometry emits
  - *Fix:* Branch on gl_FrontFacing for the face turned away from the camera: keep its color contribution but replace the 32-tap radialBlur with a single texture2D tap (or quality 2.0), and skip the liquid-hover block there. Halves the dominant fragment cost with only a subtle change to the rear layer's blur.
- **`src/alcove.js:115`** — Permanently-invisible alcove still fetches 7 binaries, Draco-decodes them, samples 96k points and builds a 900-instance canopy at startup
  - The `ready` IIFE (alcove.js:115-276) always runs: seven fetch()+Draco-worker decodes (tree_room structure/pillars/panels/bush/instances/soil/walls), MeshSurfaceSampler.build() over the bush, 30×3200 = 96,000 surface samples into two ~1.1 MB Float32Arrays for the growth cloud, plus buildCanopy's area-weighted scatter of 900 instances over two terrain meshes. All of it feeds alcove.group, which main
  - *Fix:* Early-return from buildAlcove (or skip the call at main.js:965) unless an opt-in flag (e.g. ?alcove=1) is present, returning the same {group, ready: Promise.resolve(null), setReveal} shape so callers need no change.

### Low impact

- **`src/main.js:1068`** — Duplicate texture fetches/decodes/uploads: matcap-test.jpg and env1.jpg each loaded twice, bubble matcap canvas generated five times
  - THREE.Cache.enabled is never set (grep: no hits), so every loader.load is an independent fetch+decode+GPU upload. loadJellyMatcap() is called at line 940 (water) and 1068 (jelly) — two textures of the same JPG. env1.jpg is loaded via loadEnvTexture() at 922 (cards env) and again by a fresh TextureLoader at 984 (PMREM source). makeBubbleMatcap() renders its procedural canvas 4 times in main.js (209
  - *Fix:* Memoize in textures.js (e.g. let cached; return cached ??= ...) for loadJellyMatcap/loadEnvTexture/makeBubbleMatcap, or hoist one call per texture into a const in main.js and pass it around. Setting THREE.Cache.enabled = true would dedupe the network/decode side for the file-based ones.
- **`src/main.js:973`** — PMREMGenerator never disposed after the environment maps are built
  - pmrem is used twice — once synchronously for the stopgap env (981) and once in the env1.jpg load callback (988) — and is never needed again, but pmrem.dispose() is never called, so its internal blur/projection materials and ping-pong render targets stay allocated for the session.
  - *Fix:* Call pmrem.dispose() at the end of the TextureLoader callback at lines 984-991 (the generated scene.environment textures survive generator disposal).
- **`src/main.js:1893`** — tVolumetricBlur is sampled per pixel even when uVolumetricStrength is 0 (all of the work section)
  - `color += texture2D(tVolumetricBlur, vUv).rgb * uVolumetricTint * uVolumetricStrength;` executes unconditionally. In work, uVolumetricStrength is 0 every frame (frame loop 4220-4231: raySource is null for work so the pass is skipped and strength is 0), yet every composite pixel still pays a texture fetch multiplied into nothing. The shader already guards its other optional terms (uFlash at 1946, u
  - *Fix:* Wrap the add in `if (uVolumetricStrength > 0.0) { ... }` like the neighbouring uFlash/uGrade blocks.
- **`D:/Claude/RevEng/1/work-spine/src/main.js:3871`** — Every stageSection call runs a full workRoot.traverse — up to 7 traversals per wipe frame
  - The points-arrival block (lines 3043-3062) calls workRoot.traverse with a fresh closure on EVERY staging, for every section — including land, where arrive is constantly 0. Non-wipe frames pay one traversal of the site's largest subtree (spine + 14 card holders + flower cloud + work foliage + dust clouds); a burst->work wipe frame pays up to seven: front (3871), volumetric restage pair (4261/4268),
  - *Fix:* Collect the Points materials once at build time (workRoot.traverse at startup into a flat array of material references) and have the arrive block iterate that array; optionally early-out when the computed `arrive` equals the last value applied for that staging.
- **`D:/Claude/RevEng/1/work-spine/src/main.js:3943`** — Per-frame array allocations and needless card work outside the work section
  - Every frame, in every section: `cards.filter(...).map(...)` allocates two arrays for the raycast list (3902-3903), `cards.slice().sort(...)` allocates a third plus sort/forEach closures (3943-3944), and the raycast + hover chase + per-card uniform loop all run even when workRoot is invisible (land/drift/gather). None of it affects the frame outside work (and the hover it produces there is itself a
  - *Fix:* Early-out the whole card block (raycast, hover, per-card loop, sort) when `front !== 'work' && !TR.active`; inside work, reuse persistent arrays for the raycast list and the sort order instead of allocating per frame.
- **`src/flora.js:1403`** — Math.hypot in the per-instance spring loop
  - The hot loop calls Math.hypot up to (1 + live ripples + 1) times per instance per frame: rod distance (line 1403), each ripple distance (line 1423, up to 14 ripples), and the excursion magnitude (line 1447) — plus once inside flowAt (line 1294). Math.hypot in V8 is several times slower than Math.sqrt(x*x+y*y+z*z) because it guards against overflow/underflow, which is irrelevant at these magnitudes
  - *Fix:* Replace with `Math.sqrt(dx*dx + dy*dy + dz*dz)` at lines 1403, 1423, 1447 and 1294 (and compare squared distances against squared radii first where only a threshold test is needed, e.g. skip a ripple when d2 > reach*reach before taking the sqrt).
- **`src/jelly.js:478`** — Second DRACOLoader singleton duplicates the one in flower-cloud.js
  - jelly.js keeps its own module-level `_draco` (jelly.js:475-483) with the same decoder path as flower-cloud.js's `_loader` (src/flower-cloud.js:68-70). Each DRACOLoader instance spins up its own worker pool with its own copy of the decoder module, so the page initialises the Draco runtime twice (memory and startup work; the decoder script fetch itself is HTTP-cached). jelly.js:480 even notes it is 
  - *Fix:* Export the loader singleton from flower-cloud.js (alongside parseATContainer, which jelly.js already imports) and reuse it in loadJellyModel, deleting jelly.js's _draco/dracoLoader().
- **`src/textures.js:91`** — No caching in the load* helpers: matcap-test.jpg is fetched/decoded/uploaded up to three times
  - loadJellyMatcap() is called at main.js:940 (water), main.js:1068 (jelly), and emblem.js:279 (when opts.matcap is not supplied). Each call creates a fresh Image fetch, decode, and GPU upload of the identical asset. emblem.js:270-272 explicitly accepts one duplicate ('one extra upload ... 50 KB, accepted to keep the call site unchanged'), but a module-level cache would remove all duplicates without 
  - *Fix:* Memoize per URL inside textures.js: `const cache = {}; ... return cache[url] ??= loader.load(...)` pattern for loadJellyMatcap/loadJellyNormal/loadLogoNormal/loadEnvTexture/loadNormalTexture.
- **`src/textures.js:273`** — makeBubbleMatcap baked and uploaded five times with identical output
  - The function takes no arguments and is fully deterministic, yet it is invoked at main.js:209, 240, 297, 1041 and world.js:292 — five separate 128x128 CPU bakes and five separate GPU textures with byte-identical content.
  - *Fix:* Bake once and return a module-level singleton texture (or memoize), sharing one GPU texture across all five consumers.
- **`src/water.js:639`** — Both water materials are transparent:true with alpha permanently 1 — full-frame blending for no visual effect
  - topMat (line 639) and ceilMat (line 684) set transparent: true so uAlpha can fade them, but uAlpha is only ever written as 1 (main.js:948, 3434 — see the dead uAlpha entry). Both surfaces are huge (260x260 and 1728x1728 planes) and frequently fill most of the frame; rendering them in the sorted transparent pass with blending enabled costs ROP/bandwidth on a HalfFloat target every frame while produ
  - *Fix:* If the fade stays abandoned, set transparent: false on both materials (they already depthWrite). Verify sort-order interplay with the film plane/foliage once, since they leave the transparent pass.
- **`src/flower-cloud.js:397`** — The two buildFlowerCloud instances duplicate ~7.3 MB of identical GPU buffers and 1M rand() calls
  - main.js builds the spine cloud (line 209) and hero cloud (line 240) from the SAME 262,144-point position array, but buildFlowerCloud always constructs a fresh BufferGeometry with new BufferAttributes (lines 397-404), so the identical 3.15 MB position array is uploaded twice and a fresh 4.19 MB aRandom is generated (1,048,576 extra rand() calls) and uploaded per instance. buildRawCloud already solv
  - *Fix:* Cache and reuse the position BufferAttribute (and the aRandom attribute) across buildFlowerCloud calls for the same cloud — e.g. accept opts.geometry like buildRawCloud, or stash the created attributes on the cloud object and reuse them, giving each instance its own geometry only if its aColor diffe
- **`D:/Claude/RevEng/1/work-spine/src/emblem.js:279`** — Third duplicate decode + GPU upload of matcap-test.jpg
  - loadJellyMatcap() constructs a fresh Texture on every call and is called three times: main.js:940, main.js:1068 (stored as jellyMatcap) and here via the opts.matcap default. Same image, three GPU textures. emblem.js:270-272 explicitly accepts the duplicate 'to keep the call site unchanged'.
  - *Fix:* Pass main.js's existing `jellyMatcap` to loadEmblem as `matcap: jellyMatcap` — the option already exists and nothing else changes. (Or memoize loadJellyMatcap in textures.js.)
- **`src/cards.js:307`** — Liquid hover evaluates 5 fbm2 calls (20 cnoise, ~80 hash/sin) per fragment on the hovered card
  - liquidField (line 251) computes two warp fbm2 calls, the base field, and two finite-difference gradient taps — each fbm2 is 4 octaves of sin-based value noise (line 245-249). On a focused card (~0.3-0.5M pixels, doubled by the rear face per the previous item) that is tens of millions of sin() calls per frame for the duration of a hover, on top of the 32-tap radialBlur. Fully gated on uHover so onl
  - *Fix:* Drop the gradient taps to a 2-octave fbm (the gradient only steers displacement and sheen; low-frequency content dominates it), or sample a small precomputed RGBA noise texture (tNormal is already bound and wrapped) instead of procedural fbm.
- **`src/filmseq.js:373`** — Displayed substitute frames are never touch()ed, so the frame on screen sits at the LRU tail and gets re-decoded
  - touch(idx) marks only the exact target MRU (line 351); a substitute found by the fallback search is fetched with a plain cache.get (line 373) and blitted without an LRU bump. During a fast flick — precisely when fallbacks happen — the frame currently on screen is among the first evicted (evict() closes from the head, line 202-210) and is then likely re-wanted and re-decoded within a few ticks as t
  - *Fix:* Call touch(showIdx) (or cache.delete+cache.set) before blitting a substitute so the LRU order reflects what is actually being shown.
- **`src/foliage.js:202`** — update() advances uniforms for retired burst instances every frame
  - foliage.update() (called every frame from main.js:4120) iterates `all`, which includes the 8 permanently-invisible burst vignette instances (main.js:3521 comments them RETIRED), bumping uSparkle/uRotate on materials that never render. Cost is small (8 extra iterations/frame) but is pure waste tied to the dead burstGroup.
  - *Fix:* Keep burst instances out of `all` (push them only into burstInsts), or drop the burst block entirely if the retirement is final.
- **`D:/Claude/RevEng/1/work-spine/index.html:57`** — Two backdrop-filter blurs plus plus-lighter blending composited over the WebGL canvas every frame
  - NavUI (line 57) and NavSub (line 76) both declare backdrop-filter: blur(6px), and NavUI adds mix-blend-mode: plus-lighter (line 58). Because the element behind them is a full-screen WebGL canvas that repaints every frame, the compositor must re-blur and re-blend those regions each frame for the entire scroll experience; the blend mode also prevents the nav layer from being batched with the page. A
  - *Fix:* Replace backdrop-filter with a slightly more opaque static rgba background on both pills, and drop plus-lighter (or gate both behind a capability/quality check like the existing ?q=low).
- **`D:/Claude/RevEng/1/work-spine/scripts/fetch-assets.mjs:102`** — 34 asset downloads run strictly sequentially
  - The FILES (9) and ENV_FILES (25) loops each await fetch + write one file at a time, so total time is the sum of 34 round-trips to activetheory.net. As the deploy build step this directly extends every build.
  - *Fix:* Batch with Promise.allSettled over a small concurrency pool (4-6), preserving the per-file success/failure logging and the SOFT exit-code behavior.
- **`src/textures.js:49`** — Same asset files fetched and decoded multiple times — no texture memoization and THREE.Cache disabled
  - Each loadX() call constructs a fresh load: matcap-test.jpg is loaded 3x (main.js:940 water opts, main.js:1068 jelly, emblem.js:279 fallback since main passes no opts.matcap), env1.jpg 2x (main.js:922 loadEnvTexture for the cards + main.js:984 direct load for PMREM), and assets/at/env/_lightvolume_light.jpg 2x (foliage.js:168 + the dead main.js:965 poolTex arg). THREE.Cache.enabled is never set (gr
  - *Fix:* Memoize per-URL in textures.js (module-level `const cache = new Map()` returning the same THREE.Texture), or set THREE.Cache.enabled = true at boot; for main.js:984 reuse the texture from loadEnvTexture instead of re-loading env1.jpg.

---
## 9. Stale comments

Comments that contradict the current code and will mislead the next maintainer. Fix is the same for all: rewrite or delete the comment; none of these require code changes.

**`.gitignore`**
- L18: 'the three files the app actually loads are un-ignored below ... Only those three are committed; the rest of the folder stays out' (lines 18-23) — nine files plus env/** are whitelisted below the comment, and git tracks 
- L47: 'matcap3.png is the bubble sprite their LogoParticleShader and TreeParticleShader both bind as tMap; the foliage instances sample it' — the foliage instances sample makeBubbleMatcap()'s procedural canvas (main.js:297), a
- L60: 'The compressed builds (spine.opt.glb 2.77 MB / spine.min.glb 1.18 MB) are committed and are what the app loads' — the default load is spine.sharp.glb (spine-glb.js:28-31, README:123); opt/min are only reached via ?spine

**`D:/Claude/RevEng/1/work-spine/.gitignore`**
- L81: 'original 1920x1080 film plate — superseded by assets/deep-bg-960 ... Kept on disk as the master' — assets/deep-bg/ does not exist on this machine (ls assets/ shows only at/, deep-bg-960/ and the three GLBs); the same is

**`D:/Claude/RevEng/1/work-spine/README.md`**
- L239: Scroll-structure section describes the pre-water track: 'Five sections on one 1575vh track', burst listed as 140vh, and 'the four lead-in sections sum to 525vh'. src/sections.js:112 ships burst: 520 — a 1955vh track with
- L133: 'Three files the app loads are Active Theory's own work, pulled by npm run fetch:assets' with a 3-row table — git now tracks 33 Active Theory files under assets/at/ (jellyfish.bin, matcap-test.jpg, alien_cracked_2_normal
- L208: The Layout tree lists 19 of 29 src modules — alcove.js, canopy.js, filmseq.js, flora.js, fluid.js, foliage.js, physarum.js, planets.js, rng.js and water.js are missing (several are described elsewhere in the same README,

**`D:/Claude/RevEng/1/work-spine/compress.mjs`**
- L12: 'Usage: node compress.mjs [high|max]' — the PRESETS table also defines 'sharp' (the GLB the app loads by default, per src/spine-glb.js:31 and README:123) and 'emblem'. A maintainer following the usage line cannot rebuild

**`D:/Claude/RevEng/1/work-spine/index.html`**
- L96: CSS comment 'Section 1 only — main.js toggles this off outside Home, where the panel would sit on top of About's headline' — main.js:3736 adds .off unconditionally every frame; the panel is never shown in any section (de

**`D:/Claude/RevEng/1/work-spine/scripts/fetch-assets.mjs`**
- L1: Header comment 'Pulls the two textures the card shader binds' — the script now pulls 9 FILES plus 25 ENV_FILES (34 assets: point clouds, the jellyfish model, matcaps, the whole tree_room/room environment set). README.md:
- L93: 'This runs as Vercel's build step (see vercel.json)' — no vercel.json exists anywhere in the repo or in git (verified: ls + git ls-files + repo-wide grep for 'vercel'). The pointer sends a maintainer hunting for a file t

**`D:/Claude/RevEng/1/work-spine/shot.mjs`**
- L24: 'Headed Chromium so the real GPU renders the 1.87M-triangle spine' and line 39 '// 70MB GLB decode' — the default build loads assets/spine.sharp.glb (7.5 MB, ~45% of 1.87M ≈ 840k tris, per compress.mjs sharp preset and m

**`D:/Claude/RevEng/1/work-spine/src/about.js`**
- L20: Header states 'The mark's transform is still Active Theory's, from their About render tick' and (lines 25-26) 'at scrollProgress 0 the mark is already at y 4, not 6, and it leaves at 2 rather than -2'. Neither holds: mai

**`D:/Claude/RevEng/1/work-spine/src/home.js`**
- L35: Header claims 'NOT built yet, and deliberately not faked: the jellyfish (JellyShader.glsl...), the lens streak (...), and HomeBGShader's backdrop plane. The first two are the comet and the drifting jellies in the referen

**`D:/Claude/RevEng/1/work-spine/src/intro.js`**
- L134: heroDrives docstring says the burst flash 'rises across the first third of the section, holds, and has decayed to nothing by 85%'. The implementation (lines 153-156) rises over the first 12%, holds only to 22%, has fully
- L189: introBypass's comment: 'phases 3 to 5 currently render the frame black and the cause is not yet found... Off by default, `?intro=1` to work on it.' Both halves are false today: the black-frame causes were found and fixed

**`D:/Claude/RevEng/1/work-spine/src/main.js`**
- L3416: "the rise -- completes by the sink's end (470)" — the sink window is WATER_SINK_A/B = 360..405 (line 743, moved up 'from 355..470'); 470 is the retired window's end, and the code right below smoothsteps to 405.
- L3423: "UNDERSIDE: ... full through the dive-in and the rail's opening hold, gone as the camera commits to the cards. The dfe3a04 gates, verified live in that build." — contradicted by the code two lines down (3433-3434: ceilin
- L4279: "A wipe lasts 30vh" — TRANSITION_VH is now { drift: 90, work: 160 } (line 1563); 30 was the pre-widening single band value. The staleness-tradeoff argument is being made against a band 3-5x longer than stated.
- L4055: "it would only vanish 2% into a 1575vh track, which is 30vh in" — the track is now 1955vh (SECTION_VH = 105+140+140+520+1050, sections.js:112); 1575 predates burst's extension to 520.
- L3950: "Only the strength tracks the focused card now" — the strength written here (uUIBlend) is never read by the composite fragment shader (the glow term at 1922-1923 has no uUIBlend factor), so nothing tracks the focused car
- L4592: Prewarm comment: "the underside needs work progress under 0.14 ... neither face is ever visible for those renders" — the ceiling is now unconditionally visible whenever work is staged (line 3433, `name === 'work'`, the 0
- L4473: "composer.setSize resizes each target's depthTexture in turn, so the SHARED one is resized twice to the same dimensions" — RenderTarget.setSize (vendor three.core.js:8979-9003) never touches depthTexture; it is WebGLText
- L3853: "UIL: CAMERA_Element_2_Work position [0,0,2] — so the eye is 2 units further out along the group's +Z than the waypoint" — the work rig actually sets camera.position.set(0, 0, 1.25) (line 3074), so this codebase's eye si
- L848: (Outside assigned files, but misdescribes assigned emblem.js.) 'loadEmblem parents two PointLights into the group it returns, which cannot be used here' — present tense, but loadEmblem parents no lights and has no rimLig

**`D:/Claude/RevEng/1/work-spine/src/sections.js`**
- L41: (Outside assigned files, but misdescribes assigned emblem.js.) '(This is why loadEmblem takes `rimLights: false`: it parents two PointLights into its own group by default.)' — loadEmblem accepts no rimLights option and c

**`D:/Claude/RevEng/1/work-spine/test/compare.mjs`**
- L9: Header says 'the new one is global-on-a-1575vh-track'; the current track is 1955vh (sections.js:112), so a maintainer reading this would mis-derive the offset arithmetic that sweep.js needs.

**`README.md`**
- L134: 'Three files the app loads are Active Theory's own work, pulled by npm run fetch:assets' (and the table lists only flower_spine-512.bin, env1.jpg, waternormals.jpg) — the app now loads 13+ AT files: also jellyfish.bin, m

**`scripts/fetch-assets.mjs`**
- L3: 'These are Active Theory's own assets and are deliberately NOT committed to this repository' — contradicted by .gitignore:29-57, which whitelists and commits 9 assets/at/ files plus the entire env/ set (33 tracked files 
- L93: 'This runs as Vercel's build step (see vercel.json)' — vercel.json does not exist on disk or in git (ls + git ls-files both empty), so the pointer is dead and the claim unverifiable in this repo.

**`src/alcove.js`**
- L154: Leftover section header '---- the cable runs, additive: the green light lines along their ceiling.' directly precedes the SCREENS block whose own comment (lines 155-160) states 'The cables mesh is GONE outright'. No cabl
- L94: JSDoc '@param opts.poolTex the light-volume plate texture (reused from foliage)' documents a parameter the function never reads — the pool sprite it fed was removed (see lines 261-264). The doc keeps main.js:965 paying a

**`src/cards.js`**
- L53: 'Rendered title width works out at LABEL_W * 0.330 which is sized here to land at ~65% of card width' — with LABEL_W 3.22 that is 1.06 world units, which is ~41% of CARD_W 2.60, not 65%. The 0.483/0.330 derivation is cor

**`src/filmseq.js`**
- L41: Header memory/size math is three revisions stale: 'SIZE: 315 x ~122KB = ~38MB' (actual assets/deep-bg-960 is ~12MB, ~35KB/frame per line 57 and verified on disk), 'a decoded 1920x1080 frame is 8.3MB' (frames decode at 96
- L66: Two superseded cache-ceiling rationales ('Decoded-frame ceiling. 48 frames is ~21vh...' and '64 decoded frames: the live scrub window PLUS the sparse skeleton') sit directly above CACHE_MAX = 40; only the third block (li
- L258: 're-check: a slow decode may land after its frame was evicted-by-scroll' — the guard `if (cache.has(i))` fires on a double-INSERT (which the `decoding` set makes unreachable) and is false precisely in the evicted case it

**`src/flora.js`**
- L1434: The integrator comment says 'Underdamped on purpose: C is below the critical 2*sqrt(K), so a released plant swings back through rest once and settles' — the opposite of the actual configuration. Defaults are stiffness K=
- L828: `const variants = {};   // per organic proto: VARIANT geometries, round-robined` — the variant id is not round-robined, it is assigned uniformly at random: `B.vid.push(bedIsCard ? 0 : (rand() * VARIANTS) | 0)` (line 955)
- L1219: '2,840 springs is nothing' — stale instance count. The same file says '~6,800 instances' forty lines later (line 1370, the idle early-out comment), and the current main.js beds config sums ~7,350 scattered instances befo

**`src/jelly.js`**
- L115: Comment claims 'Uniform group scale means mat3(modelMatrix) is a valid normal transform here without the inverse-transpose' — but the mesh itself carries body.scale.y = 1.5 (jelly.js:641, and clones at 712), so the model
- L375: The coreBand comment says 'the surface now continues 1.8 units below it' and places the band at 'margin plus throat, the junction' near y -0.22..-0.04 — measurements from the deleted hand-built lathe/column. The loaded A
- L529: Two contradictory comment blocks sit stacked above uRefraction: the first (lines 529-534) explains the value '0.55, up from 0.3' with a rationale for full-bell coverage; the second (lines 535-539) explains the actual cod

**`src/main.js`**
- L1208: Comment: 'Track is now the sum of the three sections: Home 420 + About 105 + Work 1050.' The track is now five sections — land 105 + drift 140 + gather 140 + burst 520 + work 1050 = 1955vh (sections.js:112, SECTION_ORDER
- L738: Comment: 'It now opens at 360 -- ONE VH AFTER the film's last frame (209 + 150 = 359)... at every frame the film is up, the water is still parked at WATER_Y_FROM.' FILM_SPAN_VH is 190 (line 2690), so the film's last fram
- L819: Comment in the filmDrift block: 'smoothstep ends at zero velocity, so the hand-off into the water sink at 355 is C1-smooth.' The sink opens at 360 (line 743, 'moved up from 355..470'), and with FILM_SPAN_VH=190 the drift
- L540: Planets block: the header (line 528) says the bodies 'All sit at z -18/-30' and the large planet's comment says 'Moved DEEPER (z -34, was -18)', but the authored positions are z -26, -26, -25 and -34 (lines 549-576) — th
- L1647: uGradient comment: '0.40 keeps it to the edges, which is what it reads as on their site' — the value actually set is 0.30 (line 1648), and applySize uses 0.30 landscape / 0.26 portrait (line 4496).
- L1541: Transition comment: 'it costs nothing for all but 15vh either side of each of the two seams' — the bands are now TRANSITION_VH = { drift: 90, work: 160 } (line 1563), i.e. 45vh and 80vh either side. The 15vh figure is fr
- L2109: The __grab doc claims '__grab(true) — the same, and also report the composed frame', but window.__grab (2239) takes no parameter and has no composed-frame path; passing true silently does the same pre-post scene readback
- L1842: Corner-glow comment says 'Ours is built from uUIColor, held at the theme green' and 'uUIBlend is kept, but it now modulates the glow's STRENGTH with card proximity rather than its hue' — the shader body never references 
- L1883: The corner-glow numbers comments contradict the code: 1864 claims the base is 'vec3(0.55, 1.0, 0.5) -- the SAME S=0.5 and V=1.0', 1880-1881 claims 'Ours is ~0.55' for V, and 1883 claims the additive floor is 0.012 — the 
- L1955: The deep-grade comments claim uGrade is deep-only: 1955-1956 '(uGrade = deepF, exactly 0 everywhere above)', 1666-1669 'ramped by deepF so it exists only in the descent', and 1995-1999 '+18% exposure, deep section only..
- L2839: 'WORK STAYS AT 0. This pass is scoped to land/drift/gather' — contradicted by the code two lines below (2851-2852): work's gradeF is `1 - smoothstep(0.02, 0.10, S.work.progress)`, i.e. 1.0 at the cut, releasing to 0 only
- L2803: '`deepSection` is what that blend reads for this section' — no identifier named deepSection exists anywhere in the repo; the frame-loop blend reads window.__deepFor / __gradeFor / __dofFor (2889-2892, 3977-3987). A maint
- L3286: 'The tails hang from the mark here exactly as they do in the volume — home.update owns that placement math, so reuse it' (and the tail-angle paragraph at 3290-3294) — the tails (homeRoot) are hidden in land: line 2923 se
- L930: (Adjacent file, found while verifying textures.js's API.) The crackTex comment claims makeCrackedIceTexture() 'draws from the shared seeded rand() stream -- calling it would shift every later consumer ... off the approve
- L171: 'assets/at/ is not committed, so a fresh clone or deploy 404s here and falls back to the procedural cloud' — false since the .gitignore whitelist: assets/at/flower_spine-512.bin IS committed (.gitignore:30, confirmed by 
- L592: 'The deep's filmed epilogue -- assets/deep-bg/ as a scrubbed WebP frame sequence' — the sequence lives in assets/deep-bg-960/ (filmseq.js:65); assets/deep-bg/ does not exist in the repo and is gitignored as the supersede
- L628: 'by the time the film is needed the 33MB is long since in memory' — the 960-wide re-encode made the sequence 10.7 MB (filmseq.js:57; measured 11,209,188 bytes on disk). 33MB describes the deleted 1920x1080 set.

**`src/physarum.js`**
- L12: Header lists the ported gpu-io defaults as 'decayFactor 0.9 ... sensorDistance 18 ... stepSize 2 ... renderAmplitude 0.03', but the code ships decay 0.895, sensorDistance 9, stepSize 1, amplitude 0.02. The sensor/step ha
- L109: Comment 'four linear taps average a 3x3 neighbourhood, then decay' contradicts the code: the taps offset by a FULL texel land exactly on the four diagonal neighbours' centres, so no 3x3 average occurs and the centre texe

**`src/planets.js`**
- L150: Comment claims renderOrder = -3 makes the planet 'drawn before the foliage so the feathered limb blends against the background rather than against whatever happened to be sorted first'. The material is transparent:true (

**`src/sections.js`**
- L10: The header proof block presents the old table as current: 'lengths [Land 105, Drift 140, Gather 140, Burst 140, Work 1050] the track is 1575vh... Work starts at 525vh'. Actual SECTION_VH (line 112) has burst 520 — track 
- L65: The keyframe doc lists 'Burst 240vh' and line 69 states 'BURST WAS 140 AND IS NOW 240, and that is the only change to this table' — superseded twice since (380 at line 101, 520 at line 105); the 'only change' claim and t
- L98: 'test/ranges.mjs asserts it and passes; re-run it after any further change here' (and line 26's 'proves both claims numerically'): test/ranges.mjs:27 hardcodes LENGTHS with burst: 140 and imports nothing from sections.js

**`src/spine-glb.js`**
- L172: Trailing comment: 'The model's own material is used unmodified — no recolouring, no hue shift. Lighting comes from the scene environment set up in main.js.' Both halves contradict lines 73-143: the source material is rep
- L21: 'Cards orbit at radius 3.8 with the camera group at 7.6 and the eye at 9.6' — the eye figure reflects the authored camera z of 2.0; main.js:123-129 explicitly pulled it in to 1.25 (eye at 8.85, eye-to-card ~5.05). The st

**`src/textures.js`**
- L320: makeStudioEnv doc says 'Returned as HalfFloat with values well above 1.0' but the code at line 362 constructs the DataTexture with THREE.FloatType, not HalfFloatType. (The function is also dead — see the dead list — but 
- L4: File header presents the module as 'Procedural stand-ins for the original's bound assets: tEnv -> assets/images/work/env1.jpg ... Generated here so the recreation ships no third-party media' — but the primary path now lo
- L51: 'assets/at/ is not committed (those files are Active Theory's), so on a fresh clone or a deploy they 404 until npm run fetch:assets is run' — all five textures this file loads (env1.jpg, waternormals.jpg, matcap-test.jpg

**`src/transition.js`**
- L32: 'the seam there descends to the right at roughly 7 degrees, which in UV space is a slope near 0.13' contradicts line 107's 'measured at our 1568x744... inclination is 0.274': a 0.13 UV slope is 7 degrees only on a square

**`src/volumetric.js`**
- L39: The comment '/* gaussianblur.fs — their blur9, the standard 9-tap with linear-sampling offsets (1.3846 / 3.2308)... */' is attached to RAYS_FS — the 20-sample god-ray march — but describes BLUR_FS (defined at line 76, wh

**`src/water.js`**
- L16: Header claims 'Their live tuning values ... are the DEFAULTS here: uSpeed 0.04, uScale 1000, uWaterUVStrength -5, uBrightness 2, uLight (..., 0.04), uColor white' — no longer true for a single one of them: the code ships
- L25: Departure 2 says tMRO was 'Ported as const vec3(1.0): roughness 1 selects their tightened matcap branch' — the code at line 138 uses the measured vec3(0.996, 0.247, 1.0), and its own comment (129-137) explains that the v
- L44: Header paragraph 'tMap for the ceiling: theirs is cracked_ice_basecolor.png ... Ours is a tileable voronoi crack web synthesized at load (makeCrackedIceTexture in textures.js) ... tVideo: theirs overlays their shared sit

**`src/world.js`**
- L10: Header claims 'cards are ~3.4 units wide and the camera sits ~4 units back, so the spine is ~0.5 units across and the whole column is ~50 units tall' — every number contradicts current code: cards are 2.60 wide (cards.js
- L6: 'the real spine mesh is coming in as a GLB' reads as if the GLB is pending; it shipped (spine-glb.js, three committed builds in assets/), and buildSpine is now the permanent failure/?spine=off fallback (main.js:898-919),
---
## 10. Repo hygiene

- `package-lock.json` is tracked and coherent with `package.json`; vendor/ (three r180, lenis 1.1.18) is vendored deliberately — leave as is.
- Tooling (`clip.mjs`, `compress.mjs`, `glitch.mjs`, `inspect-glb.mjs`, `shot.mjs`, `Capture-Frames.ps1`, `scripts/*.mjs`, `test/*`) is all referenced from README or npm scripts and is not dead — but `shot.mjs` carries stale assumptions about the deleted fluid/physarum backdrops (6s waits, pointer sweeps) worth trimming when those modules are removed.
- `.gitignore` is coherent with the tracked set; the only stray is `feedback-report.txt` (see §3).
- `test/ranges.mjs` and `test/sweep.js` verify a scroll table that no longer exists (see bugs §1) — the safety net is currently testing the wrong site.

---
## 11. Suggested execution order

One commit per step; never mix a deletion with a bug fix. Verify in the browser after each step at: 60 (land), 300 (drift/gather), 700 (film), 860-950 (crossing), 1010+ (work room).

1. **Fix the corrupted asset** (§1, jungle_soil_normal.png is an HTML page): re-export a real normal map or drop the binding — today the emblem silently loses its authored surface detail.
2. **Confirmed bugs (§1), one at a time**, in listed order — DPR-sized transition targets and the water-sink/film overlap first (both user-visible), then the silent-argument and gating bugs.
3. **Delete confirmed-dead assets (§4)** — ~9.6 MB local plus the fetch-script line that re-downloads an unused LOD on every deploy.
4. **Delete dead source files (§3)** — fluid.js + physarum.js (757 lines), and update README/shot.mjs which still describe them.
5. **Dead code in live files (§5)** — imports first (zero risk), then unused uniforms/branches.
6. **Optimizations (§8)**, high impact first; measure before/after with the existing __dbg()/stats handles.
7. **Stale comment sweep (§9)** last — zero behavior risk, one commit.
8. Leave §6 (do-not-delete) and §7 (unsure) alone until each listed check is done.
