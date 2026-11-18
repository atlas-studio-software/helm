// What an `app.select` event shows (Owner: lane shell; Positions part lane T10). Pure, no imports: state.js wires
// it to the transport and test/host/team-shell.test.js loads it with require(esm).
// - { sessionId }: open that session. The host asks every client to follow (quick-prompt window, notification click);
//   a just-created session may land (session.created) a moment after the event, so it is retried every 200 ms,
//   `tries` times.
// - { view: 'team', company? } with no session: a team notice (main/notify.js handleClick, main/push.js payload)
//   opens the Team view, on that company when one is named.
// Returns what it did: 'team' | 'session' | null.
export function routeSelect(msg, { go, openSession, hasSession, setCompany = null, later = (fn, ms) => setTimeout(fn, ms), tries = 10 } = {}) {
  const { sessionId, view, company } = msg && typeof msg === 'object' ? msg : {};
  if (!sessionId && view === 'team') {
    go('team');
    if (company && setCompany) Promise.resolve().then(() => setCompany(String(company))).catch(() => {});
    return 'team';
  }
  if (!sessionId) return null;
  let n = 0;
  const retry = () => { if (hasSession(sessionId)) openSession(sessionId); else if (n++ < tries) later(retry, 200); };
  retry();
  return 'session';
}
