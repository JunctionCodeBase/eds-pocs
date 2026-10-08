/*
 * ADC Form — LOCAL demo proxy (the EDS equivalent of AEM's FormSubmitServlet).
 *
 * WHY THIS EXISTS
 *   A browser can never call the ESL API directly (the secret would leak and CORS
 *   blocks it) — exactly why AEM uses a server-side servlet. This tiny Node server
 *   is that server-side component for a LOCAL demo: the block posts here, and THIS
 *   process (not the browser) calls the Abbott API with the secret added.
 *
 * LOCAL ONLY — no public tunnel. Run it on localhost and drive it from the local
 * EDS dev server (also http://localhost) so there is no mixed-content and nothing
 * is ever exposed to the internet.
 *
 * RUN
 *   API_SECRET_KEY=<the-secret> node tools/form-proxy/server.mjs
 *   (type the secret directly in the terminal — never commit it)
 *
 * Then set the ADC Form block's "Proxy Endpoint URL" to:
 *   http://localhost:3030/api/form-submit
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 3030;

// Hardcoded for the demo (server-side, so it is safe). Override with API_DOMAIN.
const API_DOMAIN = process.env.API_DOMAIN || 'https://dev2.services.abbott';

// The secret header the ESL API expects. Value comes ONLY from the environment.
const SECRET_HEADER = process.env.SECRET_HEADER || 'x-secret-header';
const SECRET_VALUE = process.env.API_SECRET_KEY || '';

// Context headers the Abbott API expects. Set server-side (the AEM OSGi-config
// equivalent) so the browser never has to supply them and the forwarded request
// matches the Postman call exactly. Override any of them via env.
const APP_ID = process.env.APP_ID || 'eabbott';
const COUNTRY_CODE = process.env.COUNTRY_CODE || 'US';
const LANGUAGE = process.env.LANGUAGE || 'en_US';
const RELOAD_CONFIG = process.env.RELOAD_CONFIG || 'true';

// Mirrors the AEM "Abbott Enterprise Service API" OSGi config (key::path).
// The block sends a KEY as x-form-type; the servlet resolves it to a path.
const ENDPOINTS = {
  siteSearch: '/api/public/search/sitesearch',
  querySuggest: '/api/public/search/querySuggest',
  securedSiteSearch: '/api/private/search/sitesearch',
  securedQuerySuggest: '/api/private/search/querySuggest',
  geolocation: '/api/public/lookup/geolocation',
  sessionApi: '/api/private/profile/session',
  searchRegisterApi: '/api/public/event/registercontentevent',
};

// Accept either a known key or a raw relative path (leading slash).
const resolvePath = (formType) => {
  if (!formType) return null;
  if (formType.startsWith('/')) return formType;
  return ENDPOINTS[formType] || null;
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => resolve(data));
});

const sendJson = (res, status, obj, origin) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-form-type, x-application-id, x-country-code, x-preferred-language, x-reload-config, g-recaptcha-response',
  });
  res.end(JSON.stringify(obj));
};

// Forwards the browser submission to the real Abbott API, adding the secret + domain.
async function handleSubmit(req, res, origin) {
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

  const formType = req.headers['x-form-type'] || '';
  const relPath = resolvePath(formType);
  if (!relPath) {
    // eslint-disable-next-line no-console
    console.warn(`[proxy] unknown x-form-type "${formType}" — expected a path or one of: ${Object.keys(ENDPOINTS).join(', ')}`);
    sendJson(res, 400, {
      ok: false,
      error: `Unknown form type: "${formType}". Use a relative path or a known key.`,
      knownKeys: Object.keys(ENDPOINTS),
    }, origin);
    return;
  }
  const targetUrl = `${API_DOMAIN}${relPath}`;

  const outHeaders = {
    'Content-Type': 'application/json',
    // Context headers are set server-side (never trusted from the browser) so the
    // forwarded request matches the Postman call exactly.
    'x-application-id': APP_ID,
    'x-country-code': COUNTRY_CODE,
    'x-preferred-language': LANGUAGE,
    'x-reload-config': RELOAD_CONFIG,
    // The secret is added HERE, server-side — never in the browser.
    ...(SECRET_VALUE ? { [SECRET_HEADER]: SECRET_VALUE } : {}),
  };

  // Console proof for the demo: the browser request carried no secret; the proxy adds it.
  // eslint-disable-next-line no-console
  console.log(`[proxy] → POST ${targetUrl}  (${SECRET_HEADER}=${SECRET_VALUE ? 'present' : 'MISSING'})`);

  try {
    const apiRes = await fetch(targetUrl, {
      method: 'POST',
      headers: outHeaders,
      body: JSON.stringify(body),
    });
    const text = await apiRes.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    // eslint-disable-next-line no-console
    console.log(`[proxy] ← ${apiRes.status} from ${targetUrl}`);
    sendJson(res, apiRes.ok ? 200 : apiRes.status, {
      ok: apiRes.ok, status: apiRes.status, endpoint: formType, response: payload,
    }, origin);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[proxy] ✗ ${targetUrl}: ${err.message}`);
    sendJson(res, 502, { ok: false, error: err.message, endpoint: formType }, origin);
  }
}

const serverInstance = createServer(async (req, res) => {
  const origin = req.headers.origin || '*';

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}, origin); return; }

  if (req.method === 'POST' && req.url?.startsWith('/api/form-submit')) {
    await handleSubmit(req, res, origin);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' }, origin);
});

serverInstance.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`form-proxy (LOCAL demo) listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  → forwards POST /api/form-submit to ${API_DOMAIN}<x-form-type>`);
  // eslint-disable-next-line no-console
  console.log(`  → secret header: ${SECRET_HEADER} (${SECRET_VALUE ? 'set' : 'NOT set — export API_SECRET_KEY'})`);
});
