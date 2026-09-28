import { handle } from '../../server/routes.js';

export default (req, context) => handle(req, context);

// Serves every /api/* path (Netlify Functions v2 — no redirect rules needed).
export const config = { path: '/api/*' };
