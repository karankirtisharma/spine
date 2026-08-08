# Work Spine

A three.js recreation of the **work section** from [activetheory.net](https://activetheory.net) —
the vertical spine with project cards orbiting it — built by reverse-engineering
the live site's shaders, layout code and authored parameters.

Study project. Not affiliated with Active Theory.

![capture](docs/capture.png)

---

## Run

```bash
npm install
npm run fetch:assets     # pulls two textures from activetheory.net (see Assets)
npm start                # http://localhost:5188
```

### URL flags

| Flag | Values | Default | Effect |
|---|---|---|---|
| `?spine=` | `sharp` · `high` · `max` · `raw` · `off` | `sharp` | Which GLB build to load |
| `?q=low` | — | off | Reduced particle counts |
| `?only=emblem` | — | off | Isolate the glass mark for material work |

### Debug handles

Exposed on `window` in every build. They exist because this scene has produced
three visually identical failures with unrelated causes — a shader NaN, a paused
render loop, and a dropped pass — and a screenshot cannot tell them apart.

| Handle | Use |
|---|---|
| `__dbg()` | camera, per-card cull bitmap, shader uniforms, program count |
| `__grab()` | reads pixels back **at viewport size**; a 64px probe lies, because `gl_PointSize` is in pixels |
| `__passes` | per-pass `.enabled` — bisect the post chain without a reload |
| `__scene` | per-object `.visible` — bisect the scene graph |
| `__over` | override individual composite terms (`sat`, `vol`, `bloom`) |

---

## What came from the original

Extracted from `activetheory.net/assets/js/app.<cache>.js`,
`assets/shaders/compiled.vs` (172 GLSL programs) and
`assets/data/uil.json` (2,593 authored parameters).

**The hero sections' shaders, ported line-for-line:**

| Theirs | Ours | What it is |
|---|---|---|
| `HomeColumnShader.glsl` | [`home.js`](src/home.js) | the crossing teardrop tails. Helical vertex displacement, **not** splines — `uDirection` is ±1 on the two columns, so they wind in opposite handedness and cross |
| `ParticleTestShader.glsl` | [`home.js`](src/home.js) | the plume — funnel, loft, and the expanding burst ring |
| `FXScrollTransition.glsl` | [`transition.js`](src/transition.js) | the inclined anti-aliased seam between two scenes rendered in the same frame, edge warped by a scrolling normal map |
| `VolumetricLight.fs` + `LightBlur.fs` | [`volumetric.js`](src/volumetric.js) | god rays. Their 20-sample radial march, their `blur9` |
| `HomeLogoShader.glsl` | [`emblem.js`](src/emblem.js) | screen-space refraction through the surface normal |
| `JellyShader.glsl` | [`jelly.js`](src/jelly.js) | the cnoise bell wobble and both sway terms, verbatim and undecorated |
| `assets/geometry/home/jellyfish.bin` | [`jelly.js`](src/jelly.js) | **their jellyfish model itself** — 15,672 verts of Draco in 24 KB. Earlier passes rebuilt this creature by hand from screenshots and it was wrong every time; the path is listed in their *versioned* `uil.<cache>.json`, not the unversioned one |
| `HomeComposite.fs` | [`main.js`](src/main.js) | `color += texture2D(tVolumetricBlur, vUv) * uVolumetricStrength` |
| `FlowerParticleShader.glsl` | [`flower-cloud.js`](src/flower-cloud.js) | their baked 262k point cloud, curled into a helix |

Their per-frame `Home` and `About` render ticks are transcribed with their
constants intact — camera `y 40 → −7`, `z` from `visibleV`, the 190° scroll
rotation doubled on the mark, the 210° entrance unwind, drag inertia at `0.07`.

**Shaders, ported line-for-line** — `WorkItemShader.glsl` and
`WorkItemUIShader.glsl`, plus the chunks they `#require`
(`radialblur`, `rgbshift`, `fresnel`, `transformUV`, `range`, `refl`,
`blendmodes`) in [`src/glsl-chunks.js`](src/glsl-chunks.js).

Three things worth knowing, because they are not guessable:

- The card is a **box, not a plane** — `vSide = abs(normal.x)` drives
  `color *= 1.0 + pow(vSide, 3.0)`, which is where the edge glow comes from.
- A vertex **shear**, `pos.y -= pos.x * mix(0.08, 0.14, uPhone)`, gives the lean.
- The glitch is `uv.x += fract(uv.x * 15.0) * edges`, where `edges` grows with
  `abs(vViewDir.x - 0.5)` — it is **view-angle driven**, not scroll driven,
  which is why only the oblique card breaks up.

**Layout** — a direct port of `WorkItems.positionViews()`: cards on a helix at
radius 3.8, −50° per card, `y` dropping `0.12 * min(7, n)`. `lookAt` aims each
card's +Z *outward*; the camera copies that quaternion so its −Z points back
inward through the card. That is why every card is nearest at its spine-facing
edge. The camera group sits at 2× the card radius, with the eye a further
`[0, 0, 2]` inside it (`CAMERA_Element_2_Work`, fov 35).

**Camera rail** — `handleCameraScroll` verbatim: `smoothStep(0.06, 0.94, p)`
dead-zone, waypoint lerp/slerp at 0.2, `±1` tail easing, far-to-near render
sorting every frame.

**Hover** — from `WorkItem`'s render tick: `uHover` and the pointer both ease at
`0.08`; `uVideoBlend` is *not* hover-driven but tweens `500ms easeOutSine` after
a `300ms` delay when a card becomes nearest; clicks are gated on
`__distToCamera > 30`.

**Composite** — `GlobalComposite.fs` corner glow (HSV base `vec3(0.5,0.5,1.0)`,
hue drifting `+0.88 ± 0.065` on noise) and its `blendOverlay(..., 0.15)` grain.

---

## What is original to this project

- **Liquid hover** — domain-warped flow field refracting the media UVs, with a
  cursor-driven ripple, drag wake and wet pool. Entirely gated on `uHover`.
- **Wet spine** — `clearcoat 1.0 / clearcoatRoughness 0.045` over the model's
  own maps, plus a fresnel emissive injected via `onBeforeCompile`.
- **Glitter** — reproduces the density of Active Theory's GPGPU particles
  (`FlowerParticleShader` reads positions from an Antimatter sim riding a
  curl-noise field) using fbm-density rejection sampling plus curl-gradient
  displacement. That is what produces connected filaments with voids rather
  than isolated blobs.
- **Backdrops** — see Credits.

---

## Assets

| Asset | Status |
|---|---|
| `assets/spine.sharp.glb` (7.51 MB) | committed — default |
| `assets/spine.opt.glb` (2.77 MB) | committed — `?spine=high` |
| `assets/spine.min.glb` (1.18 MB) | committed — `?spine=max` |
| `assets/spine.glb` (69.78 MB) | **not committed**, over GitHub's size threshold |
| `assets/at/flower_spine-512.bin` | Active Theory's — see below |
| `assets/at/env1.jpg`, `waternormals.jpg` | Active Theory's — see below |

`?spine=raw` needs the 69.78 MB source, which is not in the repo.

### Active Theory's assets and the deployed build

Three files the app loads are Active Theory's own work, pulled by
`npm run fetch:assets`:

| File | What it is | Without it |
|---|---|---|
| `flower_spine-512.bin` | their baked floret point cloud, 262k Draco points with per-point colour | falls back to the procedural cloud in `world.js` — visibly thinner, no sculpted clumps |
| `env1.jpg` | environment map | procedural gradient; spine reflections flatten |
| `waternormals.jpg` | tiling normal map | procedural substitute |

The fallbacks are wired so a clean clone always runs. But they are **not
equivalent** — the floret cloud is most of the look, and a deploy without it
renders noticeably worse than local. That difference is expected, not a bug.

Note the green retint is applied at **runtime** (`retintToPalette()` in
`flower-cloud.js`), not baked into the file. The `.bin` on disk is Active
Theory's unmodified data.

Whether those files belong in a given checkout is a call for whoever owns it.
They are Active Theory's, and if they are committed they should stay credited as
such — see Credits below.

### Compression

```bash
node compress.mjs high    # 69.78 MB -> 2.77 MB  (-96.0%)
node compress.mjs max     # 69.78 MB -> 1.18 MB  (-98.3%)
```

`weld → simplify → resize → webp → meshopt`. The weld step matters: the source
export ships split vertices that block edge collapses, so simplification does
almost nothing without it. Output uses `EXT_meshopt_compression`,
`KHR_mesh_quantization` and `EXT_texture_webp`.

> Quantization puts the decode scale on the **node**, not the geometry — measure
> bounds after `applyMatrix4(mesh.matrixWorld)` or compressed models come out at
> the wrong size.

---

## Credits & licences

- **Active Theory** — the original site, its shaders, its design and its assets.
  All rights theirs. Specifically, and with thanks:
  - `FlowerParticleShader.glsl`, `SpineShader.glsl`, `WorkItemShader.glsl`,
    `WorkItemUIShader.glsl` and `GlobalComposite.fs`, extracted from their
    public `assets/shaders/compiled.vs` and ported here for study. Their
    authored constants — hue-drift and noise rates, corner gain, falloff
    curves, point sizing — are used as-is wherever noted in the source.
  - `WorkItems.positionViews()` and `handleCameraScroll()`, the helix layout and
    camera rail, ported from their `app.js`.
  - `flower_spine-512.bin` — their baked floret point cloud. The structure is
    theirs entirely: a flat ribbon that their shader curls into a helix via
    `cos/sin(decodedPos.y * 0.06)`. Recoloured to green at runtime here; the
    clustering is untouched and is not reproducible by any runtime noise.
  - `env1.jpg`, `waternormals.jpg` — their textures.

  Nothing here is affiliated with or endorsed by Active Theory.
- **NB Architekt Std** (Neubau) — the original's typeface. Licensed, so **not**
  included; a monospace fallback is used instead.
- **gpu-io** (Amanda Ghassaei, MIT) — the physarum algorithm and default
  parameters behind `src/physarum.js`. Reimplemented on three.js render targets.
- **three.js** (MIT), **Lenis** (MIT).
- Project videos are **not** used. Card media is generated procedurally in
  `src/textures.js`.

`haxiomic/GPU-Fluid-Experiments` was considered for the fluid backdrop and
deliberately **not** used: it is GPL-3.0, which would place this project under
copyleft, and it is Haxe against its own GL context. `src/fluid.js` implements
the same Stam solver from Active Theory's own fluid shaders instead.

---

## Layout

```
src/
  main.js         scene, per-section staging, post-processing, debug handles
  sections.js     the scroll table — five sections, one remapped scalar
  transition.js   FXScrollTransition.glsl — the inclined seam between scenes
  intro.js        scroll-driven drives for the hero volume
  home.js         HomeColumnShader tails + ParticleTestShader plume
  about.js        the landing section's DOM (headline, copy, service rows)
  emblem.js       the glass mark — screen-space refraction, not transmission
  jelly.js        their jellyfish model + JellyShader vertex displacement
  comet.js        filament streak bundle
  nebula.js       billboarded fbm cloud volumes + aurora ribbon
  volumetric.js   VolumetricLight.fs + LightBlur.fs god rays
  cards.js        WorkItemShader / WorkItemUIShader ports, helix layout
  flower-cloud.js their baked point cloud, retinted per instance
  glsl-chunks.js  Hydra shader chunks, verbatim
  shaders.js      noise / colour helpers
  world.js        particle field, proxy column
  spine-glb.js    GLB loading, wet material, emissive
  textures.js     procedural stand-ins
  projects.js     the 14 projects on the spine
test/
  ranges.mjs      proves the scroll arithmetic — run before changing a length
  compare.mjs     diffs a sweep against baseline.json
  sweep.js        in-page scroll sweep, paste into the console
  baseline.json   the Work section's pinned reference
compress.mjs      GLB pipeline
```

## Scroll structure

Five sections on one 1575vh track, driven by a single remapped scalar.

| Section | Length | Frame |
|---|---|---|
| `land` | 105vh | the settled hero — mark, headline, service rows |
| `drift` | 140vh | near-black, sparse grain, jellyfish, comet |
| `gather` | 140vh | the field converges, fog and nebula build |
| `burst` | 140vh | white-blue core flash, field thrown outward |
| `work` | 1050vh | the spine and its fourteen cards |

`drift`/`gather`/`burst` share **one** camera move (Active Theory's Home rig,
y 40 → −7), so their boundaries are not scene changes and deliberately do not
wipe. Only `land → drift` and `burst → work` are true cuts.

The lengths are not arbitrary: the four lead-in sections sum to 525vh, which
leaves `work` a clamped span of exactly 950vh — identical to the travel of the
original single-section build. Work's local progress is therefore bit-identical
to the numerically-proven baseline, which is what `test/ranges.mjs` asserts
(worst error 3.3e-16 over 951 samples). **Run it before changing any length.**
