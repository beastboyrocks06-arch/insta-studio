
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, configProblems } from './config.js';
import authRoutes, { handleOAuthCallback } from './routes/auth.js';
import instagramRoutes from './routes/instagram.js';
import mediaRoutes from './routes/media.js';
import { asyncRoute, requireAuth } from './session.js';
import { initializeDatabase } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.get('/api/ig/callback', requireAuth, asyncRoute(handleOAuthCallback));
app.use('/api/instagram', instagramRoutes);
app.use('/api/media', mediaRoutes);

// API fallback
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error.code || error.name);
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  res.status(status).json({
    error: status === 500 ? 'Request failed. Check server configuration and logs.' : error.message,
  });
});

// Serve the React build in production
if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../client/dist'
  );

  app.use(express.static(dist));

  // React frontend fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

initializeDatabase().then(() => {
  app.listen(config.port, () => {
    console.log(
      `Server on ${config.backendUrl} (login type: ${config.loginType}, Graph ${config.version})`
    );

    const p = configProblems();
    if (p.length) {
      console.warn('Configuration problems:\n - ' + p.join('\n - '));
    }
  });
}).catch((error) => {
  console.error(
    config.databaseUrl
      ? `Unable to initialize Neon database: ${error.code || error.name}`
      : 'Unable to initialize Neon database: DATABASE_URL is missing. Add the Neon connection string to the server environment.',
  );
  process.exitCode = 1;
});
