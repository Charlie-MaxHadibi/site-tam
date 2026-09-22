// Limiteur de débit simple, en mémoire : `max` requêtes par `windowMs` et par IP.
// Suffisant pour un service mono-instance ; à remplacer par un store partagé (Redis)
// seulement si le serveur est répliqué.
export function rateLimit({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Purge périodique des entrées expirées (évite que la Map grossisse indéfiniment).
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Trop de requêtes, réessaie dans un instant.' });
    }
    next();
  };
}
