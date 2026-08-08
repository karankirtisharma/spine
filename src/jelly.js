import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { FRESNEL, BLEND_MODES, MATCAP_VS } from './glsl-chunks.js';
import { parseATContainer } from './flower-cloud.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* THE JELLYFISH — Active Theory's model, Active Theory's shader
 *
 * THE GEOMETRY IS NOW THEIRS. Every previous version of this file built the creature
 * by hand -- a lathe bell, a tapering column, tube filaments, per-part vertex
 * attributes to blend between them -- and every version was wrong in a new way: legs
 * detached, legs too long, bell a cone, bell a capsule, body missing entirely. All of
 * that is deleted. The mesh loaded here is assets/geometry/home/jellyfish.bin off their
 * own site: 15,672 vertices, 5,224 triangles, non-indexed, position/normal/uv,
 * 0.819 x 2.052 x 0.826 units and centred on the origin.
 *
 * HOW IT WAS FOUND, because the earlier failure was a research failure and not a
 * modelling one. Their boot script sets
 *     window.UIL_STATIC_PATH = "assets/data/uil.1780406240914.json"
 * and that VERSIONED file lists every geometry on the site. Earlier passes read the
 * unversioned assets/data/uil.json, which carries the shader parameters but none of
 * the geometry paths -- so the model looked as though it did not exist, and the
 * response was to keep reconstructing it from photographs.
 *
 * What the model actually is, measured (and worth recording, because it settles several
 * arguments this file has had with itself): binning the vertices by height, 9,309 of
 * the 15,672 sit in the 80-90% band at radius up to 0.425 -- that is the bell, at the
 * TOP. The lower 80% of the height is the trailing body at radius 0.10-0.24, so the
 * hanging part is up to 57% of the bell's width. Not threads. A body.
 *
 * THEIR PLACEMENT, from JellyInstancer in their bundle, also now followed:
 *   scale.setScalar(random(1.5, 3));  scale.y *= 1.5;
 * The 1.5x vertical stretch is theirs and is load-bearing -- it takes the model's
 * native 2.5:1 height:width to 3.75:1, which is the elongated silhouette their frames
 * show. Their scene also runs FOUR instances rising through the volume on a
 * scroll-rotated batch; ours stays a single specimen because that composition was
 * already reviewed and approved, and the instancer is scene choreography rather than
 * part of the creature.
 *
 * THE SHADER is theirs as before, and with their geometry it needs no additions at all:
 *
 *   1. cap wobble    pos.y   += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8
 *                                      + time * 0.5 * 0.35) * 0.6
 *   2. fine ripple   pos.xz += sin/cos(pos.y + time * 0.1 + uScroll) * 0.1
 *   3. broad sway    pos.xz += sin/cos(pos.y * 0.04 + time * 0.2) * 1.0
 *
 * All three are now VERBATIM with no gain, no phase attribute and no ramp. Those were
 * compensations for hand-built geometry: separate tube meshes needed amplified ripple
 * to bend at all, and needed per-strand phase to avoid swinging as one rigid comb --
 * which then tore them off the bell and had to be ramped back in. On one authored mesh
 * the terms flow continuously from crown to tip, which is what they were written for.
 *
 * On term 1 specifically: the frequency vector's y component is 0.5, five times the 0.1
 * on x and z, so over this model's 2.05 units the field sweeps 0.82 of a period along
 * the body while barely varying horizontally. That is a vertical squash-and-stretch,
 * and on their geometry it is the SWIM PULSE -- a medusa swims by contracting its bell.
 * A previous pass here read that as a bug and attenuated it. With their proportions it
 * is kept exactly as written.
 *
 * Their FRAGMENT does not port. It opens with getFBR / unpackNormalFBR from their
 * fbr.vs / fbr.fs chunks -- a forward-lit material chain not among this bundle's
 * extractable chunks -- and it also feeds on tVideo of the showreel. The fragment below
 * is built from our own chunks around the two textures uil.json really binds
 * (matcap-test.jpg as tMap and tMatcap, alien_cracked_2_normal.png as tNormal), and
 * keeps their tone curve, their rainbowColor and their tRefraction sample. Their
 * mouse-whiten term (vMouse) and the video feed are dropped.
 *
 * Output is clamped throughout: this scene composites through HalfFloat targets with
 * additive blending and UnrealBloom, where one hot pixel becomes Inf and one Inf pixel
 * blacks the whole frame once the separable blur touches it.
 */

const JELLY_VS = /* glsl */`
  uniform float time;
  uniform float uScroll;

  /* No aPart attribute any more. It existed to tell the shader which hand-built piece
   * each vertex belonged to; their model is one authored mesh and needs no such thing. */

  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying float vY;

  ${NOISE}

  void main() {
    vec3 pos = position;

    /* AT, JellyShader.glsl vertex, all three terms VERBATIM and in their order -- the
     * wobble writes pos.y first, and both sway terms then read the wobbled pos.y.
     *
     * Everything that used to decorate these lines is gone: no ripple gain, no
     * per-strand phase, no root ramp, no decomposition of the wobble. Each of those was
     * a compensation for geometry built by hand, and with their mesh there is nothing
     * left to compensate for. Term 1's vertical squash is the swim pulse on their
     * proportions, not the accordion it was on ours. */
    pos.y += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8 + time * 0.5 * 0.35) * 0.6;

    pos.x += sin(pos.y + time * 0.1 + uScroll) * 0.1;
    pos.z += cos(pos.y + time * 0.1 + uScroll) * 0.1;

    pos.x += sin(pos.y * 0.04 + time * 0.2) * 1.0;
    pos.z += cos(pos.y * 0.04 + time * 0.2) * 1.0;

    /* vY is the UNDISPLACED y, so the fragment's height-dependent terms key off where a
     * vertex sits on the animal rather than where the swim pulse has thrown it. */
    vY = position.y;
    vUv = uv;

    vWorldPos = vec3(modelMatrix * vec4(pos, 1.0));
    /* World-space normal, for the matcap lookup. reflectMatcap needs world space --
     * vNormal below is view space (normalMatrix), which is what their fresnel term
     * wants, so both are carried. Uniform group scale means mat3(modelMatrix) is a
     * valid normal transform here without the inverse-transpose. */
    vWorldNormal = normalize(mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * normal);
    // AT: vNormal = normalMatrix * normal; vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0))
    vNormal = normalMatrix * normal;
    vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const JELLY_FS = /* glsl */`
  uniform sampler2D tRefraction;
  uniform sampler2D tMatcap;
  uniform sampler2D tNormal;
  uniform float uMatcap;
  uniform float uNormalStrength;
  uniform float uNormalScale;
  uniform float uRefraction;
  uniform float time;
  uniform vec2 resolution;
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform vec3 uTint;
  /* Scalars again. These were vec2 pairs -- .x for the bell, .y for the tentacles --
   * because the hand-built body needed its invented pieces to look different from each
   * other, selected per vertex by an aPart attribute. Their model is one authored mesh
   * that gets one material, so there is nothing to select between. */
  uniform float uRim;
  uniform float uIridescence;
  uniform float uCore;
  uniform float uExposure;
  uniform float uAlpha;
  uniform vec3 uCoreColor;

  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying float vY;

  ${FRESNEL}
  ${NOISE}
  ${COLOR_UTILS}
  ${BLEND_MODES}
  ${MATCAP_VS}

  /* rainbowColor -- verbatim from JellyShader.glsl, including their comments.
   *
   * Their jelly shader DEFINES this function, and the reference photograph shows
   * why: their bell is not glass, it is a THIN FILM. Purple, blue, green and gold
   * bands sweep across it exactly like a soap bubble, because interference colour
   * depends on the angle light passes through the film at. That is a view-angle
   * function, so driving this ramp with fresnel reproduces it directly.
   *
   * In their own main() the call sits inside the FBR chunk's texture path (their
   * bell carries an iridescent tMap we do not have), so this is their function
   * used for their effect by a route we can actually run. */
  vec3 rainbowColor(float t) {
      t = mod(t, 1.0); // Wraps the t value between 0.0 and 1.0
      if (t < 0.03) return mix(vec3(0.5, 0.0, 0.5), vec3(0.5, 0.0, 1.0), t / 0.03); // violet to blue
      else if (t < 0.06) return mix(vec3(0.5, 0.0, 1.0), vec3(0.0, 0.0, 1.0), (t - 0.03) / 0.03); // blue to darker blue
      else if (t < 0.09) return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), (t - 0.06) / 0.03); // darker blue to cyan
      else if (t < 0.12) return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (t - 0.09) / 0.03); // cyan to green
      else if (t < 0.18) return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.12) / 0.06); // green to yellow
      else if (t < 0.24) return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.5, 0.0), (t - 0.18) / 0.06); // yellow to orange
      else return mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0), (t - 0.24) / 0.06); // orange to red
  }

  void main() {
    /* getFresnel normalizes both of its vector arguments internally, and
     * normalize() of a zero-length vector is NaN -- the same NaN that bloom
     * smears into a black frame. Interpolated normals CAN reach zero (two
     * opposing face normals averaged across a silhouette edge of this open
     * lathe), so both vectors are guarded before the chunk ever sees them. */
    vec3 nrm = vNormal;
    if (dot(nrm, nrm) < 1.0e-8) nrm = vec3(0.0, 0.0, 1.0);
    vec3 vdir = vViewDir;
    if (dot(vdir, vdir) < 1.0e-8) vdir = vec3(0.0, 0.0, 1.0);
    vec3 nUnit = nrm / max(1.0e-6, length(nrm));

    /* ---- SURFACE DETAIL, their tNormal.
     *
     * uil.json binds assets/images/pbr/alien_cracked_2_normal.png as tNormal on
     * every JellyShader instance -- a cracked, rippled organic membrane. Their
     * fragment unpacks it through unpackNormalFBR (an FBR-chunk function this bundle
     * does not expose) and then uses the result in exactly three places, all of
     * which are reproduced below with their own coefficients:
     *
     *     screenuv += normal.xy * 0.01 * uReflection.x;
     *     float f = pow(getFresnel(vNormal + normal * 0.02, vViewDir, 1.0), 5.0);
     *     color += f * texture2D(tVideo, vUv + normal.xy * 0.1).rgb * 0.9;
     *
     * The unpack here is the plain tangent-space decode rather than their FBR
     * version: without the chunk there is no way to reproduce its exact basis, and
     * on a lathe whose UVs run cleanly around and along the profile the plain decode
     * lands in the right place. Flagged as the one interpretation in this block.
     *
     * This is what stops the bell being a smooth CG dome -- it is the difference
     * between a membrane and a balloon, and it matters most where it perturbs the
     * MATCAP lookup, because that turns flat facets into rippled ones.
     *
     * uNormalStrength safe range 0..1 (0 disables, and is also the no-texture gate,
     * since a sampler cannot be null-tested in GLSL). uNormalScale is the tiling
     * factor; 1 stretches one crack across the whole bell, 6 reads as fine veining. */
    vec3 nmap = vec3(0.0);
    if (uNormalStrength > 0.001) {
      nmap = texture2D(tNormal, vUv * uNormalScale).rgb * 2.0 - 1.0;
    }

    /* The rim. getFresnel already takes abs() of the dot before its pow, so
     * front and back faces of the open lathe light the same edge -- which is
     * what an actual translucent bell does. The clamp before OUR pow is the
     * project rule: the base is mathematically in [0,1] but nothing derived
     * from interpolation gets near a pow un-clamped in this codebase. */
    /* pow 5.0, theirs exactly. Their line is
     *     float f = pow(getFresnel(vNormal + normal * 0.02, vViewDir, 1.0), 5.0);
     * and the exponent matters more than it looks: at our previous 3.0 the rim
     * spread halfway across the bell and the whole cap read as a lit dome. At 5.0
     * it collapses to a thin bright edge, which is what draws a GLASS silhouette. */
    /* getFresnel(vNormal + normal * 0.02, vViewDir, 1.0) -- their line, their 0.02.
     * The perturbation is deliberately tiny: it breaks the rim into a ragged edge
     * that follows the surface cracks instead of a machined outline. */
    float f = clamp(getFresnel(nrm + nmap * 0.02 * uNormalStrength, vdir, 1.0), 0.0, 1.0);
    float fres = pow(f, 5.0);
    float rim = fres * uRim;

    /* Slow mottle so the cap has some interior life. cnoise is roughly
     * [-1, 1], the factor stays in [0.88, 1.12] -- it can never go negative,
     * so no clamp is needed before the multiply. */
    float noise = cnoise(vWorldPos * 1.5 + time * 0.12);

    /* Dark desaturated sage lifting to the pale rim only at grazing angles.
     * The base sits at value 0.19 -- in the reference frames the body is
     * scarcely brighter than the background, and it is the RIM that draws
     * the silhouette, not the fill. */
    /* ---- THE MATCAP. This is the material, and the answer to reading as flat.
     *
     * uil.json binds assets/images/room/matcap-test.jpg -- a faceted crystal ball
     * with prismatic edges -- as BOTH tMap and tMatcap on their jelly. A matcap is a
     * photograph of a lit sphere indexed by surface normal, so every normal
     * direction gets its own brightness and hue and the form emerges from the
     * shading itself. That is why theirs looks three-dimensional.
     *
     * What this replaces was mix(baseColour, rimColour, fresnel): a single hue whose
     * only variation was a rim, which is a two-tone gradient no matter how the
     * geometry curves -- flat by construction. Real volume needs shading that varies
     * with normal DIRECTION, not just with grazing angle, and only a matcap (or a
     * light rig we do not have here) does that. */
    /* The normal map perturbs the MATCAP lookup, which is where it earns its keep:
     * a matcap is indexed by normal, so rippling the normal ripples the reflection
     * across the surface. This is the single term that turns a smooth glass dome
     * into a cracked organic membrane. Full uNormalStrength here, unlike the 0.02
     * their fresnel line uses -- the reflection is where the detail should read. */
    vec3 wn = normalize(vWorldNormal + nmap * uNormalStrength * 0.55);
    vec2 muv = reflectMatcap(vWorldPos, wn);
    vec3 mat = texture2D(tMatcap, muv).rgb;

    /* Green bias, keeping the crystal's structure. The matcap's LUMINANCE carries
     * the form and its chroma carries the dispersion; mixing toward luminance
     * desaturates without touching either, then uTint pushes the result into our
     * family. uMatcap retains a fraction of the original prismatic colour, because
     * a fully tinted matcap reads as coloured plastic -- the stray rainbow is a
     * large part of what says glass. */
    /* Green bias that PRESERVES the matcap's dynamic range.
     *
     * The crystal photograph is mostly near-black with bright prismatic edges, so its
     * range IS the material. An earlier pass did matcap * uBaseColor * 4.0 with a
     * #101d18 base -- multiplying a mostly-dark image by a dark colour, which crushed
     * everything below the highlights to zero and returned the flat matte green that
     * was called out. Nothing in the tone curve can recover range destroyed here.
     *
     * So: desaturate toward the matcap's own luminance, then tint with a colour whose
     * LUMINANCE is near 1 (uTint is normalised for this) so the hue moves and the
     * brightness does not. uMatcap keeps a fraction of the original chroma, because
     * the stray rainbow is most of what says glass rather than coloured plastic. */
    float mlum = dot(mat, vec3(0.2126, 0.7152, 0.0722));
    vec3 color = mix(vec3(mlum), mat, uMatcap) * uTint;

    /* Base colour is a small ADDITIVE floor now, not a multiplier -- it keeps the
     * unlit back of the bell from going fully black without touching the highlights.
     * The rim stays a highlight on top: the matcap's own limb is dark wherever the
     * silhouette faces away from its lit pole, so an explicit rim is what keeps the
     * outline continuous all the way round. */
    color += uBaseColor * 1.6 + uRimColor * rim * 0.55;
    color *= 1.0 + noise * 0.12;

    /* AT's fragment adds texture2D(tRefraction, screenuv) * uReflection.y.
     * Ours keeps the idea but gates it twice: uRefraction is 0 whenever no
     * texture was supplied (a sampler cannot be null-checked in GLSL, so the
     * guard lives in this uniform, set from JS), and the sample is weighted
     * by the rim so the scene only ever glints through the edge -- a full
     * face refraction turns the quiet silhouette into a glass hero. */
    /* FULL-SURFACE refraction, weighted by body not by rim -- theirs is
     *     color += texture2D(tRefraction, screenuv).rgb * uReflection.y;
     * with no rim term at all. Gating it by the rim (what this did before) was the
     * single biggest reason our bell read as an opaque mushroom cap: the scene only
     * showed through a hairline at the edge, so the middle stayed a dead fill. A
     * jelly is translucent across its whole dome -- you see through it -- and that
     * only happens if the interior samples the scene too. Slightly stronger at the
     * edge, because a curved shell is optically thicker there. */
    if (uRefraction > 0.001) {
      vec2 screenuv = gl_FragCoord.xy / resolution;
      /* Their line: screenuv += normal.xy * 0.01 * uReflection.x, with
       * uReflection.x = 1 from uil.json. The surface normal offset is kept too --
       * theirs comes from the FBR chain, ours from the geometry. */
      screenuv += nUnit.xy * 0.02 + nmap.xy * 0.01 * uNormalStrength;
      color += texture2D(tRefraction, screenuv).rgb * uRefraction * (0.55 + 0.45 * fres);
    }

    /* ---- THIN-FILM IRIDESCENCE. The bell's whole character.
     *
     * Their bell sweeps purple -> blue -> green -> gold across its dome. Interference
     * colour is a function of the angle light crosses the film at, so the ramp is
     * indexed by view angle (1 - f, which runs 0 at the silhouette to 1 face-on) with
     * a slow noise term so the bands drift as it bobs rather than sitting locked to
     * the geometry.
     *
     * THE INDEX MUST STAY UNDER 0.30, and this is a real trap in their function
     * rather than a taste call. Their ramp only defines hues up to t 0.30; the final
     * else-branch is mix(orange, red, (t - 0.24) / 0.06), and mix() does NOT clamp
     * its interpolant. At t 0.44 that evaluates mix(orange, red, 3.33) -- a linear
     * extrapolation well past red, into colours the ramp never contained and with
     * negative channels. A first pass here indexed up to 0.44 and the bells came out
     * flat magenta; the clamp is what keeps the sweep inside their palette.
     *
     * [0.085, 0.165] is the GREEN window of their ramp -- cyan through green to
     * yellow-green, and nothing else. Their own specimen bands violet/blue, but the
     * site's scheme is green, so the sweep is confined to the green quarter: the
     * physics of the effect (hue shifting with view angle) is theirs, the hue family
     * is ours. Keeping a real sweep inside that window is what stops it flattening
     * into one painted colour.
     *
     * uIridescence safe range 0..1.5. Above ~1.5 the bands saturate into flat colour
     * blocks and the thin-film read is lost. */
    float band = clamp(0.085 + (1.0 - f) * 0.08
                       + cnoise(vWorldPos * 0.6 + time * 0.05) * 0.015, 0.0, 0.28);
    vec3 film = rainbowColor(band);
    /* Weighted toward the silhouette: a real film is optically thickest where the
     * surface turns away, which is why their banding is strongest around the rim and
     * washes out on the crown. */
    color += film * uIridescence * (0.25 + 0.75 * fres);

    /* ---- THE GREEN CORE. The signature of the chosen reference.
     *
     * Both photographs show the bell body near-black with a hot green glow sitting
     * INSIDE it at the base -- the animal's interior organs lit up, visible through
     * the translucent shell. It is the only saturated colour on the creature, and it
     * is what makes the shape read as alive rather than as a glass ornament. It also
     * happens to be exactly this site's green, which is why this reference works
     * where the violet one needed the palette argued away.
     *
     * Concentrated where the bell meets the column, fading out both up the flanks and
     * down the body. Additive, so on the DoubleSide shell the interior wall glows
     * through the exterior -- which is the effect.
     *
     * uCore safe range 0..3. Past ~3 it blooms into a solid disc and the silhouette is
     * lost inside its own glow. */
    /* A BAND, product of two ramps, not a one-sided step. It was
     * smoothstep(0.13, -0.03, vY) -- fine when the geometry stopped at the margin,
     * but the surface now continues 1.8 units below it, and a step that saturates
     * downward would light the entire column its whole length. The band peaks over
     * y -0.22..-0.04 (margin plus throat, the junction), falls off by -0.46 a short
     * way into the column, and is dark on the crown. That is where the reference's
     * green actually sits. Both smoothsteps have edges a fixed distance apart, so
     * neither can divide by zero. */
    float coreBand = smoothstep(0.16, -0.04, vY) * smoothstep(-0.46, -0.22, vY);
    color += uCoreColor * uCore * coreBand;

    /* uTint is applied at the matcap above, not here -- tinting again after the core
     * glow would drag the core's own colour toward the shell's. */

    /* THEIR TONE CURVE, verbatim, and it is what makes the difference:
     *
     *     color = blendSoftLight(color, vec3(1.0), 1.0);
     *     color = pow(color * 1.5, vec3(1.8));
     *
     * Soft-light against pure white lifts the midtones toward glass-white, then
     * pow(x * 1.5, 1.8) crushes the darks straight back down while letting
     * anything already bright run away. The result is HIGH CONTRAST -- near-black
     * body, hot edges -- which is exactly the difference between their jellyfish
     * and the flat dark dome ours was. Without this curve no amount of rim or
     * base-colour tuning gets there; with it, the fill can stay dark and the
     * silhouette still reads as glass.
     *
     * max() before the pow is the project rule (a fractional exponent on a
     * negative base is undefined GLSL); blendSoftLight's own sqrt() needs a
     * non-negative base for the same reason. */
    color = blendSoftLight(max(color, vec3(0.0)), vec3(1.0), 1.0);
    color = pow(max(color, vec3(0.0)) * 1.5, vec3(1.8));

    /* EXPOSURE, applied after their curve rather than by editing its constants.
     *
     * Their curve reduces to about 2.06 * c^0.9 -- a strong lift, because it is fed
     * their FBR chain's output, not ours. Stacking a matcap, a tint, a base floor, a
     * rim and a core glow into it saturated every channel and the bells came out
     * glossy white, which is what read as latex. Their shape is worth keeping (the
     * sqrt lifts shadow detail, the pow holds highlights), so the fix is one gain at
     * the end instead of new constants inside it.
     *
     * uExposure safe range 0..1. 0.40 puts the body back below the particle field,
     * where both reference photographs sit -- the animal is DARKER than its
     * surroundings and drawn by its edges. */
    color *= uExposure;

    /* BACK FACES DIM. An interpretation, and the other half of why this read flat.
     *
     * The material is DoubleSide with depthWrite off, so on the column both walls of
     * the tube draw at the same brightness with nothing resolving which is nearer --
     * and their fragment leans into that, because getFresnel takes abs() of the dot,
     * so front and back light the same edge. On a bell that is right: the far wall
     * glowing through the near one IS how a translucent dome looks. On a 0.33-wide
     * tube it is a flat ribbon, because a symmetric left-right gradient with no depth
     * ordering is exactly a painted stripe.
     *
     * Halving the far wall costs nothing and restores the cue, and it is also what the
     * physics says: light reaching the camera from the far wall has crossed the body
     * twice. One constant now rather than a per-part pair. */
    if (!gl_FrontFacing) color *= 0.55;

    /* Flat alpha. The procedural version faded tentacle TIPS out with a crange over a
     * per-vertex start height, because tube geometry ends in a hard ring that has to be
     * hidden. Their model's tentacles are modelled to a point, so there is nothing to
     * hide and the fade is gone -- along with the crange, its two fade uniforms and the
     * 0/0 hazard they carried. */
    float a = uAlpha;

    /* Hard ceiling, project rule: the composer runs HalfFloat targets with
     * additive blending and UnrealBloom, and a value spike becomes Inf, and
     * one Inf pixel blacks the whole frame once the blur reaches it. This
     * material never gets near 1.5, and the clamp keeps that a fact rather
     * than a hope. */
    color = clamp(color, vec3(0.0), vec3(1.5));
    gl_FragColor = vec4(color, a);
  }
`;

/* ---- their model -------------------------------------------------------- *
 *
 * Everything that used to live here -- capProfile/bodyProfile, CAP_R, CAP_H,
 * THROAT_DROP, COL_LEN, COL_R0/R1, ROOT_RAMP, partAtY, rootRamp, TENT_SPECS and the
 * aPart packing that fed them -- is deleted. About 220 lines of hand-modelled bell,
 * throat, column, filaments and per-part blending, replaced by one file off their
 * server. The reconstruction was the mistake; there is no reason to keep any of it.
 *
 * Load path reuses parseATContainer from flower-cloud.js, which already handles their
 * wrapper (10-byte ASCII length prefix, JSON header, Draco payload) for the flower
 * cloud. Same container, same decoder, no new format code.
 */
const JELLY_URL = './assets/at/jellyfish.bin';

/* THEIR instance proportions, from JellyInstancer:
 *     mesh.scale.setScalar(Math.random(1.5, 3, 3));
 *     mesh.scale.y *= 1.5;
 * The vertical stretch is the important one. Their model is natively 0.819 x 2.052, a
 * 2.5:1 creature; stretched it is 3.75:1, which is the long-bodied silhouette their
 * frames show. Applied to the mesh so opts.scale stays the caller's own dial on top. */
const AT_Y_STRETCH = 1.5;

let _draco = null;
function dracoLoader() {
  if (_draco) return _draco;
  _draco = new DRACOLoader();
  // same vendored decoder flower-cloud.js uses
  _draco.setDecoderPath('./vendor/three/examples/jsm/libs/draco/');
  _draco.setDecoderConfig({ type: 'js' });
  return _draco;
}

/**
 * Decodes their jellyfish into a BufferGeometry.
 *
 * Their header declares position, normal and uv, and all three survive the round trip,
 * so no attribute has to be regenerated. Notably NOT calling computeVertexNormals():
 * the mesh is non-indexed, so recomputing would give flat per-face normals and destroy
 * the authored smooth shading the matcap depends on entirely.
 */
async function loadJellyModel(url = JELLY_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { meta, dracoBuffer } = parseATContainer(await res.arrayBuffer());

  /* decodeDracoFile(buffer, onLoad, attributeIDs, attributeTypes, vertexColorSpace,
   * onError) -- onError is the SIXTH argument; passing it fourth corrupts the task
   * config and the promise never settles. Learned the hard way in flower-cloud.js. */
  const geometry = await new Promise((resolve, reject) => {
    dracoLoader().decodeDracoFile(
      dracoBuffer, resolve, null, null, THREE.LinearSRGBColorSpace, reject);
  });

  if (!geometry.getAttribute('position')) {
    throw new Error(`${url}: decoded without a position attribute`);
  }
  if (!geometry.getAttribute('normal')) {
    throw new Error(`${url}: decoded without normals -- refusing to recompute them, `
      + 'a non-indexed mesh would come back faceted');
  }
  geometry.computeBoundingBox();
  return { geometry, meta };
}


export function buildJelly(shared, opts = {}) {
  const group = new THREE.Group();
  const basePos = opts.position ? new THREE.Vector3().copy(opts.position) : new THREE.Vector3();
  group.position.copy(basePos);
  group.scale.setScalar(opts.scale ?? 1);

  /* Uniform OBJECTS rather than plain values, the same way main.js shares uTime: the
   * mesh arrives asynchronously, so the material is built before its geometry exists
   * and these have to stay live references. */
  const uScroll = { value: 0 };
  const tRefraction = { value: opts.refraction ?? null };
  /* 0.55, up from 0.3, now that the term covers the whole bell rather than a rim
   * hairline. This is the uniform that carries translucency: at 0 the bell is an
   * opaque silhouette (which is also the graceful degradation when no buffer is
   * supplied -- see the GLSL guard, since a sampler cannot be null-tested).
   * Safe range 0..1; past ~0.8 the scene shows through strongly enough that the
   * bell stops reading as a body and becomes a lens. */
  /* 0.15 -- their number. uil.json gives the Home jelly uReflection = [1, 0.15], and
   * .y is the weight on their refraction sample. Earlier passes here ran 0.3 then
   * 0.55, guessing; theirs is much subtler because the MATCAP is doing the heavy
   * lifting and the refraction only has to add a little scene bleed-through.
   * Safe range 0..1; past ~0.5 the bell becomes a lens and loses its body. */
  const uRefraction = { value: opts.refraction ? (opts.refractAmount ?? 0.15) : 0 };
  /* Fraction of the crystal matcap's own prismatic chroma retained after the green
   * bias. 0 = fully desaturated to our tint, 1 = their untouched rainbow.
   * 0.35 keeps enough dispersion to read as glass while staying in our scheme. */
  const uMatcap = { value: opts.matcapChroma ?? 0.35 };
  const tMatcap = { value: opts.matcap ?? null };
  const tNormal = { value: opts.normalMap ?? null };
  /* 0.85, up from 0.45. At 0.45 the crystal matcap still resolved as one smooth
   * glossy sweep across the bell -- and a smooth uniform gloss is precisely what
   * reads as latex. The cracked membrane has to be strong enough to break the
   * reflection into patches before the surface stops looking manufactured. */
  const uNormalStrength = { value: opts.normalMap ? (opts.normalStrength ?? 0.85) : 0 };
  /* Tiling for the cracked-membrane normal map. Their model carries authored UVs
   * spanning very close to the full 0..1 range on both axes, so this is a real tiling
   * factor over the whole creature: ~9 reads as fine veining rather than one fissure. */
  const uNormalScale = { value: opts.normalScale ?? 9.0 };
  /* Luminance-normalised green. This multiplies the matcap, so its BRIGHTNESS has to
   * stay near 1 or it dims the material instead of colouring it -- #9fe6c4 sits at
   * about 0.84 relative luminance, so the hue shifts into our family and the crystal
   * keeps its range. A saturated green here (0.3 luminance) would undo the whole
   * point of the previous block. */
  const uTint = { value: new THREE.Color(opts.tint ?? '#9fe6c4') };

  /* ONE material for the whole animal, and now genuinely one value per dial rather
   * than a bell/tentacle pair -- their model is a single authored mesh. Documented
   * ranges, since these are the dials worth turning:
   *
   *   uRim         0..1.2  fresnel highlight strength
   *   uIridescence 0..1.5  thin-film band gain; above ~1.5 it flattens to flat colour
   *   uCore        0..3    the green interior glow; above ~3 it swallows the outline
   *   uExposure    0..1    final gain after their tone curve
   *   uAlpha       0..1    stay under ~0.7 or the far wall stops showing through
   */
  const makeMaterial = () =>
    new THREE.ShaderMaterial({
      vertexShader: JELLY_VS,
      fragmentShader: JELLY_FS,
      uniforms: {
        time: shared.uTime,
        resolution: shared.uResolution,
        uScroll,
        tRefraction,
        uRefraction,
        tMatcap,
        uMatcap,
        tNormal,
        uNormalStrength,
        uNormalScale,
        uTint,
        uRim: { value: 1.0 },
        uIridescence: { value: opts.iridescence ?? 0.08 },
        uCore: { value: opts.core ?? 0.45 },
        uExposure: { value: opts.exposure ?? 0.40 },
        uAlpha: { value: opts.alpha ?? 0.55 },
        uCoreColor: { value: new THREE.Color(opts.coreColor ?? '#4dff9e') },
        /* Near-black with a green cast. Both reference photographs show the SHELL as
         * a dark translucent body -- the colour comes from the core glow and the
         * refracted scene behind it, not from the fill. */
        uBaseColor: { value: new THREE.Color(opts.baseColor ?? '#101d18') },
        /* Near-white with the faintest mint. Their rim is a specular highlight, not a
         * coloured edge -- a saturated rim colour reads as plastic. */
        uRimColor: { value: new THREE.Color(opts.rimColor ?? '#dff5ea') },
      },
      /* NORMAL blending, deliberately, in an additive scene: a dark silhouette can
       * only exist if it can occlude what is behind it, and additive blending can only
       * brighten. depthWrite stays off with the rest of the translucent stack, so the
       * far wall ghosting through the near one reads as body density. DoubleSide
       * because their bell is an open shell whose underside comes into frame as the
       * creature bobs. */
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

  /* ---- THEIR MESH -------------------------------------------------------
   *
   * One mesh, one material, loaded rather than assembled. What this replaces was a
   * lathe plus five tapered cylinders merged with mergeGeometries, each carrying a
   * hand-computed aPart vec4 so the fragment could blend between the invented pieces.
   * None of that is needed for an authored model, so none of it survives -- including
   * the mergeGeometries import.
   *
   * The load is ASYNCHRONOUS and buildJelly stays synchronous, because main.js builds
   * the scene graph in one pass and every caller expects a group back immediately. So
   * the group is returned empty and the mesh is added when the decode resolves, a few
   * hundred ms into the session. `ready` is exposed for anything that needs to wait.
   *
   * There is deliberately NO procedural fallback. The other AT assets have one because
   * a missing texture should thin the render rather than break it, but every procedural
   * jellyfish this project has produced was worse than no jellyfish -- so a failure
   * here logs and leaves the creature out.
   */
  const bodyMat = makeMaterial();
  let body = null;
  let modelStats = null;

  const ready = loadJellyModel(opts.url ?? JELLY_URL).then(({ geometry, meta }) => {
    body = new THREE.Mesh(geometry, bodyMat);

    /* Their scale.y *= 1.5. On the mesh rather than the group so opts.scale remains a
     * clean uniform multiplier the caller controls. */
    body.scale.y = AT_Y_STRETCH;

    /* The vertex shader displaces up to ~1.6 units laterally (their broad sway alone is
     * amplitude 1.0 on each of x and z), well outside the model's own bounds; same call
     * home.js makes for the same reason. */
    body.frustumCulled = false;
    group.add(body);

    const bb = geometry.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    modelStats = {
      source: meta?.name ?? 'unknown',
      verts: geometry.attributes.position.count,
      tris: geometry.attributes.position.count / 3,
      indexed: !!geometry.index,
      nativeSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
      yStretch: AT_Y_STRETCH,
      stretchedHeight: +(size.y * AT_Y_STRETCH).toFixed(3),
      /* their frames read as a long-bodied creature; this is the number that makes it so */
      stretchedRatio: +((size.y * AT_Y_STRETCH) / size.x).toFixed(2),
    };
    return modelStats;
  }).catch(err => {
    console.warn('[jelly] their model failed to load; no jellyfish this session.\n'
      + '        run `npm run fetch:assets` to pull assets/at/jellyfish.bin\n'
      + '       ', err);
    return null;
  });

  /* ---- drift ------------------------------------------------------------- *
   * The shader already carries AT's sway; this layer adds the slow wander of
   * the whole animal through the frame, which their scene drives from its
   * scroll camera and ours gets from update(dt). Accumulated internal phase,
   * on purpose: driving this from wall-clock time would teleport the jelly
   * after a background tab pause, where an accumulated phase (dt already
   * clamped by the caller) just resumes. The three frequencies share no
   * common period, so the path never visibly loops. */
  let phase = 0;

  return {
    group,
    ready,
    get body() { return body; },
    uniforms: bodyMat.uniforms,

    update(dt) {
      phase += dt;
      group.position.set(
        basePos.x + Math.sin(phase * 0.11) * 0.45,
        basePos.y + Math.sin(phase * 0.07 + 1.3) * 0.6,
        basePos.z + Math.cos(phase * 0.05) * 0.3
      );
      // a slight heel as it drifts, so the bob reads as swimming, not hovering
      group.rotation.z = Math.sin(phase * 0.06) * 0.07;
    },

    /* Populated when the decode lands; null before that and if it failed. Reads back
     * what the MODEL actually is rather than what this file asserts about it -- the
     * previous stats block reported the dimensions of a reconstruction. */
    get stats() { return modelStats; },
  };
}

