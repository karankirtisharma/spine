import * as THREE from 'three';

/* THE ORBITAL GRID — reference frame 12's set dressing around the Cyphernaut.
 *
 * Frame 12 wraps the figure in a flat diagram of concentric circles -- some solid,
 * some dotted, one carrying small tick arcs -- and stands it on a particle floor with
 * a soft radial ground glow. The diagram plainly sits BEHIND the figure (rings pass
 * behind the chest and re-emerge), and it faces the camera square-on.
 *
 * Everything here is procedural. Circles and dashes are not an asset to find: their
 * site draws its HUD linework from GLUI, and a LineLoop with an additive material is
 * the same statement in three. The one texture is a radial gradient painted into a
 * canvas at build time.
 *
 * DRAW-ON, not fade-in: setReveal(p) walks the rings outward-first with a per-ring
 * fade, so the diagram assembles as the section arrives -- the standard HUD trope
 * frame 12 freezes midway. p also feeds the floor and glow, which come up later in
 * the ramp (the ground reads as the LAST thing to materialise).
 */

/* ---- the nova burst -------------------------------------------------------
 *
 * Frame 9's detonation is IN THE SCENE, not a post effect, and that distinction is
 * the whole composition: the reference shows a dark, opaque suit against a
 * cyan-white radial explosion, light spilling AROUND the silhouette. A screen-space
 * flash (the composite's uFlash) adds over everything -- the first attempt used it
 * and the figure's chest glowed white THROUGH its own occluder, exactly backwards.
 * Scene-space sprites behind the figure are occluded by the dark shell like any
 * other geometry, which is what produces the rim-lit silhouette.
 *
 * Two stacked sprites: a tight hot core and a wide cool corona -- the two-radius
 * structure frame 9 shows, and cheaper than any shader. */
export function buildNovaBurst(opts = {}) {
  const group = new THREE.Group();

  const make = (stops, scale) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [t, col] of stops) g.addColorStop(t, col);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(m);
    s.scale.set(scale, scale, 1);
    /* -2: BEFORE the figure's occluder shell at -1. renderOrder is the PRIMARY key
     * in three's transparent sort -- it beats depth -- and with depthWrite off
     * everywhere there is no depth test to fall back on. At the default 0 the burst
     * drew after the occluder and its additive core stacked ON TOP of the darkened
     * suit: a white chest, the exact opposite of frame 9. Ordering is the only
     * occlusion mechanism a transparent stack has. */
    s.renderOrder = -2;
    group.add(s);
    return m;
  };

  const core = make([
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(210,245,255,0.85)'],
    [0.6, 'rgba(120,200,225,0.25)'],
    [1, 'rgba(0,0,0,0)'],
  ], opts.coreScale ?? 9);
  const corona = make([
    [0, 'rgba(190,235,255,0.55)'],
    [0.4, 'rgba(110,190,215,0.28)'],
    [0.75, 'rgba(60,130,160,0.10)'],
    [1, 'rgba(0,0,0,0)'],
  ], opts.coronaScale ?? 26);

  return {
    group,
    /** 0..1. The corona leads and the core follows -- a detonation blooms outward. */
    setIntensity(i) {
      corona.opacity = Math.min(1, i * 1.15) * 0.8;
      core.opacity = Math.max(0, i - 0.12) * 1.0;
    },
  };
}

const RING_SEGS = 128;

function circleGeometry(radius, segs = RING_SEGS) {
  const pts = new Float32Array((segs + 1) * 3);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts[i * 3] = Math.cos(a) * radius;
    pts[i * 3 + 1] = Math.sin(a) * radius;
    pts[i * 3 + 2] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return g;
}

/* A partial arc, for the tick-mark ring. */
function arcGeometry(radius, a0, a1, segs = 48) {
  const pts = new Float32Array((segs + 1) * 3);
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (i / segs) * (a1 - a0);
    pts[i * 3] = Math.cos(a) * radius;
    pts[i * 3 + 1] = Math.sin(a) * radius;
    pts[i * 3 + 2] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return g;
}

function radialGlowTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(190, 255, 226, 0.85)');
  g.addColorStop(0.35, 'rgba(120, 210, 176, 0.30)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * @param opts.color   ring colour, default the site's pale mint
 * @returns { group, setReveal, update } — group is authored around the origin with
 *          the rings in the XY plane and the floor at y = 0, matching the baked
 *          figure's feet; the caller positions it.
 */
export function buildGridFx(opts = {}) {
  const group = new THREE.Group();
  const color = new THREE.Color(opts.color ?? '#9fe6c4');

  /* ---- the ring diagram, chest-high, facing +z --------------------------- */
  const rings = new THREE.Group();
  /* Chest height on the 10-unit figure; slightly behind so the figure occludes
   * nothing (additive) but SORTS behind its dark occluder shell when that is up. */
  rings.position.set(0, 5.6, -1.3);
  group.add(rings);

  /* Radii read off frame 12: the diagram spans about 2.2x the figure's shoulder
   * width at its widest, with the inner rings hugging the helmet. Mixed weights --
   * two bright, the rest faint -- which is what keeps it a diagram rather than a
   * target. Every material is additive with depthWrite off, the transparent-stack
   * rule everywhere in this scene. */
  const RINGS = [
    { r: 1.7, o: 0.30, dashed: false },
    { r: 2.4, o: 0.12, dashed: false },
    { r: 3.2, o: 0.26, dashed: true },
    { r: 4.1, o: 0.10, dashed: false },
    { r: 5.0, o: 0.22, dashed: false },
    { r: 6.1, o: 0.10, dashed: true },
    { r: 7.2, o: 0.16, dashed: false },
  ];
  const ringMats = [];
  for (const spec of RINGS) {
    let line;
    if (spec.dashed) {
      const m = new THREE.LineDashedMaterial({
        color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
        dashSize: 0.16, gapSize: 0.24,
      });
      line = new THREE.Line(circleGeometry(spec.r), m);
      line.computeLineDistances();
      ringMats.push({ m, target: spec.o });
    } else {
      const m = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      line = new THREE.LineLoop(circleGeometry(spec.r), m);
      ringMats.push({ m, target: spec.o });
    }
    rings.add(line);
  }

  /* Four short tick arcs on the outer band -- the "instrument" detail that stops
   * the diagram reading as plain concentric circles. One shared material. */
  const tickMat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2 + 0.18;
    rings.add(new THREE.Line(arcGeometry(6.65, a0, a0 + 0.5), tickMat));
  }

  /* ---- the floor --------------------------------------------------------- */
  /* Particle scatter: a disc under the feet, denser toward the centre. Deterministic
   * (mulberry32) so the layout is identical every load -- this is set dressing in a
   * composed frame, the same rule as the jellyfish specs. */
  const FLOOR_N = 2600;
  let seed = 0x600DF1;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fp = new Float32Array(FLOOR_N * 3);
  for (let i = 0; i < FLOOR_N; i++) {
    /* sqrt-free: rand()^1.6 biases samples toward the centre, which is where frame
     * 12's floor burns brightest under the boots. */
    const r = Math.pow(rand(), 1.6) * 6.2;
    const a = rand() * Math.PI * 2;
    fp[i * 3] = Math.cos(a) * r;
    fp[i * 3 + 1] = (rand() - 0.5) * 0.22;      // a little vertical scatter, not a plane
    fp[i * 3 + 2] = Math.sin(a) * r * 0.6;      // ellipse: perspective floor, not a wall
  }
  const floorGeo = new THREE.BufferGeometry();
  floorGeo.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  const floorMat = new THREE.PointsMaterial({
    color: new THREE.Color(opts.floorColor ?? '#bfe8d4'),
    size: 0.055, sizeAttenuation: true,
    transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const floor = new THREE.Points(floorGeo, floorMat);
  group.add(floor);

  /* Ground glow: one additive sprite squashed flat. */
  const glowMat = new THREE.SpriteMaterial({
    map: radialGlowTexture(),
    transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(8.5, 2.6, 1);
  glow.position.set(0, 0.2, -0.4);
  group.add(glow);

  let reveal = -1;

  return {
    group,

    /**
     * 0..1. Rings assemble inner-to-outer across the first 70%, each with its own
     * fade window; ticks arrive with the outer band; floor and glow come up over the
     * back half. Idempotent per value, cheap enough to call every stage.
     */
    setReveal(p) {
      if (p === reveal) return;
      reveal = p;
      const n = ringMats.length;
      for (let i = 0; i < n; i++) {
        /* Ring i fades over [i/n * 0.55, i/n * 0.55 + 0.18] of the ramp. */
        const t0 = (i / n) * 0.55;
        const k = Math.min(1, Math.max(0, (p - t0) / 0.18));
        ringMats[i].m.opacity = ringMats[i].target * k * k * (3 - 2 * k);
      }
      const tk = Math.min(1, Math.max(0, (p - 0.5) / 0.2));
      tickMat.opacity = 0.30 * tk;
      const fk = Math.min(1, Math.max(0, (p - 0.35) / 0.4));
      floorMat.opacity = 0.55 * fk;
      glowMat.opacity = 0.50 * fk;
    },

    /* A very slow counter-rotation on the diagram -- frame 12's HUD reads as live
     * instrumentation, and dead-still linework reads as a watermark. */
    update(dt) {
      rings.rotation.z += dt * 0.02;
    },
  };
}
