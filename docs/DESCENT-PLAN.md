# Merged-world plan (revised against the audit + live measurement)

Supersedes the naive `workRoot.position.y -= 14.4` proposal. Baseline:
docs/DESCENT-BASELINE.md.

## Measured world (live, at track 903 = the boundary)

| object | x | y | z |
|---|---|---|---|
| burst eye | 0 | **-12.35** | **+41.8** (looks -z, pitch +3.7deg, fov 30) |
| water surface (topside) | +/-130 | **-12.4** | +/-130 |
| flora beds | -18.1 .. 20.0 | -15.8 .. 5.1 | **-13.4 .. 38.9** |
| film plane (eye-locked) | cover-fit | ~-21.6 .. 2.4 | **0** |
| planets (pinned) | various | -5 .. -17 | **~-21** |
| work column (GLB + flower cloud) | +/-2.8 | -33.2 .. 12.0 | +/-4.7 |
| work cards | +/-4.1 | -11.8 .. 0.9 | +/-4.1 |
| work bowl (foliage.workGroup) | -27.1 .. 25.1 | -23.1 .. 24.1 | **-40.8 .. -12.9** |
| work room ceiling mesh | - | +2.0 | - |
| work rail (waypoints, local) | orbit 7.6 | 0 .. -10.92 | orbit 7.6 |

**Key discovery:** the bowl lives entirely at negative z, the flora almost
entirely at positive z. They overlap in only a 0.5-unit z sliver. The two
worlds are far closer to z-separated than the worst case assumed.

## Chosen placement

```
workRoot.position = (0, -26, +18)
cardGroup rotated -90deg about Y      (rail opens facing the camera's heading)
foliage.workGroup extra -10.5 in Y    (bowl crown lands exactly on the surface)
```

Resulting world:

| | Y range | note |
|---|---|---|
| water surface | **-12.4** | unchanged, the one boundary |
| work column | -59.2 .. **-14.0** | crown 1.6 under the surface, seen through it on approach |
| work cards | -37.8 .. -25.1 | 12.7 under the surface |
| work bowl | -49.6 .. **-12.4** | crown exactly at the waterline |
| rail (eye) | **-25.0** .. -37.9 | orbit centre z +18, radius 8.85 |

**Camera hand-off: (0, -12.35, 41.8) -> (0, -25.0, 26.85).**
dY = **-12.65**, dZ = **-15.0**, **dYaw = 0**. A dive forward-and-down, not a
teleport. Yaw is zero because the card ring is rotated so waypoint 0 opens on
+z, the heading the burst camera already holds.

### Why z +18 (this is the load-bearing choice)

- Cards move to z 14.2..21.8; the **film plane is at z 0** -> 14 units of
  clearance. The audit's biggest collider disappears by placement, not by
  special-casing.
- Planets at z ~-21 -> 35 units clear of the room.
- Shortens the forward travel from 33 to 15 units, so the hand-off reads as a
  descent (dY/dZ ~ 1:1.2) rather than a dolly (was 1:31).
- The bowl still crosses z 0, but only below Y -12.4, where the film has
  already faded and is hidden.

## The twelve questions

1. **Ceiling world Y** - the separate ceiling plane is retired as a room fixture
   and repositioned to **-12.42**, single-sided facing down; the topside at
   -12.4 becomes single-sided facing up. Two faces of ONE surface, 0.02 apart,
   never both visible, no z-fight.
2. **Cards** - **-37.8 .. -25.1**.
3. **Spine** - **-59.2 .. -14.0**.
4. **Rail** - eye begins **(0, -25.0, 26.85)**, ends **(-37.9)** on the orbit
   centred at (0, ., 18), radius 8.85.
5. **Waypoints** - never re-authored. A single `WORK_XFORM` (the workRoot
   matrix) is applied at *consumption*: `target.position.copy(wpLocal)
   .applyMatrix4(workRoot.matrixWorld)` and `target.quaternion.copy(wpQuat)
   .premultiply(workRootQuat)`. One source of truth; rail and room cannot drift.
6. **Z collisions** - resolved by placement (see above). Nothing is clipped or
   hidden to hide an intersection.
7. **Flora and planets** - flora **stays and is world-anchored**: it is the
   thing you descend past. Planets and the film are eye-locked by design and
   are **faded out on a depth signal before the surface crossing**, so their
   lock is never observable during the descent.
8. **Must become world-anchored** - `floraHolder` (main.js:3500) and
   `foliage.heroGroup` (3536). Remain eye-locked (and faded before the
   descent): deepBgHolder, planetHolder + pin, emblem + rig, jelly/comet/
   nebula. `wetSpec` stays parented to camGroup by design (travelling
   highlight).
9. **Mirror face** - depth-driven: `eyeY > surfaceY ? topside : ceiling`.
   MIRROR_EPS unchanged; the merged fall passes through the guard band instead
   of parking in it.
10. **Staging classification**
    - **A - depth-driven** (eye Y vs -12.4): workRoot visibility, fog density
      (0.022/0.027), wetSpec 28/0, water face pick, grade release, rim gate,
      atmosRoot/nebula/emblem visibility, ambienceRoot transform, heroCloud
      brightness.
    - **B - stays scroll-driven**: the rail (wp), card hover/focus, the film
      scrub and its fade, the mark's exit, HUD/DOM section labels, the arrive
      ramp (retimed off the depth signal's own progress).
    - **C - removable once the boundary is not a scene change**: `mixSeam` for
      grade/DOF, `bloomFor` lerp, `deepRay`/`markExit` TR blends, saturation on
      postFront, the postFront restages for volumetric and mirror, the outgoing
      half render + its DOF pass, `transitionPass` and its targets, and the
      `S.burst.active || TR.active` film gate.
11. **WebP handoff** - extend `FILM_SPAN_VH` so the last frame lands ~burstVh
    455 (density drops to ~1.3 f/vh, cheaper than today), then a **dedicated
    fade 455->500** on the film's own material - not the wipe. Fully gone by
    500; the surface crossing is at 518. Park interval: ~1vh. Verified by
    instrumenting expected-vs-actual frame index against scroll delta, not by
    cache counters.
12. **Page scroll** - untouched. Nothing in the repo ever locks, snaps or
    writes scrollTop; Lenis maps linearly across the whole track and the track
    length does not change. Removing the wipe removes rendering work, not
    scroll behaviour.

## The real cost, stated plainly

With the wipe gone the two worlds must **co-render in one pass** through the
overlap band - one camera, one fog, one grade, both object sets visible. They
have never co-rendered. Expect: higher draw calls and program count in the
overlap, and a grade/fog reconciliation (burst 0.022 vs work 0.027) that must
become a depth blend rather than a switch. This is why depth-driven staging is
its own checkpoint, after the geometry and the camera are proven.

## Checkpoint order (each: change -> record -> verify -> commit)

- **C0 baseline** - done (51b966b)
- **C1 restore coherence** - done (5074678 revert 3.6, 438f8d5 freeze removed)
  - awaiting the client's recording before proceeding
- **C2 merged geometry** - workRoot placement, card-ring rotation, bowl offset,
  ceiling relocation, waypoint transform at consumption. Wipe still on; verify
  the room's static composition and that nothing intersects.
- **C3 camera merge** - one continuous path from the plunge into the rail;
  delete the dive offset; verify monotonic Y and zero yaw step.
- **C4 wipe removal** - seams -> `['drift']`; delete the class-C machinery.
- **C5 depth staging + foliage anchoring**
- **C6 WebP handoff + frame-vs-scroll instrumentation**
- **C7 full continuous-scroll verification**

Revert granularity: one checkpoint per commit; any regression is reverted at
its own checkpoint before continuing.
