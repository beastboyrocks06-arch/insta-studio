import crypto from 'node:crypto';
import { findSession, removeSession, saveSession, sessionCookieOptions } from './db.js';

const freshDebug = () => ({ stage: 'idle', processing: null, log: [], result: null, error: null });

export async function getSession(req, res) {
  let sid = req.cookies?.sid;
  let session = sid ? await findSession(sid) : null;
  if (!session) {
    sid = crypto.randomBytes(32).toString('base64url');
    session = { sid, authenticated: false, oauth: null, debug: freshDebug() };
    await saveSession(session);
    res.cookie('sid', sid, sessionCookieOptions());
  }
  return session;
}

export async function replaceSession(req, res, session) {
  await removeSession(session.sid);
  const sid = crypto.randomBytes(32).toString('base64url');
  const authenticated = { sid, authenticated: true, oauth: null, debug: freshDebug() };
  await saveSession(authenticated);
  res.cookie('sid', sid, sessionCookieOptions());
  return authenticated;
}

export function resetDebug(session) { session.debug = freshDebug(); }
export function log(session, message) { session.debug.log.push({ t: new Date().toISOString(), msg: message }); }

export function requireAuth(req, res, next) {
  getSession(req, res).then((session) => {
    if (!session.authenticated) return res.status(401).json({ error: 'Authentication required' });
    req.appSession = session;
    next();
  }).catch(next);
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
