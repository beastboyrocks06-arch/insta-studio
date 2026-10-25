import { Router } from 'express';
import crypto from 'node:crypto';
import { authConfigProblems, config, configProblems } from '../config.js';
import { getSession, resetDebug, requireAuth } from '../session.js';
import { authorizationUrl, completeLogin, redact } from '../services/meta.js';

const router = Router();
const STATE_TTL_MS = 10 * 60 * 1000;
const failures = new Map();
const back = (res, params) => res.redirect(`${config.frontendUrl}/?${new URLSearchParams(params)}`);

function secureEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash) && actual === expected;
}

router.get('/status', (req, res) => {
  const s = getSession(req, res);
  res.json({
    authenticated: s.authenticated,
    displayName: config.appUsername || 'Workspace owner',
    authConfigProblems: authConfigProblems(),
    configProblems: configProblems(),
    loginType: config.loginType,
    graphVersion: config.version,
    redirectUri: config.redirectUri,
    requestedScopes: config.scopes,
    accounts: [...s.connections.values()].map((connection) => ({
      username: connection.username,
      id: connection.igUserId,
      permissions: connection.permissions,
      expiresAt: connection.expiresAt,
    })),
  });
});

router.post('/login', (req, res) => {
  const problems = authConfigProblems();
  if (problems.length) return res.status(503).json({ error: `Server not configured: ${problems.join('; ')}` });
  const address = req.ip;
  const record = failures.get(address);
  if (record?.blockedUntil > Date.now()) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string'
    || !secureEqual(username, config.appUsername) || !secureEqual(password, config.appPassword)) {
    const count = (record?.count || 0) + 1;
    failures.set(address, { count, blockedUntil: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  failures.delete(address);
  getSession(req, res).authenticated = true;
  res.json({ ok: true });
});

router.post('/logout', requireAuth, (req, res) => {
  req.appSession.authenticated = false;
  req.appSession.oauth = null;
  req.appSession.connections.clear();
  resetDebug(req.appSession);
  res.json({ ok: true });
});

router.get('/instagram/login', requireAuth, (req, res) => {
  const problems = configProblems();
  if (problems.length) return back(res, { error: `Server not configured: ${problems.join('; ')}` });
  const s = req.appSession;
  const state = crypto.randomBytes(24).toString('base64url');
  s.oauth = { state, expires: Date.now() + STATE_TTL_MS };
  res.redirect(authorizationUrl(state));
});

export async function handleOAuthCallback(req, res) {
  const s = req.appSession;
  const { code, state, error, error_description, error_reason } = req.query;
  const saved = s.oauth;
  s.oauth = null;
  if (error) return back(res, { error: `Authorization cancelled or denied: ${error_description || error_reason || error}` });
  if (!saved || !state || typeof state !== 'string' || saved.state.length !== state.length
      || !crypto.timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))) {
    return back(res, { error: 'Invalid OAuth state (possible CSRF, or the server restarted). Please try again.' });
  }
  if (Date.now() > saved.expires) return back(res, { error: 'Login attempt expired. Please try again.' });
  if (!code) return back(res, { error: 'No authorization code returned.' });
  resetDebug(s);
  try {
    const result = await completeLogin(String(code).replace(/#_$/, ''));
    s.connections.set(String(result.igUserId), { ...result, loginType: config.loginType });
    result.notes.forEach((note) => s.debug.log.push({ t: new Date().toISOString(), msg: note }));
    back(res, { connected: '1' });
  } catch (err) {
    back(res, { error: `${err.stage || 'login'} failed: ${redact(err.message)}` });
  }
}

router.get('/callback', requireAuth, handleOAuthCallback);

router.delete('/accounts/:id', requireAuth, (req, res) => {
  const removed = req.appSession.connections.delete(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Connected account not found' });
  res.json({ ok: true });
});

export default router;
