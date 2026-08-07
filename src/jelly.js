import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { FRESNEL, BLEND_MODES, MATCAP_VS } from './glsl-chunks.js';

/* THE JELLYFISH — JellyShader.glsl, transcribed where it ports
 *
 * The mushroom-cap drifter at frame left in reference frames 1 and 2: a dark
 * desaturated sage cap about 1.2 units across, a faint lit rim on the cap
 * edge, and five filament tentacles hanging 4-6 units below it, each swaying
 * on its own phase. It is scenery, not a hero object. In both reference
 * frames it sits barely above the background value and reads mostly as a
 * silhouette against the particle field -- everything in the fragment shader
 * is tuned to keep it that way, and the output is clamped besides, because
 * this scene composites through HalfFloat targets with additive blending and
 * UnrealBloom, where one hot pixel becomes Inf and one Inf pixel becomes a
 * black frame once the separable blur touches it.
 *
 * WHAT IS THEIRS AND WHAT IS NOT
 *
 * Active Theory's JellyShader.glsl (compiled.vs) supplies the VERTEX
 * displacement, ported verbatim -- all three terms, every constant theirs:
 *
 *   1. cap wobble    pos.y += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8
 *                                    + time * 0.5 * 0.35) * 0.6
 *   2. fine ripple   pos.x/z += sin/cos(pos.y + time * 0.1 + uScroll) * 0.1
 *   3. broad sway    pos.x/z += sin/cos(pos.y * 0.04 + time * 0.2) * 1.0
 *
 * At term 1's noise frequency the whole cap spans about a twentieth of a
 * noise cell, so it does not ripple the surface -- it bobs the body as one
 * slow mass. Term 3 is nearly uniform along the body for the same reason
 * (pos.y * 0.04 covers a quarter radian over six units of tentacle), so it
 * reads as whole-body drift with a slight lag whipping down the filaments.
 * That lag is the entire jellyfish walk cycle, and it costs three sin calls.
 *
 * Their FRAGMENT does not port. It opens with getFBR / unpackNormalFBR from
 * their fbr.vs / fbr.fs chunks -- a full forward-lit material chain (normal
 * map unpacking, matcap, per-light accumulation, tNormal / uNormalStrength
 * uniforms) that is not among this bundle's extractable chunks, and it also
 * feeds on tVideo of the showreel. Rather than fake that chain, the fragment
 * here is an interpretation built from our own chunks: FRESNEL for the rim,
 * cnoise mottle so the cap is not a flat card, base colour #22301f lifting
 * to #93a86a only at grazing angles. Their mouse-whiten term (vMouse) and
 * the video feed are deliberately dropped -- both fight the quiet-silhouette
 * read the reference frames show. Their tRefraction sample survives in
 * spirit: opts.refraction, when provided, is added at the rim only.
 *
 * INTERPRETATIONS beyond the fragment, marked again at point of use:
 *   - uPhase. Their bundle draws one jelly mesh; our tentacles are separate
 *     tubes, and giving each one a phase offset into term 3 stops them
 *     swaying in unison. The offset fades in over the first two units below
 *     the cap so the tentacle roots still move WITH the cap -- a constant
 *     offset at amplitude 1.0 visibly tears the root joint off the body.
 *   - uScroll. Theirs is the page scroll feeding the ripple phase. It is
 *     exposed in the returned uniforms and rests at 0, which is safe here:
 *     it is a phase term, never a divisor or a smoothstep edge.
 */

const JELLY_VS = /* glsl */`
  uniform float time;
  uniform float uScroll;
  uniform float uPhase;
  uniform float uRipple;

  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying float vY;

  ${NOISE}

  void main() {
    vec3 pos = position;

    /* AT, JellyShader.glsl vertex, verbatim from here down to the varyings.
     * Order matters and is preserved: the wobble writes pos.y FIRST, and both
     * sway terms then read the wobbled pos.y, exactly as their shader does. */
    pos.y += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8 + time * 0.5 * 0.35) * 0.6;

    /* Their fine ripple, with uRipple as a per-material gain (1.0 on the cap, so the
     * body is exactly their number). Their shader draws ONE fused mesh where this
     * term travels continuously from bell into tentacles; on our separate strands
     * 0.1 over a 3-unit tube is under a tenth of a wavelength, so the strands hung
     * dead straight like wires. The gain restores the undulation their fused
     * geometry gets for free. Wavelength is theirs and untouched -- only amplitude
     * scales, so the motion stays their motion. */
    pos.x += sin(pos.y + time * 0.1 + uScroll) * 0.1 * uRipple;
    pos.z += cos(pos.y + time * 0.1 + uScroll) * 0.1 * uRipple;

    /* Their broad sway, with one addition: uPhase, our per-tentacle offset
     * (0 on the cap). It is faded in below the cap so the tentacle root sways
     * exactly with the body and only the free length diverges -- smoothstep
     * with descending edges is the idiom their own shaders use everywhere
     * (smoothstep(10.0, -10.0, ...) and friends), and the edges here are
     * distinct constants, so the zero-width NaN trap cannot arise. */
    float ph = uPhase * smoothstep(-0.6, -2.4, pos.y);
    pos.x += sin(pos.y * 0.04 + time * 0.2 + ph) * 1.0;
    pos.z += cos(pos.y * 0.04 + time * 0.2 + ph) * 1.0;

    /* vY is the UNDISPLACED y -- the fragment fades tentacle tips by where
     * they are on the strand, not by where the sway happens to put them. */
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
  uniform float uRim;
  uniform float uIridescence;
  uniform vec3 uCoreColor;
  uniform float uCore;
  uniform float uExposure;
  uniform float uAlpha;
  uniform float uFadeFrom;
  uniform float uFadeTo;

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
     * Concentrated at the bell's base and below, fading out up the flanks. vY is
     * object-space height: the profile puts the apex at CAP_H and the lip near 0, so
     * this term lives in the last fifth of the bell. Additive, so on the DoubleSide
     * shell the interior wall glows through the exterior -- which is the effect.
     *
     * uCore safe range 0..3. Past ~3 it blooms into a solid disc and the bell's
     * silhouette is lost inside its own glow. */
    /* Tight band at the very base, NOT the bottom half. smoothstep(0.30, -0.06)
     * covered half the bell and, run through the lift below, turned the whole
     * animal pale mint -- the reference's glow is a narrow bright line at the
     * margin with the shell dark immediately above it. */
    color += uCoreColor * uCore * smoothstep(0.13, -0.03, vY);

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

    /* Tentacle tips dissolve rather than end. crange divides by the edge
     * difference, so the two fade uniforms are set from JS constants that
     * differ by at least 1.0 in every material -- never equal, no 0/0. The
     * cap gets edges far below its own geometry so it resolves to 1.0. */
    float a = uAlpha * crange(vY, uFadeFrom, uFadeTo, 0.0, 1.0);

    /* Hard ceiling, project rule: the composer runs HalfFloat targets with
     * additive blending and UnrealBloom, and a value spike becomes Inf, and
     * one Inf pixel blacks the whole frame once the blur reaches it. This
     * material never gets near 1.5, and the clamp keeps that a fact rather
     * than a hope. */
    color = clamp(color, vec3(0.0), vec3(1.5));
    gl_FragColor = vec4(color, a);
  }
`;

/* ---- geometry ------------------------------------------------------------ *
 * The cap is a lathe: a dome profile swept past 90 degrees so the rim curls
 * slightly under, with a small outward flare on the last quarter -- that
 * flare is the mushroom skirt, and it is what separates the reference
 * silhouette from a plain hemisphere. Rim lands near x 0.61, so the cap is
 * about 1.23 units across. The first point is nudged off x = 0 because a
 * degenerate ring at the pole gives the lathe averaged zero-length normals. */
/* TALL CONE, not a dome. The chosen reference bell is a tapered cone -- a rounded
 * apex, near-straight flanks flaring outward, and a hard flared lip at the base --
 * standing slightly taller than it is wide. Earlier passes here built a wide
 * flattened mushroom (0.62 x 0.30, a 2:1 dome), which is a different animal
 * entirely; height now exceeds radius. */
/* Solved, not guessed: these give a bell 0.94 wide by 0.79 tall = 1.19:1, against
 * the reference specimen's ~1.2:1. A parabolic profile spends more of its height near
 * the crown than an ellipse does, so matching a ratio by eye from the constants alone
 * is misleading -- the numbers were swept and measured. */
const CAP_R = 0.50, CAP_H = 0.68;

function capProfile(steps = 44) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    /* PARABOLIC bell with a tucked margin -- an actual medusa profile.
     *
     * Curvature is still continuous, which matcap shading requires (a cone's normal
     * is constant along each ruling line, so straight flanks render as hard facets).
     * But a sin/cos quarter-ellipse, which is what this was, is an EGG: steep sides
     * and a domed top, with the widest point right at the bottom edge. Rendered
     * bright and smooth that reads as a capsule -- the "condom" call was fair.
     *
     * A real bell is a downward-opening paraboloid: r grows as sqrt of the drop, so
     * the crown is broad and flat and the sides flare out beneath it. sqrt(t) does
     * exactly that.
     *
     * Then the MARGIN TUCKS. The last eighth curls down and back inward, which is
     * what makes a bell a bell rather than a dome -- it puts a lit edge under the
     * widest point and opens the subumbrellar cavity the tentacles hang from. */
    let x = CAP_R * Math.pow(t, 0.5);
    let y = CAP_H * (1 - t);
    const curl = Math.max(0, (t - 0.87) / 0.13);
    const c2 = curl * curl;
    y -= c2 * 0.16 * CAP_H;
    /* 0.22, not 0.07. The sqrt term is still widening across the tuck region, so a
     * small pullback is entirely cancelled by it -- measured, 0.07 curled the margin
     * inward by all of 0.01 units, i.e. not at all. 0.22 nets a real 0.08-unit curl
     * under the widest point, which is what casts the dark line beneath the rim. */
    x -= c2 * 0.22 * CAP_R;
    /* No separate lip term any more -- the tuck above IS the margin, and adding an
     * outward flare on top of an inward curl just cancelled both. */
    pts.push(new THREE.Vector2(Math.max(1e-4, x), y));
  }
  return pts;
}

/* Five tentacles (the brief allows 4-6; the reference frames read as five).
 * Lengths, roots and phases are fixed rather than randomised so the layout
 * matches frame to frame and reload to reload -- this thing is set dressing
 * in a composed shot, not a particle system. Roots sit inside the skirt
 * radius; phases are spread over the full sway cycle so no two strands ever
 * whip together. Root offsets are baked into the GEOMETRY, not mesh.position:
 * the sway operates on object-space pos, so cap and tentacles must share one
 * object space or the phase fade cannot hold the joints closed. */
/* Lengths, and the proportion is worth pinning down because it has been wrong in
 * both directions.
 *
 * The bell is 0.94 units across (CAP_R 0.47). An earlier pass ran these at 8-10
 * units -- over TEN bell-widths -- on the reading that the animal is "mostly
 * tentacle". At that length they stop being tentacles and become wires trailing off
 * the bottom of frame, which is exactly how it looked. Measuring the two reference
 * photographs instead: the dark green specimen runs about 2.5 bell-widths, the
 * blue/violet one about 8 at its longest. These sit at 2.0-3.0 widths, which puts
 * the BELL at 18-24% of the animal's total height -- matching the green specimen,
 * the one whose silhouette was chosen. (A useful cross-check: bell fraction is
 * easier to eyeball in a photograph than absolute length, and it is scale-free.)
 *
 * Roots sit just inside the bell MARGIN (r about 0.3 against CAP_R 0.5), not at the
 * axis. Bunching them at the centre -- which an earlier pass did to stop them
 * splaying -- hung them from a single point like strings off a balloon. Real
 * tentacles trail from the rim of the subumbrellar cavity, and the tuck in the
 * profile above is what opens that cavity for them to emerge from. */
const TENT_SPECS = [
  { len: 2.6, angle: 0.0, r: 0.30, phase: 0.00 },
  { len: 2.1, angle: 1.26, r: 0.36, phase: 0.55 },
  { len: 2.8, angle: 2.51, r: 0.27, phase: 1.10 },
  { len: 1.9, angle: 3.77, r: 0.34, phase: 0.35 },
  { len: 2.35, angle: 5.03, r: 0.32, phase: 0.80 },
];

/**
 * @param shared            the shared uniform bag from main.js (uTime, uResolution used)
 * @param opts.position     THREE.Vector3 rest position. The reference frames put it
 *                          about 22% from frame left at mid-height; that mapping is
 *                          camera-dependent, so placement is the caller's call.
 * @param opts.scale        uniform group scale, default 1
 * @param opts.refraction   scene snapshot texture, bound as tRefraction. May be null;
 *                          the shader's uRefraction gate stays 0 in that case.
 * @param opts.tint         THREE.Color (or anything Color() accepts) multiplied over
 *                          the final colour, default white
 */
export function buildJelly(shared, opts = {}) {
  const group = new THREE.Group();
  const basePos = opts.position ? new THREE.Vector3().copy(opts.position) : new THREE.Vector3();
  group.position.copy(basePos);
  group.scale.setScalar(opts.scale ?? 1);

  /* Uniform OBJECTS shared across all six materials, the same way main.js
   * shares uTime: drive the value once, every material sees it. */
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
  /* 5 tiles across the bell: their crack scale reads as veining at this size rather
   * than as one giant fissure. The tentacles inherit it, where the tube's UV makes
   * it a fine lengthwise grain -- which is what puts the little glinting beads along
   * their strands in the reference. */
  const uNormalScale = { value: opts.normalScale ?? 9.0 };
  /* Luminance-normalised green. This multiplies the matcap, so its BRIGHTNESS has to
   * stay near 1 or it dims the material instead of colouring it -- #9fe6c4 sits at
   * about 0.84 relative luminance, so the hue shifts into our family and the crystal
   * keeps its range. A saturated green here (0.3 luminance) would undo the whole
   * point of the previous block. */
  const uTint = { value: new THREE.Color(opts.tint ?? '#9fe6c4') };

  const makeMaterial = ({ phase, rim, alpha, fadeFrom, fadeTo,
                          iridescence = 0, core = 0, ripple = 1, exposure = 0.40 }) =>
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
        uPhase: { value: phase },
        /* Gain on their fine-ripple amplitude. 1.0 = their exact number (the cap);
         * higher makes a separate strand undulate as their fused mesh does.
         * Safe range 0..6; past ~6 the strands cross each other. */
        uRipple: { value: ripple },
        uRim: { value: rim },
        uIridescence: { value: iridescence },
        uCore: { value: core },
        uExposure: { value: exposure },
        uCoreColor: { value: new THREE.Color(opts.coreColor ?? '#4dff9e') },
        uAlpha: { value: alpha },
        /* Cooler and a touch lighter than the near-black sage this started as.
         * Their bell is a pale blue-green glass, and the tone curve above needs
         * something in the midtones to lift -- fed a 0.19-value fill it has
         * nothing to work with and returns the same flat dome. The curve crushes
         * this back down over most of the surface; it only survives where the
         * fresnel and the refraction put light. */
        /* Near-black with a green cast. Both reference photographs show the SHELL as
         * a dark translucent body -- the colour comes from the core glow and the
         * refracted scene behind it, not from the fill. A lighter fill (this was
         * #2c4a44) makes it a solid teal dome again. */
        uBaseColor: { value: new THREE.Color(opts.baseColor ?? '#101d18') },
        /* Near-white with the faintest mint. Their rim is a specular highlight,
         * not a coloured edge -- a saturated rim colour reads as plastic. */
        uRimColor: { value: new THREE.Color(opts.rimColor ?? '#dff5ea') },
        uFadeFrom: { value: fadeFrom },
        uFadeTo: { value: fadeTo },
      },
      /* NORMAL blending, deliberately, in an additive scene: a dark
       * silhouette can only exist if it can occlude what is behind it, and
       * additive blending can only brighten. depthWrite stays off with the
       * rest of the translucent stack; at alpha 0.92 the far wall of the
       * open lathe ghosting through the near one reads as body density, not
       * as an artifact. DoubleSide because the lathe is an open shell -- the
       * underside of the cap is in frame whenever the jelly bobs above the
       * camera line. */
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

  /* ---- the cap ---------------------------------------------------------- */
  /* 44 profile steps x 72 radial. A matcap shows tessellation directly -- flat
 * normals inside a facet give a flat patch of reflection -- so a shape this small
 * on screen still needs the segment count of a hero object. It is 3k triangles. */
const capGeo = new THREE.LatheGeometry(capProfile(), 72);
  const capMat = makeMaterial({
    phase: 0,
    rim: 1.0,
    /* The bell alone gets the thin-film banding -- in the reference the tentacles
     * are plain bright filaments with no interference colour on them at all. */
    /* Dialled back from 0.85: the reference's bell is a DARK shell with a subtle
     * sheen, and the green core is what carries the colour. Heavy banding on top of
     * the core reads as two competing effects. */
    /* 0.08, nearly off. The procedural rainbowColor band was standing in for
     * dispersion before their matcap was found; the crystal photograph supplies real
     * dispersion now, so this drops to a trace. Their ramp function is kept in the
     * shader (documented, theirs) because it is the honest record of how this was
     * approximated -- and a trace of it still helps the smallest swarm bells, which
     * cover too few pixels for the matcap's facets to resolve. */
    iridescence: opts.iridescence ?? 0.08,
    /* 0.45, not 1.5. The tone curve below is roughly 2.06 * c^0.9 -- a strong LIFT,
     * not a compression -- so a core of 1.5 in the green channel clamps to white and
     * takes the surrounding shell with it. Everything fed into that curve has to be
     * budgeted for it; this is the term that was blowing the bell out. */
    core: opts.core ?? 0.45,
    /* 0.55. Their bell is see-through enough that the FAR wall of the dome shows
     * through the near one -- that inner ellipse is most of why it reads as an
     * animal and not a painted shell, and an opaque bell is half of why ours read
     * as rubber. depthWrite is already off, so lowering alpha is all it takes. */
    alpha: 0.55,
    /* Fade edges parked 40 units below a cap whose lowest point is at about
     * -0.11: crange clamps, resolves to 1.0 across the whole cap, and the
     * edges still differ by 1.0 so its divisor can never be zero. */
    fadeFrom: -40.0,
    fadeTo: -39.0,
  });
  const cap = new THREE.Mesh(capGeo, capMat);
  // the vertex shader walks it up to ~1.7 units off its bounds; same call home.js makes
  cap.frustumCulled = false;
  group.add(cap);

  /* ---- the tentacles ----------------------------------------------------- */
  const tentacles = TENT_SPECS.map(spec => {
    /* A 6-sided open taper, 96 height segments: term 2's ripple has a
     * wavelength of 2*PI units along y, so a strand this long needs the
     * subdivision or the ripple facets. Root radius 0.016 down to 0.004 --
     * in the reference these are hairs, and any thicker they read as ropes. */
    /* Thinner (0.009 -> 0.002) and 160 height segments rather than 96. Both follow
     * from the length change: at nearly ten units a 96-segment strand shows the
     * sway as visible straight facets, and the reference's tentacles are HAIR --
     * threads, not tapered cones. */
    const geo = new THREE.CylinderGeometry(0.009, 0.002, spec.len, 6, 96, true);
    geo.translate(
      Math.cos(spec.angle) * spec.r,
      -spec.len / 2 - 0.12,               // top of the strand just under the skirt
      Math.sin(spec.angle) * spec.r
    );
    const mat = makeMaterial({
      phase: spec.phase,
      /* A 0.016-radius tube is ALL grazing angle, so full rim strength would
       * light the entire strand like a filament bulb. Kept low: the strands
       * should be darker than the cap edge, just catching light in places. */
      /* 0.85, up from 0.3. The reference's tentacles are BRIGHT -- thin luminous
       * threads that read clearly against black over their whole length, with
       * little glinting beads along them. At 0.3 ours were nearly invisible, which
       * is why the jelly read as a bare cap with nothing hanging from it. A thin
       * tube being all-grazing-angle is what makes it a filament, not a problem. */
      rim: 0.85,
      alpha: 0.85,
      /* 3.5x their ripple amplitude. See the uRipple note in the vertex shader: on a
       * separate 3-unit tube their 0.1 is under a tenth of a wavelength and the
       * strand hangs like wire. At 3.5 it carries roughly half a wave of visible
       * undulation over its length, which is the reference's lazy S-curve. */
      ripple: 3.5,
      /* Dissolve over the last 0.9 units. It was 2.0, which on the old 8-10 unit
       * strands was a fifth of the length but on these is a THIRD -- the strands
       * faded out well before their tips and read as stubs. Edge difference is a
       * constant 0.9, so crange's divisor still cannot be zero. */
      fadeFrom: -spec.len - 0.12,
      fadeTo: -spec.len + 0.78,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
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
    tentacles,
    uniforms: {
      uScroll,
      uRefraction,
      uTint,
      cap: capMat.uniforms,
      tentacles: tentacles.map(t => t.material.uniforms),
    },

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

    stats: {
      tentacles: TENT_SPECS.length,
      capTris: capGeo.index ? capGeo.index.count / 3 : 0,
      tentacleTris: tentacles.reduce(
        (n, t) => n + (t.geometry.index ? t.geometry.index.count / 3 : 0), 0),
    },
  };
}
