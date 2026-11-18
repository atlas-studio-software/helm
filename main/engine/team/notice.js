// Positions: build a team `notify` event (desktop toast and phone push). Every team notice goes through
// main/notify.js teamNotice, so the in-app toast and the push get the same proper title ("Legal needs your OK",
// "Finance: Rent check is done"), never a bare position name.
//
//   teamEvent({ what, company: { id, name }, position: { id, name }, subject?, action?, detail?, sessionId? })
//   -> { kind: 'waiting', source: 'team', title, body, sessionId?, company, view?, team: { what, company, position,
//        companyName, positionName, subject, action } }
//   what: 'access' | 'outward' | 'proposal' | 'duty' | 'duty-failed'; subject: the duty's name or the proposal's
//   target; action (proposals only): 'create' | 'edit' | 'retire' | 'company'.
//   `company` (top level) is the company id; `view: 'team'` is added when there is no sessionId, so a click opens
//   the Team view on that company instead of a chat.

const { teamNotice } = require('../../notify');

function teamEvent({ what, company, position, subject, action, detail, sessionId } = {}) {
  const co = company && typeof company === 'object' ? company : {};
  const pos = position && typeof position === 'object' ? position : {};
  const n = teamNotice({
    what, position: { id: pos.id, name: pos.name }, company: { id: co.id, name: co.name },
    ...(detail != null ? { detail } : {}), ...(subject != null ? { title: subject } : {}),
    ...(action != null ? { action } : {}), ...(sessionId ? { sessionId } : {}),
  });
  const cid = co.id != null ? String(co.id) : null;
  return { ...n, company: cid, ...(n.sessionId ? {} : { view: 'team' }) };
}

module.exports = { teamEvent };
