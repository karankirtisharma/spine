/* SECTION 2 — the settled hero, built to reference image 1.
 *
 * Every position below is measured off that reference (1671 x 949) and expressed as a
 * percentage, so the composition holds at any width:
 *
 *   CYPHERNAUT            left 9.1%,  baseline 63%
 *   COMMAND DECK SERVICES left 9.1%,  baseline 69%
 *   right column          left 72.3% to 93.1%
 *     body para 1         y 52%  (2 lines)
 *     body para 2         y 59%  (3 lines)
 *     service rows        y 71% to 87%, 3.9% apart, hairline under each
 *
 * One detail worth naming because it is easy to miss and load-bearing: the two
 * headline lines END AT THE SAME X in the reference -- 722 and 719 of 1671 -- even
 * though the second is set much smaller. That is tracking doing the work, not size,
 * and it is what makes the block read as one locked unit rather than two stacked
 * labels. The ch-based width below reproduces it.
 *
 * The mark's transform is still Active Theory's, from their About render tick:
 *
 *   logo.position.y = Math.range(scrollProgress, -1, 1, 6, -2);
 *   logo.rotation.y = -Math.radians(200) * (-0.5 + scrollProgress)
 *                   + Math.radians(60) + 2 * rotation;
 *
 * Note the -1..1 input against a 0..1 scroll: at scrollProgress 0 the mark is already
 * at y 4, not 6, and it leaves at 2 rather than -2. Their range() does not clamp and
 * the section is a 105vh sliver, so only the middle half of that travel is ever used.
 * Copied as authored rather than "corrected" -- the flattened arc is the look.
 *
 * DOM rather than their GLUI text. They render type into the GL scene through an MSDF
 * atlas (msdf.glsl, GLUIBatchText.glsl); matching that needs an MSDF build of the
 * typeface, and the reference's wide techno face is licensed and cannot ship here.
 */

const HEADLINE = 'Cyphernaut';
const SUBHEAD = 'Command Deck Services';

/* Verbatim from reference image 1. */
const BODY = [
  ['Strategic support. Systems oversight.', 'Mission-ready infrastructure.'],
  ['The command deck is your vantage point.', 'We build the systems that power',
   'clarity, control and growth.'],
];

const SERVICES = [
  ['Strategy & Positioning', '#strategy'],
  ['Platform Architecture', '#platform'],
  ['Automation & Integration', '#automation'],
  ['Analytics & Optimization', '#analytics'],
  ['Continuous Command', '#command'],
];

const CSS = `
.AboutDOM {
  position: fixed; inset: 0; z-index: 3; pointer-events: none;
  opacity: 0; transition: opacity .5s ease-out;
  font-family: var(--font);
}
.AboutDOM.on { opacity: 1 }
.AboutDOM.on .AboutServices a { pointer-events: auto }

/* ---- headline block ---- */
.AboutHeadline {
  position: absolute; left: 9.1%; bottom: 31%;
  margin: 0; font-weight: 400; color: #fff;
}
.AboutHeadline b {
  display: block; font-weight: 400;
  /* 10 characters spanning 34% of the reference's width. Sized off vw so the block
     keeps that proportion instead of drifting with viewport height. */
  font-size: clamp(30px, 4.15vw, 78px);
  letter-spacing: 0.035em; line-height: 1;
  text-transform: uppercase;
  /* Barely there. The reference has the faintest lift on the glyph edges -- enough to
     separate them from the nebula behind, not enough to read as a glow. */
  text-shadow: 0 0 22px rgba(214,255,224,0.16);
}
.AboutHeadline i {
  display: block; font-style: normal;
  font-size: clamp(14px, 1.72vw, 32px);
  /* Tracking, not size, is what makes this line finish level with the one above --
     see the note at the top of this file. */
  letter-spacing: 0.30em;
  line-height: 1; margin-top: 0.62em;
  text-transform: uppercase; color: rgba(255,255,255,0.93);
}

/* ---- right column ---- */
.AboutBody {
  position: absolute; left: 72.3%; right: 6.9%; top: 50%;
  transform: translateY(-50%);
}
.AboutBody p {
  margin: 0 0 1.55em; font-size: clamp(10px, 0.78vw, 14px);
  line-height: 1.85; text-transform: uppercase; letter-spacing: 0.055em;
  color: rgba(255,255,255,0.86);
}

/* Rows, not links in a list: the reference gives each one a full-width hairline and
   an arrow pinned to the right edge, which is a grid rather than inline text. */
.AboutServices { margin-top: 2.6em; display: block }
.AboutServices a {
  display: grid; grid-template-columns: 1fr auto; align-items: center;
  padding: 0.72em 0 0.62em;
  border-bottom: 1px solid rgba(255,255,255,0.17);
  font-size: clamp(10px, 0.78vw, 14px); letter-spacing: 0.055em;
  text-transform: uppercase; text-decoration: none;
  color: rgba(255,255,255,0.88); cursor: pointer;
  transition: color .35s ease-out, border-color .35s ease-out;
}
.AboutServices a:first-child { border-top: 1px solid rgba(255,255,255,0.17) }
.AboutServices a span:last-child { opacity: 0.75; transition: transform .35s cubic-bezier(.17,.4,.02,.99) }
.AboutServices a:hover { color: #fff; border-color: rgba(216,255,154,0.55) }
.AboutServices a:hover span:last-child { transform: translateX(5px) }

@media (max-width: 900px) {
  .AboutHeadline { left: 7%; bottom: auto; top: 16% }
  .AboutHeadline b { font-size: 8.4vw }
  .AboutHeadline i { font-size: 3.1vw; letter-spacing: 0.22em }
  .AboutBody { left: 7%; right: 7%; top: auto; bottom: 7%; transform: none }
  .AboutBody p { margin-bottom: 1em; font-size: 11px }
  .AboutServices { margin-top: 1.4em }
  .AboutServices a { padding: 0.5em 0 0.45em; font-size: 11px }
}
`;

export function buildAbout() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'AboutDOM';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <h2 class="AboutHeadline"><b>${HEADLINE}</b><i>${SUBHEAD}</i></h2>
    <div class="AboutBody">
      ${BODY.map(lines => `<p>${lines.join('<br>')}</p>`).join('')}
      <nav class="AboutServices">
        ${SERVICES.map(([label, href]) =>
          `<a href="${href}"><span>/ ${label}</span><span>&#8594;</span></a>`).join('')}
      </nav>
    </div>
  `;
  document.getElementById('Stage').appendChild(root);

  let on = null;

  return {
    root,

    /** Show or hide the layer. Idempotent -- only touches classList on a change. */
    setActive(active) {
      if (active === on) return;
      on = active;
      root.classList.toggle('on', active);
    },

    /**
     * Their per-frame mark transform. Returns rather than writes, so main.js stays
     * the only place the emblem's transform is assigned.
     *
     * @param progress  About's local scroll progress, 0..1
     * @param rotation  accumulated drag rotation (already halved by the caller —
     *                  their About sensitivity is 0.5x the Home value)
     */
    logoTransform(progress, rotation) {
      return {
        y: 6 + ((progress - -1) / 2) * (-2 - 6),                          // range(p, -1, 1, 6, -2)
        rotY: -(200 * Math.PI / 180) * (-0.5 + progress)
              + (60 * Math.PI / 180) + 2 * rotation,
      };
    },
  };
}
