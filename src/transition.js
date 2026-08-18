import { RANGE, TRANSFORM_UV } from './glsl-chunks.js';

/* Section-to-section wipe — Active Theory's FXScrollTransition.glsl.
 *
 * Their sections do not cut and they do not crossfade. Two scenes are rendered at
 * the same time and an inclined, anti-aliased edge sweeps between them, with the
 * seam itself warped by a scrolling normal map so it reads as a liquid front
 * rather than a straight line. The incoming section grows from the bottom of frame
 * as you scroll down, which is why both scenes are visible at once mid-wipe.
 *
 * The fragment shader below is transcribed verbatim, including `inclination2`,
 * `uVelocity` and `uAngleVelocity`, which their own shader declares and never
 * uses. Left in place rather than tidied away: this is a transcription, and the
 * next person to compare it against compiled.vs should find it line for line.
 *
 * ONE STRUCTURAL DIFFERENCE, stated plainly. Theirs feeds the wipe two fully
 * composited scene textures. Here tMap2 is the live render of the incoming
 * section straight out of RenderPass, and only tMap1 is a pre-rendered target --
 * so bloom and the composite run once, AFTER the mix, rather than once per scene
 * before it. That halves the post-processing cost during a wipe and is
 * indistinguishable at these settings, but it is not what they do.
 */
export const TransitionShader = {
  uniforms: {
    tDiffuse: { value: null },          // the incoming section, live — their tMap2
    tMap1: { value: null },             // the outgoing section, pre-rendered
    tNormal: { value: null },
    uTransition: { value: 0 },
    /* inclination = -0.2 * uAngle * uRatio, so these two only ever appear as a
     * product. Read off the reference frames rather than from uil.json, which
     * does not author them: the seam there descends to the right at roughly 7
     * degrees, which in UV space is a slope near 0.13. */
    uAngle: { value: -0.65 },
    uRatio: { value: 1.0 },
    uVelocity: { value: 0 },            // declared by their shader, unused in it
    uAngleVelocity: { value: 0 },       // likewise
    resolution: { value: null },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tMap1;
    uniform sampler2D tNormal;
    uniform float uTransition;
    uniform float uAngle;
    uniform float uVelocity;
    uniform float uAngleVelocity;
    uniform float uRatio;
    uniform vec2 resolution;
    varying vec2 vUv;

    ${RANGE}
    ${TRANSFORM_UV}

    float aastep(float threshold, float value) {
      float signedDist = threshold - value;
      float d = fwidth(signedDist);
      return 1.0 - smoothstep(-d, d, signedDist);
    }

    float aastep(float threshold, float value, float padding) {
      return smoothstep(threshold - padding, threshold + padding, value);
    }

    void main() {
      vec2 uv = vUv;

      vec2 squareUV = scaleUV(vUv, vec2(1.0, resolution.x / resolution.y));
      vec2 normalUV = scaleUV(squareUV, vec2(0.3));
      normalUV.y -= uTransition * 1.0;
      vec3 normal = crange(texture2D(tNormal, normalUV).rgb, vec3(0.0), vec3(1.0), vec3(-1.0), vec3(1.0));

      float inclination = -0.2 * uAngle * uRatio;
      float inclination2 = -0.1 * uAngle * uRatio;

      float offset = 0.2;
      float transition = crange(uv.y + (uv.x * inclination) + 0.1, 0.0, 1.0, uTransition + offset, uTransition - offset);

      /* the warp envelope tracks the SAME span as the cut, or the distortion
       * band drifts away from the seam it exists to soften */
      float fade = aastep(uv.y + (uv.x * inclination),
                          crange(uTransition + 0.01, 0.0, 1.0, 0.0, 1.0 + inclination), 0.15);

      uv += normal.xy * 0.025 * smoothstep(0.5, 0.0, abs(transition - 0.5)) * smoothstep(0.5, -0.2, abs(fade - 0.5));

      vec3 color1 = texture2D(tMap1, uv).rgb;
      vec3 color2 = texture2D(tDiffuse, uv).rgb;

      /* THE SEAM ENTERS FROM OFF-FRAME, AND LEAVES OFF-FRAME.
       *
       * The measure this is thresholded against, uv.y + uv.x * inclination,
       * spans 0 .. 1+inclination over the screen. The range this shipped with
       * (inclination .. 1.0) therefore never covered either end: measured at
       * our 1568x744 with uAngle -0.65, inclination is 0.274, so
       *
       *     t = 0  ->  threshold 0.274  ->  14.1% of the frame ALREADY the
       *                incoming section, appearing in a single frame
       *     t = 1  ->  threshold 1.000  ->  only 85.9% covered, so the
       *                outgoing never fully leaves
       *
       * That 14% arriving at once is the "line appears, pop type, uneven" --
       * the seam does not sweep in from the edge, it materialises a wedge and
       * only then starts moving, which is also why it cannot be seen coming.
       *
       * 0 .. 1+inclination is the exact span of the measure, so the line
       * starts fully below the bottom edge and finishes fully past the top:
       * 0% at t=0, 100% at t=1, and every frame between is the line actually
       * travelling. */
      float cut = aastep(uv.y + (uv.x * inclination),
                         crange(uTransition, 0.0, 1.0, 0.0, 1.0 + inclination));
      vec3 color = mix(color1, color2, cut);

      gl_FragColor.rgb = color;
      gl_FragColor.a = 1.0;
    }
  `,
};

/**
 * Is the playhead inside a wipe, and if so between which two sections and how
 * far through?
 *
 * `bandVh` is the full width of the wipe in vh, centred on the boundary. The wipe
 * therefore starts before the boundary and finishes after it, which is what makes
 * both scenes visible either side of the seam.
 *
 * Returns `{ active }` alone when there is no wipe, so callers can disable the
 * pass and pay nothing for it -- which is the whole of the Work section apart from
 * its first `bandVh/2`.
 */
export function transitionState(progress, table, order, bandVh = 30, seams = null) {
  const { travelVh, ranges } = table;
  const half = (bandVh * 0.5) / travelVh;

  for (let i = 1; i < order.length; i++) {
    /* `seams` restricts which boundaries wipe, by INCOMING section name. The
     * five-section track needs it: drift, gather and burst are one continuous
     * camera move through one volume -- a wipe between them would cut a shot in
     * half. Only entering the volume (land -> drift) and leaving it for the spine
     * (burst -> work) are true scene changes. */
    if (seams && !seams.includes(order[i])) continue;
    const b = ranges[order[i]].start;
    const d = progress - b;
    if (d < -half || d > half) continue;
    return {
      active: true,
      outgoing: order[i - 1],
      incoming: order[i],
      /* 0 at the start of the band, 1 at the end. Their shader takes it from
       * there: at 0 the seam sits at the bottom of frame and the outgoing scene
       * fills it; at 1 the seam has left the top and the incoming scene does. */
      t: (d + half) / (half * 2),
    };
  }
  return { active: false };
}
