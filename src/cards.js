import * as THREE from 'three';
import {
  TRANSFORM_UV, RANGE, RGB_SHIFT, FRESNEL, RADIAL_BLUR,
  REFL_VS, REFL_FS, BLEND_MODES, RGB2HSV,
} from './glsl-chunks.js';
import { makeThumbTexture } from './textures.js';
import { spinePath, SPINE_TOP } from './world.js';

/* World scale is chosen so the original's authored constants behave as written:
 *   WorkItemUIShader  -> crange(uCamDistance, 5.0, 6.0, 1.0, 0.0)   label fades 5..6 units out
 *   WorkItemShader    -> smoothstep(3.0, 1.0, abs(worldY - camY))   video shows within 1..3 units
 * so cards are a few units across and the camera sits ~4 units away. */
/* Panel size, measured off the live site rather than guessed: at the same
 * framing the reference card projects to roughly 860x590 of a 2000px-wide
 * frame, an aspect of ~1.46. The earlier 2.60/1.55 (1.68) rendered visibly
 * more letterboxed than the original. Width is unchanged; height comes up to
 * put the panel back on the reference aspect. */
export const CARD_W = 2.60;
export const CARD_H = 1.75;
export const CARD_D = 0.06;
/* Layout is a direct port of WorkItems.positionViews() from app.js:
 *
 *   let angle = 0, total = Math.min(7, views.length);
 *   let step  = mobile ? Math.radians(35) : Math.radians(50);
 *   let y = mobile ? 4 : 0, yStep = mobile ? 0.16*total : 0.12*total;
 *   views.forEach((view, i) => {
 *     view.group.position.x = 3.8 * Math.cos(angle);
 *     view.group.position.z = 3.8 * Math.sin(angle);
 *     view.group.position.y = 0;
 *     let pos = view.group.position.clone();
 *     pos.multiplyScalar(2);
 *     view.group.lookAt(pos);          // card faces OUTWARD from the axis
 *     angle -= step;
 *     view.group.position.y = y - yStep * i;
 *     pos.y = y - yStep * i;
 *     target.position.copy(pos);       // camera sits at 2x the card radius
 *     target.quaternion.copy(view.group.quaternion);   // and shares its rotation
 *     tween(view.group.scale, {x:1,y:1,z:1}, 1200, 'easeOutQuint', 200*i + 200);
 *   });
 *
 * lookAt() aims the card's +Z outward; the camera copies that quaternion, so its
 * -Z forward points back inward — through the card, at the spine behind it.
 * That is why every card is nearest at its spine-facing edge.
 */
export const CARD_ORBIT = 3.8;                   // view.group.position radius
export const CAM_ORBIT = CARD_ORBIT * 2;         // pos.multiplyScalar(2)
export const ANGLE_STEP = THREE.MathUtils.degToRad(50);
export const ANGLE_STEP_MOBILE = THREE.MathUtils.degToRad(35);

/* Label plane is wider than the panel because the shader's
 * scaleUV(vUv, vec2(0.42, 1.0)) then scaleUV(uv, vec2(1.15)) compresses the
 * texture into ~48% of the plane. Rendered title width works out at
 *   LABEL_W * 0.483 * (700/1024) = LABEL_W * 0.330
 * which is sized here to land at ~65% of the card width. */
const LABEL_W = 3.22;
const LABEL_H = 1.79;

// Card silhouette: all four corners equally rounded, generous radius.
// (The chamfered corner belongs to the WorkDetail panel, not the spine cards.)
const CORNER_R = 0.26;
const RT = 1024;       // the original renders card labels into a 1024x1024 target

/* ------------------------------------------------------------------ *
 *  Label texture — reproduces the original's WorkPaneUI layout
 * ------------------------------------------------------------------ */
const FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace';

// Math.range(v, inMin, inMax, outMin, outMax, clamp) — Hydra's remap helper
function range(v, a, b, c, d, clamp = false) {
  let t = (v - a) / (b - a);
  if (clamp) t = Math.min(1, Math.max(0, t));
  return c + t * (d - c);
}

function trackedText(ctx, text, cx, y, tracking) {
  const chars = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce((s, w) => s + w, 0) + tracking * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x + widths[i] / 2, y);
    x += widths[i] + tracking;
  }
}

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function labelTexture(project) {
  const c = document.createElement('canvas');
  c.width = c.height = RT;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, RT, RT);          // opaque: the label plane blends additively
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // titleSize = 0.9 * range(len, 5, 20, 130, 100, clamp)
  const titleSize = 0.9 * range(project.title.length, 5, 20, 130, 100, true);
  const clientSize = 24;

  ctx.font = `400 ${titleSize}px ${FONT}`;
  const lines = wrapLines(ctx, project.title.toUpperCase(), 700);   // wrap width 700
  const titleLeading = titleSize * 1.1;                             // lineHeight 1.1
  const titleH = lines.length * titleLeading;
  const clientH = clientSize * 1.8;                                 // lineHeight 1.8

  // y = 470 - 0.5*titleH - 0.5*copyH - 0.5*clientH   (copy alpha is 0 on the card)
  let y = 470 - 0.5 * titleH - 0.5 * clientH;

  ctx.font = `700 ${clientSize}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  trackedText(ctx, project.client.replace(/,/g, ' /').toUpperCase(), RT / 2, y, clientSize * 0.1);

  y += clientH + 20;
  const titleTop = y + 20;

  ctx.font = `400 ${titleSize}px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  lines.forEach((ln, i) =>
    trackedText(ctx, ln, RT / 2, titleTop + i * titleLeading + titleLeading * 0.5, titleSize * 0.01));

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  WorkItemShader — the glass panel. Ported from compiled.vs.
 * ------------------------------------------------------------------ */
function panelMaterial(project, shared, deps) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: shared.uTime,
      resolution: shared.uResolution,
      tMap: { value: deps.thumb },
      tVideo: { value: deps.video },
      tRefraction: { value: deps.refraction },
      tEnv: { value: deps.env },
      tNormal: { value: deps.normal },
      uFresnelPow: { value: 1.0 },        // UIL: WorkItemShader/.../uFresnelPow = 1
      uDistortStrength: { value: 0.0 },   // UIL: uDistortStrength = 0
      uRefractionRatio: { value: 1.0 },   // UIL: uRefractionRatio = 1
      uColor: { value: new THREE.Color(project.color) },
      uHover: { value: 0 },
      uMouse: shared.uMouse,
      uVideoBlend: { value: 0 },
      uScale: { value: new THREE.Vector2(1, 1) },
      uPhone: { value: 0 },
      uCardSize: { value: new THREE.Vector2(CARD_W, CARD_H) },
      uCorner: { value: CORNER_R },
      uFocus: { value: 0 },
      uCull: { value: 0 },   // smooth window falloff, kills far-card ghosting
      // cursor position in this card's own UV space, eased — drives the liquid
      uPointer: { value: new THREE.Vector2(0.5, 0.5) },
      uPointerPrev: { value: new THREE.Vector2(0.5, 0.5) },
    },
    vertexShader: /* glsl */`
      uniform float uHover;
      uniform vec2 uMouse;
      uniform float uPhone;
      uniform float uRefractionRatio;
      varying vec2 vUv;
      varying float vBackface;
      varying float vSide;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vReflection;
      varying vec3 vRefraction;
      varying vec3 vPos;
      varying float vDist;
      uniform float time;
      ${REFL_VS}
      void main() {
        vec3 pos = position;

        pos.z += sin(time * 0.5 + abs(0.5 - pos.x) * 3.0) * 0.1 + uHover * 0.2;
        pos.y -= pos.x * mix(0.08, 0.14, uPhone);
        pos.x -= vec2(uMouse - 0.5).x * 0.03;

        vec4 worldPos = modelMatrix * vec4(pos, 1.0);

        vUv = uv;
        vUv.y += pos.x * mix(0.08, 0.2, uPhone) * 0.2;
        vReflection = reflection(worldPos);
        vRefraction = refraction(worldPos, uRefractionRatio);

        vPos = pos;
        vWorldPos = worldPos.xyz;
        vNormal = normalMatrix * normal;
        vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0));
        vDist = vWorldPos.x - cameraPosition.x;

        if (normal.z < 0.0) { vUv.x = 1.0 - vUv.x; vBackface = 1.0; }
        vSide = abs(normal.x);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tMap, tVideo, tRefraction, tEnv, tNormal;
      uniform float uFresnelPow, uDistortStrength, uRefractionRatio;
      uniform vec3 uColor;
      uniform float uHover, uVideoBlend, uPhone, time, uCorner, uFocus, uCull;
      uniform vec2 uMouse, uScale, resolution, uCardSize, uPointer, uPointerPrev;
      varying vec2 vUv;
      varying float vBackface, vSide, vDist;
      varying vec3 vWorldPos, vNormal, vViewDir, vReflection, vRefraction, vPos;
      ${RANGE}
      ${TRANSFORM_UV}
      ${RGB_SHIFT}
      ${FRESNEL}
      ${RADIAL_BLUR}
      ${REFL_FS}
      ${BLEND_MODES}

      // card silhouette — rounded rect, all corners equal
      float sdRoundBox(vec2 p, vec2 b, float r){
        vec2 q = abs(p) - b + r;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
      }

      // cheap 2D value noise, standing in for the required simplenoise chunk
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float cnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y) * 2.0 - 1.0;
      }
      float fbm2(vec2 p){
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * cnoise(p); p *= 2.03; a *= 0.5; }
        return v;
      }
      // domain-warped flow field driving the liquid hover
      float liquidField(vec2 p, float t, out vec2 grad){
        vec2 w = vec2(fbm2(p + t * 0.30), fbm2(p + 5.2 + t * 0.24));
        vec2 q = p + w * 1.5 - vec2(0.0, t * 0.42);
        float f = fbm2(q);
        float e = 0.045;
        grad = vec2(fbm2(q + vec2(e, 0.0)) - f, fbm2(q + vec2(0.0, e)) - f) / e;
        return f;
      }

      void main() {
        // silhouette in local card space (vPos carries the vertex shear, so the
        // rounded corners lean with the card exactly as the original's do)
        vec2 sil = vPos.xy * uCardSize;
        float sd = sdRoundBox(sil, uCardSize * 0.5, uCorner);
        if (sd > 0.0) discard;

        vec2 normalUV = scaleUV(vUv, vec2(0.5)) + vNormal.xy * 0.02;
        normalUV += cnoise(vUv * 1.0 + time * 0.06) * 0.01;
        vec3 normal = crange(texture2D(tNormal, normalUV).rgb, vec3(0.0), vec3(1.0), vec3(-1.0), vec3(1.0));

        float f = getFresnel(vNormal, vViewDir, uFresnelPow);

        // screen-space refraction of the scene behind the card
        vec2 ruv = gl_FragCoord.xy / resolution;
        ruv -= 0.05 * vNormal.xy;
        ruv -= normal.xy * (uHover * 0.03 + 0.02 + sin(time * 2.0 + vUv.x * 5.0) * 0.005);
        ruv = scaleUV(ruv, vec2(1.1 + uHover * 0.05));
        ruv += (uMouse - 0.5) * 0.02;
        vec3 refraction = pow(radialBlur(tRefraction, ruv, 5.0, 5.0).rgb, vec3(1.5));

        float edges = smoothstep(0.5, 6.0, abs(vViewDir.x - 0.5));
        float fadeVideo = smoothstep(3.0, 1.0, abs(vWorldPos.y - cameraPosition.y));

        vec2 videoUV = scaleUV(vUv, vec2(0.65, 0.52));
        videoUV += vec2(0.3, -0.5);
        videoUV.x += edges * 0.5;
        videoUV -= 0.5; videoUV *= 0.8; videoUV += 0.5;
        videoUV = mix(videoUV, scaleUV(gl_FragCoord.xy / resolution, vec2(0.6)), 0.3);
        videoUV = scaleUV(videoUV, uScale);

        /* ---- liquid hover -------------------------------------------------
         * A domain-warped flow field refracts the media UVs and sweeps a wet
         * ridge across the panel. Entirely gated on uHover, so a card that is
         * not hovered samples exactly as before. */
        vec2 lqGrad = vec2(0.0);
        float lqField = 0.0;
        float lqWake = 0.0;
        if (uHover > 0.001) {
          // aspect-correct offset from the cursor, in card space
          vec2 asp = vec2(uCardSize.x / uCardSize.y, 1.0);
          vec2 toP = (vUv - uPointer) * asp;
          float d = length(toP);

          // the flow field is dragged toward the cursor, so the liquid gathers
          // and swirls around wherever the pointer sits
          vec2 pull = normalize(toP + 1e-5) * exp(-d * 3.4) * 0.85;
          lqField = liquidField(vUv * 3.1 - pull, time, lqGrad);

          // radial ripple travelling out from the cursor
          float ripple = sin(d * 22.0 - time * 5.2) * exp(-d * 4.6);

          // wake along the direction of travel — the drag streak
          vec2 vel = (uPointer - uPointerPrev) * asp;
          float speed = min(length(vel) * 26.0, 1.0);
          vec2 dir = normalize(vel + 1e-5);
          float along = dot(toP, dir);
          lqWake = exp(-d * 3.0) * smoothstep(0.0, -0.25, along) * speed;

          vec2 disp = normalize(toP + 1e-5) * ripple * 0.030
                    + lqGrad * 0.016
                    + dir * lqWake * 0.045;
          videoUV += disp * uHover;
        }

        vec2 imageUV = videoUV - normal.xy * 0.05 * (1.0 - uVideoBlend);
        vec3 image = getRGB(tMap, scaleUV(imageUV, vec2(1.0 + (1.0 - uVideoBlend) * 0.1)), 0.0, 0.005 * edges).rgb * 0.7;
        vec3 video = getRGB(tVideo, scaleUV(videoUV, vec2(1.0 + (1.0 - uVideoBlend) * 0.1)), 0.0, 0.005 * edges).rgb;
        video = mix(image, video, uVideoBlend);
        video *= smoothstep(0.7, 0.0, abs(videoUV.x - 0.5)) * smoothstep(0.5, 0.4, abs(videoUV.y - 0.5));
        video *= mix(0.2, 1.0, fadeVideo);

        vec4 color = vec4(vec3(0.0), 1.0);
        color += envColorEquiRGB(tEnv, vRefraction, 0.2, 0.05) * 0.08;
        color.rgb += pow(min(vec3(0.5), video), vec3(1.0)) * 0.45;
        color.rgb += 0.01 * vUv.x + 0.01 * vUv.y;
        color.rgb *= 1.0 + 1.0 * pow(vSide, 3.0);

        color.rgb += refraction * mix(1.1, 0.3, smoothstep(0.65, 0.0, length(vUv - 0.5))) * mix(1.0, 0.7, uHover);
        color.rgb = blendSoftLight(color.rgb, video, smoothstep(0.7, 0.0, length(vUv - 0.5)) * 1.0);
        color.rgb *= 1.0 + sin(time * 2.0 + vUv.x * 5.0) * 0.15;

        vec2 offset = mix(vec2(0.5, 0.5), vec2(uMouse.x, 1.0 - uMouse.y), uHover);
        color.rgb = blendAdd(color.rgb, uColor, mix(0.0, 0.3 + uHover * 0.2, smoothstep(0.7, -0.1, length(vUv - offset))));
        color.rgb *= 1.0 + vSide * uHover * 0.2 + 0.3 * smoothstep(0.5, 0.0, abs(uHover - 0.5));

        /* wet ridge: a bright band riding the crest of the flow field, plus a
         * faint caustic lift in the troughs — the surface sheen of the liquid */
        if (uHover > 0.001) {
          float ridge = smoothstep(0.02, 0.16, lqField) * (1.0 - smoothstep(0.16, 0.34, lqField));
          float caustic = pow(clamp(lqField * 0.5 + 0.5, 0.0, 1.0), 3.5);
          color.rgb += vec3(0.62, 0.82, 1.0) * ridge * uHover * 0.42;
          color.rgb += uColor * caustic * uHover * 0.28;

          // wet pool directly under the cursor, brightest along the drag wake
          vec2 asp2 = vec2(uCardSize.x / uCardSize.y, 1.0);
          float dp = length((vUv - uPointer) * asp2);
          color.rgb += vec3(0.70, 0.86, 1.0) * exp(-dp * 6.0) * uHover * 0.30;
          color.rgb += vec3(0.55, 0.78, 1.0) * lqWake * uHover * 0.45;
        }

        // thin bright rim along the silhouette
        float edge = smoothstep(-0.035, 0.0, sd);
        color.rgb += uColor * edge * 0.55;
        color.rgb += vec3(0.80, 0.95, 1.0) * smoothstep(-0.011, 0.0, sd) * 0.30;

        // glassy: the spine and particles read through the panel
        float alpha = mix(0.38, 0.74, uFocus) * smoothstep(0.0, -0.008, sd);
        alpha = max(alpha, edge * 0.85);
        /* Cards outside the active window fade to nothing. Without this they
         * linger as faint rounded rectangles: their media is already dimmed by
         * the fadeVideo term above, so against black they read as grey ghosts. */
        alpha *= uCull;

        // single-target port: the original also writes backfaces to a WorkRefraction buffer
        gl_FragColor = vec4(color.rgb, alpha);
      }
    `,
  });
}

/* ------------------------------------------------------------------ *
 *  WorkItemUIShader — the label plane. Ported from compiled.vs.
 *  The oblique-angle glitch is uv.x += fract(uv.x * 15.0) * edges
 * ------------------------------------------------------------------ */
function labelMaterial(project, shared) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      time: shared.uTime,
      tMap: { value: labelTexture(project) },
      uAlpha: { value: 1 },
      uColor: { value: new THREE.Color(project.color) },
      uHover: { value: 0 },
      uCamDistance: { value: 10 },
    },
    vertexShader: /* glsl */`
      uniform float uHover;
      varying vec2 vUv;
      varying vec3 vPos, vWorldPos, vCameraPos, vViewDir;
      void main() {
        vUv = uv;
        vec3 pos = position;
        pos.z += 0.1 + smoothstep(1.0, 0.0, abs(vUv.x - 0.5)) * 0.3 + uHover * 0.2;
        pos.y -= (-0.5 + vUv.x) * 0.42;
        vPos = pos;
        vWorldPos = vec3(modelMatrix * vec4(pos, 1.0));
        vCameraPos = cameraPosition;
        vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tMap;
      uniform float uAlpha, uHover, uCamDistance, time;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying vec3 vPos, vWorldPos, vCameraPos, vViewDir;
      ${TRANSFORM_UV}
      ${RANGE}
      ${RGB_SHIFT}
      ${RGB2HSV}
      void main() {
        vec2 uv = scaleUV(vUv, vec2(0.42, 1.0));
        uv = scaleUV(uv, vec2(1.15));

        uv.y -= (-0.5 + uv.x) * 0.15;
        uv.x -= (0.5 - vViewDir.x) * 0.1;
        uv.y += 0.02;

        // oblique-angle stepping: this is the doubled-letter transition
        float edges = smoothstep(0.9 + uHover * 1.0, 7.0, abs(vViewDir.x - 0.5));
        uv.x += fract(uv.x * 15.0) * edges;
        uv.y -= uv.y * vViewDir.x * 0.15 * edges;

        vec3 color = getRGB(tMap, uv, radians(180.0), 0.001 - edges * 0.15).rgb;
        color *= smoothstep(0.5, 0.4, abs(uv.x - 0.5));
        color *= smoothstep(0.5, 0.4, abs(uv.y - 0.5));

        vec3 base = rgb2hsv(uColor);
        vec3 color2 = rgb2hsv(color);
        color2.x = color2.x * 0.1 + base.x - 0.25;
        color2.y *= base.y;
        color2 = hsv2rgb(color2);
        color = mix(color, color2, 0.05);

        color *= crange(uCamDistance, 5.0, 6.0, 1.0, 0.0);

        gl_FragColor = vec4(color * mix(0.65, 0.9, uHover), uAlpha);
      }
    `,
  });
}

/* ------------------------------------------------------------------ */
export function buildCards(projects, shared, deps) {
  const group = new THREE.Group();
  const cards = [];
  // unit geometry, scaled per mesh — the shader constants are authored in unit space
  const panelGeo = new THREE.BoxGeometry(1, 1, 1);
  const labelGeo = new THREE.PlaneGeometry(1, 1);

  const mobile = innerHeight > innerWidth;
  const step = mobile ? ANGLE_STEP_MOBILE : ANGLE_STEP;
  const total = Math.min(7, projects.length);
  const yStart = mobile ? 4 : 0;
  const yStep = (mobile ? 0.16 : 0.12) * total;

  projects.forEach((project, i) => {
    const angle = -i * step;                       // angle -= step
    const y = yStart - yStep * i;

    const holder = new THREE.Group();
    holder.position.set(CARD_ORBIT * Math.cos(angle), 0, CARD_ORBIT * Math.sin(angle));

    // camera target is the card position doubled — computed while y is still 0,
    // so both the card and the camera end up with a purely horizontal rotation
    const camTarget = holder.position.clone().multiplyScalar(2);
    holder.lookAt(camTarget);

    holder.position.y = y;
    camTarget.y = y;

    const pos = holder.position.clone();

    const pMat = panelMaterial(project, shared, {
      ...deps, thumb: makeThumbTexture(project.color, i * 37 + 5),
    });
    const panel = new THREE.Mesh(panelGeo, pMat);
    panel.scale.set(CARD_W, CARD_H, CARD_D);
    panel.renderOrder = 10;
    holder.add(panel);

    const lMat = labelMaterial(project, shared);
    const label = new THREE.Mesh(labelGeo, lMat);
    label.scale.set(LABEL_W, LABEL_H, 1);
    label.renderOrder = 20;
    holder.add(label);

    group.add(holder);
    cards.push({
      holder, panel, label, pMat, lMat, project, i, y, angle, pos,
      // camera waypoint: position at 2x orbit, sharing the card's quaternion
      camTarget: { position: camTarget, quaternion: holder.quaternion.clone() },
    });
  });

  return { group, cards };
}
