
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, configProblems } from './config.js';
import authRoutes, { handleOAuthCallback } from './routes/auth.js';
import instagramRoutes from './routes/instagram.js';
import mediaRoutes from './routes/media.js';
import { requireAuth } from './session.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.get('/api/ig/callback', requireAuth, handleOAuthCallback);
app.use('/api/instagram', instagramRoutes);
app.use('/api/media', mediaRoutes);

// API fallback
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
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

app.listen(config.port, () => {
  console.log(
    `Server on ${config.backendUrl} (login type: ${config.loginType}, Graph ${config.version})`
  );

  const p = configProblems();
  if (p.length) {
    console.warn('Configuration problems:\n - ' + p.join('\n - '));
  }
});
