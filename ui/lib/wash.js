// The one tint (look-sync CONTRACT "2026-11-11: sharp painted glass + tint override"): the wash alpha (--bg-dim) Helm
// lays over the sharp painted picture on EVERY screen (Home included: no scrim of its own), so the Dim the user sets
// controls all of it. The rule is look-sync's washAlpha (vendored into ui/lib/look-pure.js, the same code Quartz and
// Mantle run): Manual (glass.<theme>.dimAuto false) = exactly Dim; Automatic (absent / true) = max(Dim,
// desktop.guard.<theme>.alpha) when Mantle's top band is valid, else Dim, with the reason. Never silent: the result's
// `text` is the Settings > Appearance row. ESM with one sibling import, so test/host/look.test.js loads it with
// require(esm). Owner: lane look-helm (sharp glass).
import { washAlpha } from './look-pure.js';

// own picture: Mantle's top band describes the desktop still, not the photo Helm paints instead
export const OWN_PICTURE = 'your own picture shows, so Mantle\'s top band for the desktop does not apply';
export const NO_HOST_RECORD = "Helm's host has not passed on Mantle's desktop record (an older host)";

/**
 * washFor(g, mode, desktop)
 *   g: the glass painted now { theme: 'dark'|'light', dim, blurPx, dimAuto } (ui/lib/glass.js paintedGlass, previews in)
 *   mode: background.mode ('desktop' | 'own')
 *   desktop: LookState.desktop from the host ({ record, unusable, ... }: main/look.js washInputs), or null
 * -> washAlpha's { alpha, mode: 'auto'|'manual', raised, reason, dim, contrast, text }
 */
export function washFor(g, mode, desktop) {
  const t = g && g.theme === 'light' ? 'light' : 'dark';
  const look = { glass: { [t]: { dim: g?.dim, blurPx: g?.blurPx, ...(g?.dimAuto === false ? { dimAuto: false } : {}) } } };
  let unusable = null;
  if (mode !== 'desktop') unusable = OWN_PICTURE;
  else if (!desktop) unusable = "Helm hasn't heard from its host which desktop picture shows yet";
  else if (desktop.unusable) unusable = desktop.unusable;
  else if (desktop.record === undefined) unusable = NO_HOST_RECORD;
  return washAlpha(look, desktop ? desktop.record ?? null : null, t, unusable ? { unusable } : undefined);
}
