import { rand } from './rng.js';
// The 14 projects that appear on the Active Theory home spine.
// These are the CMS entries with priority <= 3, which is the exact selection
// rule observed on the live site. Order is shuffled per session, as on the original.
export const PROJECTS = [
  { title: 'PR Engine',              client: 'Cyphernaut',       color: '#8a8bcf', year: '2025', tag: 'platform',     perma: 'pr-engine',
    subhead: 'Automated release orchestration across the delivery pipeline' },
  { title: 'Sustainable Horizons',   client: 'WSJ',              color: '#48bdb5', year: '2023', tag: 'xr, ai',       perma: 'sustainable-horizons',
    subhead: 'Explore a vision of the future created with AI' },
  { title: 'Million Piece Mission',  client: 'U.S. Airforce',    color: '#979793', year: '2020', tag: 'game',         perma: 'million-piece-mission',
    subhead: 'A collaborative virtual puzzle with 1.2 million pieces' },
  { title: 'Prometheus',             client: 'Prometheus Fuels', color: '#765648', year: '2021', tag: 'website',      perma: 'prometheus',
    subhead: 'A stylized interactive story about creating fuel from the air' },
  { title: '20 Years of Xbox',       client: 'Microsoft',        color: '#00c390', year: '2021', tag: 'multiplayer',  perma: 'xbox-museum',
    subhead: '6 3D museums to explore with others' },
  { title: 'Secret Sky',             client: 'Porter Robinson',  color: '#7ccca3', year: '2021', tag: 'multiplayer',  perma: 'secret-sky',
    subhead: 'A virtual music festival with 160,000 attendees' },
  { title: 'Discover your Patronus', client: 'Pottermore',       color: '#1587ce', year: '2016', tag: 'website',      perma: 'discover-your-patronus',
    subhead: 'A visually immersive quiz to discover your Patronus guardian' },
  { title: 'E.C.H.O.',               client: 'U.S. Airforce',    color: '#62777c', year: '2021', tag: 'xr',           perma: 'echo',
    subhead: 'A cinematic WebGL experience testing cognitive skills' },
  { title: 'Frontier Within',        client: 'Thorne',           color: '#77e7e5', year: '2019', tag: 'installation', perma: 'frontier-within',
    subhead: "Captures the participant's body data as a living organism" },
  { title: 'Kandinsky',              client: 'Google',           color: '#ffa147', year: '2015', tag: 'xr',           perma: 'kaninsky-vr',
    subhead: 'Transforms art into music through playful responsive shapes' },
  { title: 'Chile 20',               client: 'Adidas',           color: '#e71407', year: '2020', tag: 'website',      perma: 'chile-20',
    subhead: 'Realistic 3D products for the new CHILE20 collection' },
  { title: 'Harmonic State',         client: 'IBM',              color: '#19a8d9', year: '2021', tag: 'game',         perma: 'harmonic-state',
    subhead: 'Three WebGL levels from dissonance to harmony' },
  { title: 'Welcome to Hogwarts',    client: 'Pottermore',       color: '#80a0a6', year: '2017', tag: 'website',      perma: 'welcome-to-hogwarts',
    subhead: 'An immersive 3D recreation of Hogwarts' },
  { title: 'Racer',                  client: 'Google',           color: '#ec9c30', year: '2014', tag: 'installation', perma: 'racer',
    subhead: 'A multi-device racing experience that syncs in real-time' },
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
