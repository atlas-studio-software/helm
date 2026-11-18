// Position chats (Positions): the small facts the tab strip and the session header show for them. Pure, no imports;
// test/host/position-meta.test.js loads it with require(esm). A position chat's session carries
// position: { company, companyName, id, name, parent, chat } (main/engine/team/wire.js); parent null = reports to the CEO.

// The company chip on a position chat's tab: its company's name, or null for any other session.
export function positionCompany(s) {
  const p = s && s.position;
  if (!p || typeof p !== 'object' || !p.id) return null;
  const n = String(p.companyName || p.company || '').trim();
  return n || null;
}

// Who a position chat reports to, for the header: 'the CEO' (top level), the manager's name when a chat of that
// manager is among `list` (the sessions Helm has), or null (not a position chat, or the manager's name isn't known).
export function positionReportsTo(s, list = []) {
  const p = s && s.position;
  if (!p || typeof p !== 'object' || !p.id) return null;
  if (p.parent == null) return 'the CEO';
  const m = (Array.isArray(list) ? list : []).find((x) => x && x.position && x.position.company === p.company && x.position.id === p.parent && x.position.name);
  return m ? String(m.position.name) : null;
}
