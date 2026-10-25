import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const e = process.env;
const DEFAULT_SCOPES = {
  instagram: 'instagram_business_basic,instagram_business_content_publish',
  facebook: 'pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish',
};
const loginType = (e.META_LOGIN_TYPE || 'instagram').toLowerCase();

export const config = {
  port: Number(e.PORT || 5000),
  frontendUrl: e.FRONTEND_URL || 'http://localhost:5173',
  backendUrl: e.BACKEND_URL || 'http://localhost:5000',
  appId: e.META_APP_ID,
  appSecret: e.META_APP_SECRET,
  appUsername: e.APP_USERNAME,
  appPassword: e.APP_PASSWORD,
  cloudinaryCloudName: e.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: e.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: e.CLOUDINARY_API_SECRET,
  redirectUri: e.META_REDIRECT_URI || 'http://localhost:5000/api/auth/callback',
  loginType,
  version: e.META_GRAPH_API_VERSION || 'v21.0',
  scopes: (e.META_SCOPES || DEFAULT_SCOPES[loginType] || '').split(',').map((s) => s.trim()).filter(Boolean),
  pollIntervalMs: 5000,
  pollMaxMs: 5 * 60 * 1000,
};

// Returns a list of problems (variable NAMES only, never values).
export function configProblems() {
  const p = [];
  if (!config.appId) p.push('META_APP_ID is missing');
  if (!config.appSecret) p.push('META_APP_SECRET is missing');
  if (!DEFAULT_SCOPES[config.loginType]) p.push('META_LOGIN_TYPE must be "instagram" or "facebook"');
  else {
    const igScopes = config.scopes.some((s) => s.startsWith('instagram_business_'));
    if (config.loginType === 'instagram' && !igScopes) p.push('Instagram Login needs instagram_business_* scopes in META_SCOPES');
    if (config.loginType === 'facebook' && igScopes) p.push('Facebook Login cannot use instagram_business_* scopes');
  }
  return p;
}

export function authConfigProblems() {
  const problems = [];
  if (!config.appUsername) problems.push('APP_USERNAME is missing');
  if (!config.appPassword) problems.push('APP_PASSWORD is missing');
  return problems;
}

export function cloudinaryConfigured() {
  return Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);
}
