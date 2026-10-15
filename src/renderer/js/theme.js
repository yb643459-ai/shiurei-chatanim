// ערכת צבעים של Material Design 3 מ-seed אחד, בהירה/כהה/לפי המערכת.
import { argbFromHex, hexFromArgb, Hct, SchemeTonalSpot, MaterialDynamicColors } from '@material/material-color-utilities';

const SEED = '#2f5fa8';
const kebab = s => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const entries = Object.getOwnPropertyNames(MaterialDynamicColors)
  .filter(k => MaterialDynamicColors[k] && typeof MaterialDynamicColors[k].getArgb === 'function');

function schemeVars(dark) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(SEED)), dark, 0);
  const vars = {};
  for (const k of entries) vars['--md-sys-color-' + kebab(k)] = hexFromArgb(MaterialDynamicColors[k].getArgb(scheme));
  return vars;
}

const mq = window.matchMedia('(prefers-color-scheme: dark)');
let mode = 'system';

function apply() {
  const dark = mode === 'dark' || (mode === 'system' && mq.matches);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(schemeVars(dark))) root.style.setProperty(k, v);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export const Theme = {
  init() {
    try { mode = localStorage.getItem('sc-theme-mode') || 'system'; } catch {}
    mq.addEventListener('change', () => { if (mode === 'system') apply(); });
    apply();
  },
  get mode() { return mode; },
  set(m) { mode = m; try { localStorage.setItem('sc-theme-mode', m); } catch {} apply(); },
  cycle() { this.set(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'); return mode; }
};
