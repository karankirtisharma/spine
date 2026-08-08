// Verbatim ports of the Hydra shader chunks that WorkItemShader / WorkItemUIShader
// `#require`. Extracted from activetheory.net/assets/shaders/compiled.vs.

export const TRANSFORM_UV = /* glsl */`
vec2 rotateUV(vec2 uv, float r, vec2 origin) {
    float c = cos(r); float s = sin(r);
    mat2 m = mat2(c, -s, s, c);
    vec2 st = uv - origin;
    st = m * st;
    return st + origin;
}
vec2 scaleUV(vec2 uv, vec2 scale, vec2 origin) {
    vec2 st = uv - origin;
    st /= scale;
    return st + origin;
}
vec2 rotateUV(vec2 uv, float r) { return rotateUV(uv, r, vec2(0.5)); }
vec2 scaleUV(vec2 uv, vec2 scale) { return scaleUV(uv, scale, vec2(0.5)); }
`;

export const RANGE = /* glsl */`
float range(float oldValue, float oldMin, float oldMax, float newMin, float newMax) {
    vec3 sub = vec3(oldValue, newMax, oldMax) - vec3(oldMin, newMin, oldMin);
    return sub.x * sub.y / sub.z + newMin;
}
vec3 range(vec3 oldValue, vec3 oldMin, vec3 oldMax, vec3 newMin, vec3 newMax) {
    vec3 oldRange = oldMax - oldMin;
    vec3 newRange = newMax - newMin;
    vec3 val = oldValue - oldMin;
    return val * newRange / oldRange + newMin;
}
float crange(float oldValue, float oldMin, float oldMax, float newMin, float newMax) {
    return clamp(range(oldValue, oldMin, oldMax, newMin, newMax), min(newMin, newMax), max(newMin, newMax));
}
vec3 crange(vec3 oldValue, vec3 oldMin, vec3 oldMax, vec3 newMin, vec3 newMax) {
    return clamp(range(oldValue, oldMin, oldMax, newMin, newMax), min(newMin, newMax), max(newMin, newMax));
}
`;

export const RGB_SHIFT = /* glsl */`
vec4 getRGB(sampler2D tDiffuse, vec2 uv, float angle, float amount) {
    vec2 offset = vec2(cos(angle), sin(angle)) * amount;
    vec4 r = texture2D(tDiffuse, uv + offset);
    vec4 g = texture2D(tDiffuse, uv);
    vec4 b = texture2D(tDiffuse, uv - offset);
    return vec4(r.r, g.g, b.b, g.a);
}
`;

export const FRESNEL = /* glsl */`
float getFresnel(vec3 normal, vec3 viewDir, float power) {
    float d = dot(normalize(normal), normalize(viewDir));
    return 1.0 - pow(abs(d), power);
}
`;

export const RADIAL_BLUR = /* glsl */`
vec3 radialBlur(sampler2D map, vec2 uv, float size, float quality) {
    vec3 color = vec3(0.0);
    const float pi2 = 3.141596 * 2.0;
    const float direction = 8.0;
    vec2 radius = size / vec2(1024.0);
    float samples = 0.0;
    for (float d = 0.0; d < pi2; d += pi2 / direction) {
        vec2 t = radius * vec2(cos(d), sin(d));
        for (float i = 1.0; i <= 100.0; i += 1.0) {
            if (i >= quality) break;
            color += texture2D(map, uv + t * i / quality).rgb;
            samples += 1.0;
        }
    }
    return color / samples;
}
`;

export const REFL_VS = /* glsl */`
vec3 inverseTransformDirection(in vec3 n, in mat4 matrix) {
    return normalize((matrix * vec4(n, 0.0) * matrix).xyz);
}
vec3 reflection(vec4 worldPosition) {
    vec3 transformedNormal = normalMatrix * normal;
    vec3 cameraToVertex = normalize(worldPosition.xyz - cameraPosition);
    vec3 worldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
    return reflect(cameraToVertex, worldNormal);
}
vec3 refraction(vec4 worldPosition, float refractionRatio) {
    vec3 transformedNormal = normalMatrix * normal;
    vec3 cameraToVertex = normalize(worldPosition.xyz - cameraPosition);
    vec3 worldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
    return refract(cameraToVertex, worldNormal, refractionRatio);
}
`;

export const REFL_FS = /* glsl */`
vec4 envColorEquiRGB(sampler2D map, vec3 direction, float angle, float amount) {
    vec2 uv;
    uv.y = asin(clamp(direction.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
    uv.x = atan(direction.z, direction.x) * 0.15915494 + 0.5;
    vec2 offset = vec2(cos(angle), sin(angle)) * amount * 0.01;
    vec4 r = texture2D(map, uv + offset);
    vec4 g = texture2D(map, uv);
    vec4 b = texture2D(map, uv - offset);
    return vec4(r.r, g.g, b.b, g.a);
}
`;

/* matcap.vs, verbatim — including their comment on the 0.495.
 *
 * A matcap is a photograph of a lit sphere: look up the pixel whose surface normal
 * matches this fragment's, and the whole material -- highlights, shadow, dispersion --
 * comes for free and looks photographic, because it was. Their jellyfish leans on
 * this entirely (uil.json binds `assets/images/room/matcap-test.jpg`, a faceted
 * crystal ball with prismatic edges, as both tMap and tMatcap), which is why theirs
 * reads as real glass and a hand-authored fresnel tint does not. */
export const MATCAP_VS = /* glsl */`
vec2 reflectMatcap(vec3 worldPos, vec3 worldNormal) {
    vec3 viewDir = normalize(cameraPosition - worldPos);
    vec3 x = normalize(vec3(viewDir.z, 0.0, - viewDir.x));
    vec3 y = cross(viewDir, x);
    vec2 uv = vec2(dot(x, worldNormal), dot(y, worldNormal)) * 0.495 + 0.5; // 0.495 to remove artifacts caused by undersized matcap disks
    return uv;
}
`;

export const BLEND_MODES = /* glsl */`
float blendSoftLight(float base, float blend) {
    return (blend < 0.5)
      ? (2.0 * base * blend + base * base * (1.0 - 2.0 * blend))
      : (sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend));
}
vec3 blendSoftLight(vec3 base, vec3 blend) {
    return vec3(blendSoftLight(base.r, blend.r), blendSoftLight(base.g, blend.g), blendSoftLight(base.b, blend.b));
}
vec3 blendSoftLight(vec3 base, vec3 blend, float opacity) {
    return blendSoftLight(base, blend) * opacity + base * (1.0 - opacity);
}
vec3 blendAdd(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }
vec3 blendAdd(vec3 base, vec3 blend, float opacity) {
    return blendAdd(base, blend) * opacity + base * (1.0 - opacity);
}
float blendOverlay(float base, float blend) {
    return base < 0.5 ? (2.0 * base * blend) : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend));
}
vec3 blendOverlay(vec3 base, vec3 blend) {
    return vec3(blendOverlay(base.r, blend.r), blendOverlay(base.g, blend.g), blendOverlay(base.b, blend.b));
}
vec3 blendOverlay(vec3 base, vec3 blend, float opacity) {
    return blendOverlay(base, blend) * opacity + base * (1.0 - opacity);
}
`;

export const RGB2HSV = /* glsl */`
vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`;
