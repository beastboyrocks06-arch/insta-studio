import { Router } from 'express';
import crypto from 'node:crypto';
import { cloudinaryConfigured, config } from '../config.js';
import { requireAuth } from '../session.js';

const router = Router();
router.use(requireAuth);

router.post('/signature', (req, res) => {
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ error: 'Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in .env before uploading.' });
  }
  const { resourceType } = req.body || {};
  if (!['image', 'video'].includes(resourceType)) return res.status(400).json({ error: 'Unsupported upload type.' });
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'instagram-publisher';
  const parameters = `folder=${folder}&timestamp=${timestamp}${config.cloudinaryApiSecret}`;
  const signature = crypto.createHash('sha1').update(parameters).digest('hex');
  res.json({
    cloudName: config.cloudinaryCloudName,
    apiKey: config.cloudinaryApiKey,
    timestamp,
    folder,
    signature,
  });
});

export default router;
