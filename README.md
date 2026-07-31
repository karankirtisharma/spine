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
| `?spine=` | `high` · `max` · `raw` · `off` | `high` | Which GLB build to load |
| `?bg=` | `fiber` · `fluid` · `off` | `fiber` | Backdrop simulation |
| `?q=low` | — | off | Reduced particle/sim resolution |

---

## What came from the original

Extracted from `activetheory.net/assets/js/app.<cache>.js`,
`assets/shaders/compiled.vs` (172 GLSL programs) and
`assets/data/uil.json` (2,593 authored parameters).

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
| `assets/spine.opt.glb` (2.77 MB) | committed — default |
| `assets/spine.min.glb` (1.18 MB) | committed — `?spine=max` |
| `assets/spine.glb` (69.78 MB) | **not committed**, over GitHub's size threshold |
| `assets/at/*.jpg` | **not committed** — Active Theory's, fetched by `npm run fetch:assets` |

`?spine=raw` needs the 69.78 MB source, which is not in the repo. Everything
else works from a clean clone.

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

- **Active Theory** — the original site, its shaders and its design.
  Shader ports and layout constants here are for study. All rights theirs.
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
  main.js         scene, camera rail, scroll, post-processing
  cards.js        WorkItemShader / WorkItemUIShader ports, helix layout
  glsl-chunks.js  Hydra shader chunks, verbatim
  world.js        particle field, proxy column
  spine-glb.js    GLB loading, wet material, emissive
  physarum.js     fiber backdrop
  fluid.js        fluid backdrop
  textures.js     procedural stand-ins
  projects.js     the 14 projects on the spine
compress.mjs      GLB pipeline
shot.mjs          Playwright capture
```
