import { rand } from './rng.js';
/* The 14 cards on the work spine.
 *
 * PLACEHOLDER CONTENT, and deliberately so. These were Active Theory's real
 * client projects -- Google, U.S. Air Force, Microsoft, Pottermore, Adidas,
 * IBM, Porter Robinson, Thorne, WSJ -- carried over while the card layout,
 * shuffle and count were being matched against the reference. That was fine
 * for building and is not fine to ship: a Cyphernaut site listing them reads
 * as claiming another studio's portfolio.
 *
 * Replaced with names drawn from Cyphernaut's own service list (strategy,
 * platform architecture, automation & integration, analytics & optimisation,
 * continuous command). They are invented and should be swapped for the real
 * engagements -- the shape is what matters here: title, client, colour, year,
 * tag, perma, one-line subhead. Count stays at 14 because the spine's card
 * spacing and the camera rail are solved against it.
 */
export const PROJECTS = [
  { title: 'PR Engine',              client: 'Cyphernaut',       color: '#8a8bcf', year: '2025', tag: 'platform',     perma: 'pr-engine',
    subhead: 'Automated release orchestration across the delivery pipeline' },
  { title: 'Signal Deck',            client: 'Cyphernaut',       color: '#48bdb5', year: '2025', tag: 'analytics',    perma: 'signal-deck',
    subhead: 'Live operational telemetry consolidated into one vantage point' },
  { title: 'Relay Grid',             client: 'Cyphernaut',       color: '#979793', year: '2024', tag: 'integration',  perma: 'relay-grid',
    subhead: 'Event routing between systems that were never meant to speak' },
  { title: 'Vantage',                client: 'Cyphernaut',       color: '#765648', year: '2024', tag: 'strategy',     perma: 'vantage',
    subhead: 'Positioning and roadmap work for platform-stage teams' },
  { title: 'Continuous Command',     client: 'Cyphernaut',       color: '#00c390', year: '2025', tag: 'operations',   perma: 'continuous-command',
    subhead: 'Always-on oversight of infrastructure health and spend' },
  { title: 'Meridian',               client: 'Cyphernaut',       color: '#7ccca3', year: '2024', tag: 'architecture', perma: 'meridian',
    subhead: 'Service topology redesigned around clear ownership lines' },
  { title: 'Threshold',              client: 'Cyphernaut',       color: '#1587ce', year: '2023', tag: 'platform',     perma: 'threshold',
    subhead: 'Access and identity unified across a fragmented estate' },
  { title: 'Longwave',               client: 'Cyphernaut',       color: '#62777c', year: '2024', tag: 'analytics',    perma: 'longwave',
    subhead: 'Retention modelling that survives contact with real data' },
  { title: 'Anchorpoint',            client: 'Cyphernaut',       color: '#77e7e5', year: '2023', tag: 'architecture', perma: 'anchorpoint',
    subhead: 'A migration path off legacy without a freeze window' },
  { title: 'Dead Reckoning',         client: 'Cyphernaut',       color: '#ffa147', year: '2025', tag: 'strategy',     perma: 'dead-reckoning',
    subhead: 'Forecasting capacity when the historical data is thin' },
  { title: 'Fathom',                 client: 'Cyphernaut',       color: '#e71407', year: '2024', tag: 'analytics',    perma: 'fathom',
    subhead: 'Cost attribution traced to the teams that generate it' },
  { title: 'Waypoint',               client: 'Cyphernaut',       color: '#19a8d9', year: '2023', tag: 'integration',  perma: 'waypoint',
    subhead: 'Partner onboarding reduced from quarters to days' },
  { title: 'Standing Order',         client: 'Cyphernaut',       color: '#80a0a6', year: '2025', tag: 'operations',   perma: 'standing-order',
    subhead: 'Runbooks that execute themselves and report when they cannot' },
  { title: 'Trueline',               client: 'Cyphernaut',       color: '#ec9c30', year: '2024', tag: 'platform',     perma: 'trueline',
    subhead: 'One deployment path for every service in the estate' },
];

// Fisher-Yates, matching the original's per-session shuffle of the same fixed set.
export function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
