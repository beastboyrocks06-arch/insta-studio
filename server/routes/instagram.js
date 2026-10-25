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

function parseDateFilter(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('Dates must use YYYY-MM-DD format.'), { status: 400 });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('Enter a valid calendar date.'), { status: 400 });
  }
  return value;
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
    const from = parseDateFilter(req.query.from);
    const to = parseDateFilter(req.query.to);
    if (from && to && from > to) {
      return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    }
    const posts = await getPublishedPosts(from, to);
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
  const { mediaType, mediaUrls, videos, caption = '', accountIds } = req.body || {};
  if (!['REELS', 'IMAGE', 'CAROUSEL'].includes(mediaType)) return res.status(400).json({ error: 'Choose Reels, Image, or Carousel.' });
  const hasVideoAssignments = mediaType === 'REELS' && videos !== undefined;
  let urls = [];
  let assignments = [];
  let requestedAccountIds = [];
  if (hasVideoAssignments) {
    if (!Array.isArray(videos) || videos.length < 1 || videos.length > 5) {
      return res.status(400).json({ error: 'Choose between 1 and 5 videos.' });
    }
    try {
      assignments = videos.map((video, index) => {
        if (!video || typeof video.mediaUrl !== 'string' || !Array.isArray(video.accountIds) || !video.accountIds.length
          || video.accountIds.some((id) => typeof id !== 'string' || !id.trim())) {
          throw new Error(`Assign video ${index + 1} to at least one Instagram account.`);
        }
        if (new Set(video.accountIds).size !== video.accountIds.length) {
          throw new Error(`An account can only be selected once for video ${index + 1}.`);
        }
        return {
          mediaIndex: index + 1,
          mediaUrl: validatePublicMediaUrl(video.mediaUrl),
          accountIds: video.accountIds,
        };
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    requestedAccountIds = [...new Set(assignments.flatMap((video) => video.accountIds))];
  } else {
    if (!Array.isArray(mediaUrls) || !Array.isArray(accountIds) || !accountIds.length) {
      return res.status(400).json({ error: 'Select media and at least one Instagram account.' });
    }
    if ((mediaType === 'CAROUSEL' && (mediaUrls.length < 2 || mediaUrls.length > 10))
      || (mediaType === 'REELS' && (mediaUrls.length < 1 || mediaUrls.length > 5))
      || (mediaType === 'IMAGE' && mediaUrls.length !== 1)) {
      const error = mediaType === 'CAROUSEL' ? 'A carousel needs 2–10 images.'
        : mediaType === 'REELS' ? 'Choose between 1 and 5 videos.'
          : 'Choose exactly one image.';
      return res.status(400).json({ error });
    }
    if (accountIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ error: 'Select valid Instagram accounts.' });
    }
    if (new Set(accountIds).size !== accountIds.length) return res.status(400).json({ error: 'An account can only be selected once.' });
    try { urls = mediaUrls.map(validatePublicMediaUrl); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    requestedAccountIds = accountIds;
  }
  if (String(caption).length > 2200) return res.status(400).json({ error: 'Caption exceeds 2200 characters.' });

  let connections;
  try {
    const byId = new Map((await findAccounts(requestedAccountIds)).map((connection) => [connection.igUserId, connection]));
    connections = requestedAccountIds.map((id) => byId.get(String(id)));
  } catch (error) {
    return next(error);
  }
  if (connections.some((connection) => !connection)) return res.status(400).json({ error: 'One or more selected accounts are no longer connected. Refresh and try again.' });
  const connectionsById = new Map(connections.map((connection) => [connection.igUserId, connection]));
  const jobs = hasVideoAssignments
    ? assignments.flatMap((video) => video.accountIds.map((accountId) => ({
      connection: connectionsById.get(accountId),
      mediaIndex: video.mediaIndex,
      mediaUrls: [video.mediaUrl],
    })))
    : connections.flatMap((connection) => (mediaType === 'REELS' ? urls.map((url) => [url]) : [urls])
      .map((postUrls, index) => ({ connection, mediaIndex: index + 1, mediaUrls: postUrls })));

  publishingSessions.add(session.sid);
  resetDebug(session);
  const results = [];
  try {
    for (const { connection, mediaIndex, mediaUrls } of jobs) {
      const result = {
        accountId: connection.igUserId,
        username: connection.username,
        mediaType,
        mediaIndex,
        ok: false,
        postUrl: '',
        mediaId: '',
        error: '',
      };
      try {
        session.debug.stage = 'creating_container';
        log(session, `Creating ${mediaType}${mediaType === 'REELS' ? ` video ${mediaIndex}` : ''} for @${connection.username}`);
        const { id: containerId } = await createContainer(connection, mediaType, mediaUrls, String(caption), session);
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
