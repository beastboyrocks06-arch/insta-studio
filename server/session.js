import crypto from 'node:crypto';
// In-memory only: everything here is lost when the server restarts.
const sessions = new Map();
const freshDebug = () => ({ stage: 'idle', processing: null, log: [], result: null, error: null });

export function getSession(req, res) {
  let sid = req.cookies?.sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { authenticated: false, oauth: null, connections: new Map(), debug: freshDebug(), busy: false });
    res.cookie('sid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 3600 * 1000,
    });
  }
  return sessions.get(sid);
}
export function resetDebug(s) { s.debug = freshDebug(); }
export function log(s, msg) { s.debug.log.push({ t: new Date().toISOString(), msg }); }
export function requireAuth(req, res, next) {
  const session = getSession(req, res);
  if (!session.authenticated) return res.status(401).json({ error: 'Authentication required' });
  req.appSession = session;
  next();
}
