// Positions: what the team's text calls the person the positions work for (settings team.ownerName). The code ships
// with no one's name in it: an empty or missing name reads "the owner", and "The owner" at the start of a sentence.
//
// Modules take `ownerName` as a string OR a function that returns one (e.g. () => settings().ownerName), and resolve
// it each time they write text, so a change in Settings > Team applies to the next message without a rebuild.
// settings.js already validates the name; this tidies it again because the result lands inside prompt text.

const FALLBACK = 'the owner';
const MAX = 40;

// The configured name, trimmed and made one line of plain text, or '' when none is set (or the getter throws).
function resolveOwnerName(src) {
  let v = src;
  if (typeof v === 'function') { try { v = v(); } catch { v = ''; } }
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX).trim();
}

// { owner, Owner, named }: `owner` for mid-sentence use, `Owner` for the start of a sentence. With a name both are
// the name; without one they are 'the owner' / 'The owner'.
function ownerWords(src) {
  const name = resolveOwnerName(src);
  return name ? { owner: name, Owner: name, named: true } : { owner: FALLBACK, Owner: 'The owner', named: false };
}

module.exports = { ownerWords, resolveOwnerName, OWNER_FALLBACK: FALLBACK };
