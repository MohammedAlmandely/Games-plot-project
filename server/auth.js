const tokenCache = new Map();

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp || 0) * 1000;
  } catch { return 0; }
}

async function verifyFirebaseToken(token) {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.cacheUntil > now) return cached.user;

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_WEB_API_KEY is missing');

  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.users?.[0]?.localId) {
    const err = new Error('INVALID_FIREBASE_TOKEN');
    err.status = 401;
    throw err;
  }

  const u = body.users[0];
  const user = {
    uid: u.localId,
    email: u.email || null,
    displayName: u.displayName || null,
    photoURL: u.photoUrl || null,
    emailVerified: !!u.emailVerified
  };

  const jwtExpiry = tokenExpiry(token) || (now + 2 * 60 * 1000);
  tokenCache.set(token, { user, cacheUntil: Math.min(jwtExpiry - 5000, now + 2 * 60 * 1000) });
  return user;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.auth = await verifyFirebaseToken(header.slice(7));
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(e.status || 401).json({ error: 'INVALID_AUTH_TOKEN' });
  }
}

module.exports = { requireAuth, verifyFirebaseToken };
