# Descent rework — audited baseline (2026-08-20)

Source of truth for the continuous-descent rework. Every number below was read
from the current code (cited) or measured live in Chrome this session. Track:
land 0-105 / drift 105-245 / gather 245-385 / burst 385-905 / work 905-1855vh
(travel 1855; burstVh = trackVh - 385).

## World Y (live-measured + code)

| thing | world Y | source |
|---|---|---|
| burst water surface (topside, 260x260, world-fixed) | -14.6 -> -12.4 (rises burstVh 360..405) | main.js:732,743,3430 |
| work room water ceiling (1728x1728) | +2.0 | water.js:729 |
| work cards (14, orbit 3.8) | 0 .. -10.92 | cards.js:467-474 |
| spine (GLB column) | +7.1 .. -33.2 | spine-glb.js:146-155, live box |
| work foliage bowl | -16 .. +16 (y), z -33..-8 | foliage.js:87-97 |
| burst flora beds (eye-locked holder) | bases settle ~ -12.3 | main.js:726-727 |
| film plane | eye-locked, z 0, spans ~24 units of y | main.js:3410-3417 |

## Camera Y across the crossing (from code constants)

Burst eye = -4.5 - filmDrift - waterTailDrop (hpF pinned=1 since burstVh 182):

| trackVh | burstVh | eye Y |
|---|---|---|
| 685 | 300 | -4.87 |
| 745 | 360 | -5.21 |
| 785 | 400 | -9.36 |
| 805 | 420 | -11.50 |
| **805-875** | **420-490** | **-11.50 FROZEN (the stall)** |
| 903 | 518 | -12.35 |
| 903-905 | 518-520 | -12.35 frozen (2vh) |

Work eye: rest = waypoint0.y(0) + rail tail lift(+1) = **+1.0**; with the
3.6 dive at band open = **+4.6**. Rail end (wp=1): **-11.92**.

**Discontinuity at the crossing: burst -12.35 -> work +2.5..+4.6 (a 15-17
unit upward teleport), plus ~34 units of z (burst eye z ~41.8 looking -z;
work eye orbits the spine at radius 7.6, horizontal quaternions).**

## The wipe

Band = 825-985vh (TRANSITION_VH.work=160, centred on 905). The shader
REVEALS the incoming render from the bottom of frame along a sweeping line;
it translates nothing (transition.js:99-124 — same uv both halves). Cut
speed: 1 screen height / 160vh.

## Root causes (verified)

1. **Stuck viewport**: burst eye derivative exactly zero for 70vh
   (805-875) — filmDrift saturates at 399, sink at 405, skim at 420, settle
   opens 490, hpF pinned since 182. Also frozen 903-905, and the OUTGOING
   half is frozen for the whole 905-985 half-band (burstVh clamps at 520).
2. **Whole 3D scene rising**: (a) bottom-up reveal by the wipe over a
   static outgoing half; (b) the 3.6-unit incoming dive + 0.28rad pitch
   unwind + fov 30->35 slews the incoming content upward ~0.8-1.3 screen
   heights during the band — the incoming room visibly translates up.
3. **Broken middle frame**: the 3.6 dive lifts the incoming eye to +4.6,
   ABOVE the room's own water ceiling (+2) — the room renders from outside,
   its ceiling slices the spine, its empty upper volume reads as blank.
4. **Void between foliage and spine**: the work room's empty volume
   (ceiling +2 down to first card at 0..-11) composited beneath burst's
   grass — two scenes never vertically related.

## Camera-followers (would break a true world-anchored descent)

planetHolder (main.js:3449), floraHolder + partial anchors (3500-3513),
foliage.heroGroup (3536-3539), film plane deepBgHolder (3410-3417, collapses
if eye crosses z 0), emblem+rig (3216-3311), jelly/comet/nebula (3354-3372),
planet pin rays (3469-3494). wetSpec is parented to camGroup (1053-1055).

## Z-collision map for a naive workRoot -14.4 translation

Burst and work content are NOT z-separated: film plane at z 0 passes through
the card orbit and spine column; flora beds z -4..+34 overlap; planets
z -20..-29 sit inside the translated bowl; the 260x260 topside spans all x/z
and would be coplanar with the translated ceiling (-12.4), both claiming the
one mirror target. Rail waypoints are Vector3s captured at build time —
translating workRoot alone does NOT move the rail, the ceiling, or wetSpec.

## Section-keyed staging (must become depth/scroll-driven for a merged world)

~40 switches in stageSection keyed on section name or inVolume: visibility
(workRoot/atmosRoot/nebula/emblem/water faces), fog 0.022/0.027, wetSpec
28/0, rims, ambienceRoot transform, heroCloud brightness, grade/DOF/ray
channel maps, arrive ramp (wp 0..0.12), mirror face pick. Full table in the
audit (stageSection lines 2762-3603).

## WebP film (current, verified)

315 frames over burstVh 209-399 (1.66 f/vh); parks only 1vh before the dive;
fade-in only (no fade-out — the wipe is what consumes it, by design);
skeleton pinned (every 8th + last); worst structural gap ~7 frames (~4.2vh);
true freeze only possible before a blob has downloaded. Eye-locked in Y and
scale by design — a world-anchored descent requires a fade-out instead.
