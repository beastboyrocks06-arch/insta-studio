import { Router } from 'express';
import { config } from '../config.js';
import { log, requireAuth, resetDebug } from '../session.js';
import { findAccounts, getPublishedPosts, recordPublishedPost } from '../db.js';
import {
  createCarouselContainer,
  createCarouselItem,
  createImageContainer,
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  publishContainer,
  redact,
} from '../services/meta.js';

const router = Router();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const csvHeader = 'date,account,mediaType,postUrl,mediaId\r\n';
const publishingSessions = new Set();
router.use(requireAuth);

function escapeCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function validatePublicMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Each media URL must be valid.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Each media URL must use http(s) and cannot contain credentials.');
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Instagram needs a publicly accessible media URL.');
  }
  return url.toString();
}

async function waitForContainer(session, connection, containerId) {
  const deadline = Date.now() + config.pollMaxMs;
  while (true) {
    const status = await getContainerStatus(connection, containerId);
    session.debug.processing = status.status_code;
    log(session, `Container ${containerId} status: ${status.status_code}${status.status ? ` (${status.status})` : ''}`);
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw Object.assign(new Error(`Instagram processing ended with ${status.status_code}${status.status ? `: ${status.status}` : ''}`), { stage: 'processing' });
    }
    if (Date.now() > deadline) throw Object.assign(new Error('Timed out waiting for Instagram to process the media'), { stage: 'processing' });
    await sleep(config.pollIntervalMs);
  }
}

async function createContainer(connection, mediaType, mediaUrls, caption, session) {
  if (mediaType === 'REELS') return createReelContainer(connection, mediaUrls[0], caption);
  if (mediaType === 'IMAGE') return createImageContainer(connection, mediaUrls[0], caption);
  const childIds = [];
  for (const mediaUrl of mediaUrls) {
    const child = await createCarouselItem(connection, mediaUrl, 'IMAGE');
    childIds.push(child.id);
    await waitForContainer(session, connection, child.id);
  }
  return createCarouselContainer(connection, childIds, caption);
}

router.get('/debug', (req, res) => res.json(req.appSession.debug));

router.get('/history.csv', async (req, res, next) => {
  try {
    const posts = await getPublishedPosts();
    const csv = [csvHeader.trimEnd(), ...posts.map((post) => [
      post.date instanceof Date ? post.date.toISOString() : post.date,
      post.account,
      post.mediaType,
      post.postUrl,
      post.mediaId,
    ].map(escapeCsv).join(','))].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="instagram-published-posts.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.post('/publish', async (req, res, next) => {
  const session = req.appSession;
  if (publishingSessions.has(session.sid)) return res.status(409).json({ error: 'A publish is already in progress' });
  const { mediaType, mediaUrls, caption = '', accountIds } = req.body || {};
  if (!['REELS', 'IMAGE', 'CAROUSEL'].includes(mediaType)) return res.status(400).json({ error: 'Choose Reel, Image, or Carousel.' });
  if (!Array.isArray(mediaUrls) || !Array.isArray(accountIds) || !accountIds.length) {
    return res.status(400).json({ error: 'Select media and at least one Instagram account.' });
  }
  if ((mediaType === 'CAROUSEL' && (mediaUrls.length < 2 || mediaUrls.length > 10))
      || (mediaType !== 'CAROUSEL' && mediaUrls.length !== 1)) {
    return res.status(400).json({ error: mediaType === 'CAROUSEL' ? 'A carousel needs 2–10 images.' : 'Choose exactly one media file.' });
  }
  if (String(caption).length > 2200) return res.status(400).json({ error: 'Caption exceeds 2200 characters.' });
  if (new Set(accountIds).size !== accountIds.length) return res.status(400).json({ error: 'An account can only be selected once.' });

  let urls;
  try { urls = mediaUrls.map(validatePublicMediaUrl); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  let connections;
  try {
    const byId = new Map((await findAccounts(accountIds)).map((connection) => [connection.igUserId, connection]));
    connections = accountIds.map((id) => byId.get(String(id)));
  } catch (error) {
    return next(error);
  }
  if (connections.some((connection) => !connection)) return res.status(400).json({ error: 'One or more selected accounts are no longer connected. Refresh and try again.' });

  publishingSessions.add(session.sid);
  resetDebug(session);
  const results = [];
  try {
    for (const connection of connections) {
      const result = { accountId: connection.igUserId, username: connection.username, mediaType, ok: false, postUrl: '', mediaId: '', error: '' };
      try {
        session.debug.stage = 'creating_container';
        log(session, `Creating ${mediaType} for @${connection.username}`);
        const { id: containerId } = await createContainer(connection, mediaType, urls, String(caption), session);
        log(session, `Container created: ${containerId}`);
        session.debug.stage = 'processing';
        await waitForContainer(session, connection, containerId);
        session.debug.stage = 'publishing';
        const published = await publishContainer(connection, containerId);
        result.mediaId = published.id;
        result.ok = true;
        session.debug.stage = 'published';
        try {
          const media = await getMediaPermalink(connection, published.id);
          result.postUrl = media.permalink || '';
        } catch (error) {
          log(session, `Could not retrieve permalink for @${connection.username}: ${redact(error.message)}`);
        }
        try {
          const record = await recordPublishedPost(result);
          result.date = record.publishedAt instanceof Date ? record.publishedAt.toISOString() : record.publishedAt;
        } catch (error) {
          result.error = `Published, but failed to save the post in Neon: ${redact(error.message)}`;
          log(session, result.error);
        }
        log(session, `Published @${connection.username}: ${result.postUrl || `media ${result.mediaId}`}`);
      } catch (error) {
        result.error = redact(error.message);
        session.debug.stage = 'failed';
        session.debug.error = result.error;
        log(session, `Publish failed for @${connection.username}: ${result.error}`);
      }
      results.push(result);
    }
    session.debug.result = results.map(({ username, ok, mediaId, postUrl, error }) => ({ username, ok, mediaId, postUrl, error }));
    res.json({ ok: results.every((result) => result.ok), results });
  } catch (error) {
    next(error);
  } finally {
    publishingSessions.delete(session.sid);
  }
});

export default router;
