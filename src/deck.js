/* THE SERVICE DECK — frames 13-17's glass panels and cards.
 *
 * Frames 13-16 slide one tall frosted-glass slab in from each frame edge; by frame
 * 17 each slab has resolved into three service cards:
 *
 *   left    STRATEGY / Navigate complexity.      right   TECHNOLOGY / Engineer possibility.
 *           BRANDING / Build resonance.                  SYSTEMS / Scale with intent.
 *           EXPERIENCE / Craft connection.                INSIGHTS / Reveal what matters.
 *
 * each with a small rosette glyph in a ring and a trailing arrow.
 *
 * DOM GLASSMORPHISM, not GL. The reference panels are frosted glass holding the
 * nebula's light -- and `backdrop-filter: blur()` over the WebGL canvas produces
 * exactly that: the browser blurs whatever the canvas rendered beneath the element,
 * nebula included, live. The GL alternative (rounded-rect SDF planes sampling a
 * radial blur of tRefraction, plus a DOM text overlay kept aligned to them) buys no
 * extra fidelity for three new failure modes: refraction-pass exclusion, transparent
 * sort order against five other translucent stacks, and per-frame projection sync
 * between the text and its panel. About.js set the precedent that type belongs to
 * the DOM; the panel IS mostly type.
 *
 * TWO LAYERS, one element set. The slabs (morph) and the cards (deck) are separate
 * fixed layers; morph progress drives the slabs' translate, deck progress swaps
 * slab for cards with a short crossfade. Both follow the front section like the HUD
 * -- pointer-events stay off except the card arrows in deck.
 */

const CARDS = [
  ['left', 'Strategy', 'Navigate complexity.'],
  ['left', 'Branding', 'Build resonance.'],
  ['left', 'Experience', 'Craft connection.'],
  ['right', 'Technology', 'Engineer possibility.'],
  ['right', 'Systems', 'Scale with intent.'],
  ['right', 'Insights', 'Reveal what matters.'],
];

const CSS = `
.Deck, .DeckSlabs {
  position: fixed; inset: 0; z-index: 3; pointer-events: none;
  font-family: var(--font);
}

/* ---- the morph slabs (frames 13-16) ---- */
.DeckSlabs .slab {
  position: absolute; top: 24%; height: 55%; width: 17%;
  /* Enough fill to exist over BLACK: backdrop blur only shows where light sits
   * behind the glass, and our frame edges are darker than the reference's -- at
   * 0.05 the slabs simply were not there. */
  background: linear-gradient(105deg, rgba(120, 205, 165, 0.14), rgba(80, 160, 130, 0.06));
  border: 1px solid rgba(190, 255, 224, 0.3);
  backdrop-filter: blur(14px) saturate(1.25);
  -webkit-backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: inset 0 0 40px rgba(120, 220, 170, 0.05);
  /* transform is driven from JS; transitions would fight the scroll scrubber --
   * the wipe rule applies to DOM too: assigned, never eased */
}
.DeckSlabs .slab.l { left: 0; border-radius: 0 22px 22px 0; border-left: none }
.DeckSlabs .slab.r { right: 0; border-radius: 22px 0 0 22px; border-right: none }

/* ---- the deck cards (frame 17) ---- */
.Deck .card {
  position: absolute; width: 14.5%; min-width: 150px; height: 16.5%;
  padding: 1.1em 1.3em;
  display: flex; flex-direction: column; justify-content: flex-end; gap: 0.5em;
  background: rgba(110, 190, 150, 0.055);
  border: 1px solid rgba(190, 255, 224, 0.22);
  border-radius: 18px;
  backdrop-filter: blur(14px) saturate(1.25);
  -webkit-backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: inset 0 0 34px rgba(120, 220, 170, 0.06);
  opacity: 0; transform: translateY(10px);
  transition: opacity .45s ease-out, transform .45s ease-out;
  color: rgba(224, 255, 240, 0.9);
}
.Deck.on .card { opacity: 1; transform: none; pointer-events: auto }
/* the stagger: cards wake top to bottom, left leading right by half a beat */
.Deck .card:nth-child(1) { transition-delay: 0s }
.Deck .card:nth-child(2) { transition-delay: .1s }
.Deck .card:nth-child(3) { transition-delay: .2s }
.Deck .card:nth-child(4) { transition-delay: .05s }
.Deck .card:nth-child(5) { transition-delay: .15s }
.Deck .card:nth-child(6) { transition-delay: .25s }

.Deck .card.l { left: 1.8% }
.Deck .card.r { right: 1.8% }
.Deck .card:nth-child(1), .Deck .card:nth-child(4) { top: 27% }
.Deck .card:nth-child(2), .Deck .card:nth-child(5) { top: 45.5% }
.Deck .card:nth-child(3), .Deck .card:nth-child(6) { top: 64% }

.Deck .glyph {
  width: 2em; height: 2em; border-radius: 50%;
  border: 1px solid rgba(214, 255, 236, 0.4);
  display: flex; align-items: center; justify-content: center;
  font-size: clamp(9px, 0.72vw, 13px); color: rgba(214, 255, 236, 0.75);
  margin-bottom: auto;
}
.Deck .card h3 {
  margin: 0; font-weight: 400;
  font-size: clamp(11px, 0.95vw, 17px);
  letter-spacing: 0.18em; text-transform: uppercase;
}
.Deck .card .row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6em;
}
.Deck .card p {
  margin: 0; font-size: clamp(9px, 0.72vw, 13px);
  letter-spacing: 0.08em; color: rgba(214, 255, 236, 0.6);
}
.Deck .card .arrow { opacity: 0.7; transition: transform .35s cubic-bezier(.17,.4,.02,.99) }
.Deck .card:hover .arrow { transform: translateX(5px) }
.Deck .card:hover { border-color: rgba(216, 255, 154, 0.5) }

/* Short viewports: three stacked cards need ~500px; below that, keep the top card
 * per side (the deck's identity) and drop the rest. */
@media (max-height: 500px) {
  .Deck .card:nth-child(2), .Deck .card:nth-child(3),
  .Deck .card:nth-child(5), .Deck .card:nth-child(6) { display: none }
  .Deck .card:nth-child(1), .Deck .card:nth-child(4) { top: 36%; height: 28% }
}
`;

export function buildDeck() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  /* The slabs. Driven by transform only, so they cost nothing when parked
   * off-screen; no .on class -- their whole life is the JS-driven translate. */
  const slabs = document.createElement('div');
  slabs.className = 'DeckSlabs';
  slabs.setAttribute('aria-hidden', 'true');
  slabs.innerHTML = `<div class="slab l"></div><div class="slab r"></div>`;
  const slabL = slabs.children[0], slabR = slabs.children[1];

  const deck = document.createElement('div');
  deck.className = 'Deck';
  deck.setAttribute('aria-hidden', 'true');
  deck.innerHTML = CARDS.map(([side, title, line]) => `
    <div class="card ${side[0]}">
      <div class="glyph">&#10042;</div>
      <h3>${title}</h3>
      <div class="row"><p>${line}</p><span class="arrow">&#8594;</span></div>
    </div>`).join('');

  const stage = document.getElementById('Stage');
  stage.appendChild(slabs);
  stage.appendChild(deck);

  let deckOn = null;
  let slabT = null;

  return {
    /**
     * Morph-section slab travel, 0..1. The slabs live fully off-screen at 0 and
     * reach frame 16's one-third reveal at 1 -- they never come further in than
     * that; the CARDS are what finish the journey. Assigned per frame (scroll is
     * the timeline), hence transform with no CSS transition.
     */
    setSlide(t) {
      if (t === slabT) return;
      slabT = t;
      const k = Math.min(1, Math.max(0, t));
      /* Front-loaded: frame 13 (p ~0.125) already shows the slabs ~10% into
       * frame, so most of the travel happens across the first 60% of morph.
       * 105 -> 28: at rest fully outside, at full morph ~72% of the slab in
       * frame (~12% of screen width), matching frame 16. */
      const e = Math.min(1, k / 0.6);
      const off = 105 - 77 * (e * e * (3 - 2 * e));
      slabL.style.transform = `translateX(${-off}%)`;
      slabR.style.transform = `translateX(${off}%)`;
      slabs.style.display = k <= 0.001 ? 'none' : '';
    },

    /** Deck-section card reveal; also swaps the slabs out under the cards. */
    setDeck(p) {
      const want = p > 0.12;
      if (want !== deckOn) {
        deckOn = want;
        deck.classList.toggle('on', want);
      }
      /* The slabs hand over to the cards across the first fifth of deck. Their
       * translate holds at the frame-16 position while they fade. */
      const fade = Math.min(1, Math.max(0, (p - 0.05) / 0.15));
      slabs.style.opacity = String(1 - fade);
    },

    /** Hard off, for every section that is neither morph nor deck. */
    setActive(active) {
      if (!active) {
        this.setSlide(0);
        if (deckOn !== false) { deckOn = false; deck.classList.remove('on'); }
        slabs.style.opacity = '1';
      }
    },
  };
}
