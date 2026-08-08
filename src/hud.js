/* FRAME 12's TELEMETRY HUD — the DOM layer of the grid section.
 *
 * Reference frame 12 carries five text fixtures the GL scene does not:
 *
 *   top-left      09 | CYPHERNAUT           with a small compass glyph beneath
 *   right-upper   SYS_09 / ORBITAL GRID / ACTIVE
 *   left-mid      RNG 120.0 / ELV -2.4
 *   right-lower   TRJ 00-A / VECTOR LOCK
 *   bottom-left   CYPHERNAUT / COMMAND DECK SERVICES
 *
 * Positions are measured off the 1671x949 frame and expressed as percentages, the
 * same discipline as about.js. DOM rather than GL text for the same reason About is
 * DOM: their engine draws type through an MSDF atlas we cannot ship.
 *
 * The layer fades as one unit off `setProgress` -- the telemetry belongs to the
 * lock-in beat, arriving after the rings start assembling (see grid-fx.js) -- with a
 * per-block stagger so the readouts land one after another, the way instrument
 * panels wake rather than all at once.
 */

const CSS = `
.SeqHUD {
  position: fixed; inset: 0; z-index: 3; pointer-events: none;
  font-family: var(--font);
  opacity: 0; transition: opacity .4s ease-out;
}
.SeqHUD.on { opacity: 1 }

.SeqHUD .b {
  position: absolute;
  font-size: clamp(9px, 0.72vw, 13px);
  line-height: 1.75; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(214, 255, 236, 0.62);
  opacity: 0; transform: translateY(6px);
  transition: opacity .5s ease-out, transform .5s ease-out;
}
.SeqHUD.on .b { opacity: 1; transform: none }
/* the stagger: each block waits a beat longer */
.SeqHUD .b:nth-child(2) { transition-delay: .12s }
.SeqHUD .b:nth-child(3) { transition-delay: .24s }
.SeqHUD .b:nth-child(4) { transition-delay: .36s }
.SeqHUD .b:nth-child(5) { transition-delay: .10s }

.SeqHUD .corner { left: 2.0%; top: 3.2%; display: flex; align-items: center; gap: 0.9em;
  color: rgba(234, 255, 245, 0.88); }
.SeqHUD .corner .no { font-size: clamp(13px, 1.05vw, 19px); letter-spacing: 0.08em }
.SeqHUD .corner .sep { width: 1px; height: 2.2em; background: rgba(214,255,236,0.35) }
.SeqHUD .glyph { position: absolute; left: 2.2%; top: 8.5%;
  font-size: clamp(11px, 0.9vw, 16px); color: rgba(214,255,236,0.5) }

.SeqHUD .sys { left: 64.5%; top: 25.5% }
.SeqHUD .rng { left: 31.5%; top: 50.0%; text-align: right; transform-origin: right }
.SeqHUD .trj { left: 63.5%; top: 73.5% }
/* the small accent rule each readout hangs from, frame 12's leader-line reading */
.SeqHUD .sys::before, .SeqHUD .trj::before, .SeqHUD .rng::before {
  content: ''; display: block; width: 2.2em; height: 1px;
  background: rgba(216, 255, 154, 0.45); margin-bottom: 0.55em;
}
.SeqHUD .rng::before { margin-left: auto }

.SeqHUD .title { left: 2.0%; bottom: 4.5%; color: rgba(234, 255, 245, 0.8) }

/* Short viewports: the readouts collide with the figure; the corner and title are
 * the identity and stay. Same height gate discipline as about.js. */
@media (max-height: 480px) {
  .SeqHUD .sys, .SeqHUD .rng, .SeqHUD .trj { display: none }
}
`;

export function buildHud() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'SeqHUD';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="b corner"><span class="no">09</span><span class="sep"></span><span>Cyphernaut</span></div>
    <div class="b sys">SYS_09<br>Orbital Grid<br>Active</div>
    <div class="b rng">RNG 120.0<br>ELV -2.4</div>
    <div class="b trj">TRJ 00-A<br>Vector Lock</div>
    <div class="b title">Cyphernaut<br>Command Deck Services</div>
    <div class="glyph">&#10022;</div>
  `;
  document.getElementById('Stage').appendChild(root);

  let on = null;

  return {
    root,

    /** Show or hide the layer. Idempotent — only touches classList on a change. */
    setActive(active) {
      if (active === on) return;
      on = active;
      root.classList.toggle('on', active);
    },

    /**
     * Grid-section local progress. The layer waits for the rings to start
     * assembling (0.25), then the CSS stagger does the per-block timing -- driving
     * five opacities from here every frame would just re-implement transitions.
     */
    setProgress(p) {
      this.setActive(on === true ? p > 0.2 : p > 0.25);
    },
  };
}
