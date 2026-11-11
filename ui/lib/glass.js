// Which synced glass Helm paints and which one the Appearance sliders edit (look-sync CONTRACT "Light look",
// decided 2026-10-14: the light look is un-held). glass.dark in dark, glass.light in light: blur, dim and the panel
// shift alike. A slider preview carries the theme it was made in, so a theme flip mid-drag never files a dark value
// into the light glass (or back). ESM with no imports, so test/host/look.test.js loads it with require(esm).
// Used by ui/shell/state.js (glass) and ui/shell/settings.js (Backgrounds). Owner: lane wk-light.

// Seeds = look-sync SEED (CONTRACT "2026-11-11: sharp painted glass + tint override"): blur 0, dim .30, both themes.
export const SEED_GLASS = { dark: { blurPx: 0, dim: 0.3, panel: 0 }, light: { blurPx: 0, dim: 0.3, panel: 0 } };
// dimAuto (absent = true): moving the Dim slider takes it over (false); the Auto control hands it back (true)
export const GLASS_KEYS = { blur: 'blurPx', dim: 'dim', panel: 'panel', dimAuto: 'dimAuto' };   // preview key -> settings.glass[theme] key
export const BG_KEYS = ['kind', 'file', 'mode'];                               // preview key -> settings.background (per app)

const themeOf = (t) => (t === 'light' ? 'light' : 'dark');
const hasGlass = (o) => Object.keys(o || {}).some((k) => GLASS_KEYS[k]);

/** the preview that applies to `theme` (one made in the other theme does not) */
export function previewFor(pv, theme) {
  const p = pv || {};
  return !p.theme || p.theme === themeOf(theme) ? p : {};
}

/**
 * paintedGlass(settings, theme, preview) -> { theme, blurPx, dim, panel, dimAuto }: the glass painted now.
 * An older host has no glass: its background blur/dim were the one blur/dim it painted in both themes.
 */
export function paintedGlass(st, theme, pv) {
  const t = themeOf(theme);
  const s = st || {};
  const legacy = s.background && s.background.blur != null ? { blurPx: s.background.blur, dim: s.background.dim, panel: 0 } : null;
  const g = (s.glass && s.glass[t]) || legacy || SEED_GLASS[t];
  const p = previewFor(pv, t);
  return { theme: t, blurPx: p.blur ?? g.blurPx, dim: p.dim ?? g.dim, panel: p.panel ?? g.panel ?? 0,
    dimAuto: typeof p.dimAuto === 'boolean' ? p.dimAuto : g.dimAuto !== false };
}

/**
 * a slider / picker change folded into the preview; glass values are stamped with the theme showing.
 * A Dim change without an explicit dimAuto is the user taking the tint over: dimAuto false (CONTRACT 2026-11-11).
 */
export function withPreview(prev, partial, theme) {
  const t = themeOf(theme);
  let base = prev || {};
  if (hasGlass(partial) && base.theme && base.theme !== t) {
    base = Object.fromEntries(Object.entries(base).filter(([k]) => !GLASS_KEYS[k] && k !== 'theme'));
  }
  const took = partial && partial.dim !== undefined && partial.dimAuto === undefined ? { dimAuto: false } : {};
  return { ...base, ...partial, ...took, ...(hasGlass(partial) ? { theme: t } : {}) };
}

/** the settings.set partial for a preview: photo + mode -> background, blur/dim/panel -> glass[preview's theme] */
export function savePartial(snap) {
  const bg = {}, gl = {};
  for (const [k, v] of Object.entries(snap || {})) {
    if (BG_KEYS.includes(k)) bg[k] = v;
    else if (GLASS_KEYS[k]) gl[GLASS_KEYS[k]] = v;
  }
  const partial = {};
  if (Object.keys(bg).length) partial.background = bg;
  if (Object.keys(gl).length) partial.glass = { [themeOf(snap.theme)]: gl };
  return partial;
}
