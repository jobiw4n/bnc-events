/**
 * Bucks Nonprofit Connection — events calendar Worker
 *
 * Routes:
 *   GET  /api/config   public front-end config (Turnstile site key)
 *   GET  /api/events   cached event JSON from Apps Script
 *   POST /api/submit   validates, proxies to Apps Script doPost, purges cache
 *   POST /api/purge    secret-gated cache purge (call from Apps Script after
 *                      manual sheet edits)
 *   everything else    static assets from ./public
 *
 * Secrets (wrangler secret put ... , or the dashboard):
 *   APPS_SCRIPT_URL      the /exec URL
 *   APPS_SCRIPT_SECRET   must match CONFIG.SHARED_SECRET in Code.gs
 *   TURNSTILE_SECRET     optional; verification is skipped when unset
 */

const CACHE_KEY = 'events:v1';
const CACHE_TTL = 86400                       // seconds
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;      // base64 inflates ~33%
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
];

const REQUIRED_FIELDS = [
  'Event Name', 'Organizer Name', 'Organizer Phone', 'Organizer Email',
  'Start Date', 'Event Type', 'Location Name', 'Description', 'Cost',
];

const ALLOWED_FIELDS = [
  'Event Name', 'Organizer Name', 'Organizer Phone', 'Organizer Email',
  'Start Date', 'Start Time', 'End Date', 'End Time', 'Event Type',
  'Expected Attendance', 'Location Name', 'Location Address',
  'Location City State Zip', 'Location Phone', 'Description', 'Cost',
  'Website', 'Comments for BNC','Submitted By',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/config') return handleConfig(env);
      if (url.pathname === '/api/events') return handleEvents(request, env, ctx);
      if (url.pathname === '/api/submit') return handleSubmit(request, env);
      if (url.pathname === '/api/purge') return handlePurge(request, env);
    } catch (err) {
      return json({ ok: false, error: 'Server error.' }, 500);
    }

    return env.ASSETS.fetch(request);
  },
};

/* ----------------------------------------------------------------- config */

function handleConfig(env) {
  return json({
    ok: true,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
  });
}

/* ----------------------------------------------------------------- events */

async function handleEvents(request, env, ctx) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);

  const kv = env.EVENTS_CACHE;

  if (kv) {
    const cached = await kv.get(CACHE_KEY);
    if (cached) {
      return new Response(cached, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
          'x-cache': 'HIT',
        },
      });
    }
  }

  const upstream = await fetch(env.APPS_SCRIPT_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!upstream.ok) {
    return json({ ok: false, error: 'Calendar source unavailable.' }, 502);
  }

  const body = await upstream.text();

  // Don't cache a malformed upstream response — that would pin the failure
  // in place for the full TTL.
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return json({ ok: false, error: 'Calendar source returned invalid data.' }, 502);
  }
  if (!parsed.ok) {
    return json({ ok: false, error: 'Calendar source reported an error.' }, 502);
  }

  if (kv) {
    ctx.waitUntil(kv.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL }));
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'x-cache': 'MISS',
    },
  });
}

/* ----------------------------------------------------------------- submit */

async function handleSubmit(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'Submission is too large.' }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return json({ ok: false, error: 'Malformed submission.' }, 400);
  }

  // Honeypot: a real browser leaves this empty, bots fill every field.
  if (payload.website2) {
    return json({ ok: true, id: 'ignored' });
  }

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(
      env.TURNSTILE_SECRET,
      payload.turnstileToken,
      request.headers.get('cf-connecting-ip')
    );
    if (!ok) return json({ ok: false, error: 'Verification failed. Please try again.' }, 403);
  }

  const event = {};
  const incoming = payload.event || {};
  for (const key of ALLOWED_FIELDS) {
    event[key] = typeof incoming[key] === 'string'
      ? incoming[key].trim().slice(0, 5000)
      : '';
  }

  const missing = REQUIRED_FIELDS.filter((k) => !event[k]);
  if (missing.length) {
    return json({ ok: false, error: 'Missing required fields: ' + missing.join(', ') + '.' }, 400);
  }

  const type = event['Event Type'].toLowerCase();
  if (!['in-person', 'virtual', 'hybrid'].includes(type)) {
    return json({ ok: false, error: 'Event Type must be In-Person, Virtual, or Hybrid.' }, 400);
  }
  // if ((type === 'in-person' || type === 'hybrid') && !event['Location Address']) {
  //   return json({ ok: false, error: 'A location address is required for in-person and hybrid events.' }, 400);
  // }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event['Start Date'])) {
    return json({ ok: false, error: 'Start Date must be YYYY-MM-DD.' }, 400);
  }

  let image = null;
  if (payload.image && payload.image.dataBase64) {
    if (!ALLOWED_IMAGE_TYPES.includes(payload.image.mimeType)) {
      return json({ ok: false, error: 'Image must be JPG, PNG, GIF, or WEBP.' }, 400);
    }
    // base64 length * 3/4 approximates the decoded byte count.
    if (payload.image.dataBase64.length * 0.75 > MAX_IMAGE_BYTES) {
      return json({ ok: false, error: 'Image exceeds the 5 MB limit.' }, 413);
    }
    image = {
      name: String(payload.image.name || 'event-image').slice(0, 120),
      mimeType: payload.image.mimeType,
      dataBase64: payload.image.dataBase64,
    };
  }

  const upstream = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, event, image }),
  });

  const text = await upstream.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    return json({ ok: false, error: 'The calendar service returned an unexpected response.' }, 502);
  }

  if (!result.ok) {
    return json({ ok: false, error: result.error || 'Submission was rejected.' }, 400);
  }

  if (env.EVENTS_CACHE) {
    await env.EVENTS_CACHE.delete(CACHE_KEY);
  }

  return json({ ok: true, id: result.id });
}

/* ------------------------------------------------------------------ purge */

async function handlePurge(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  const auth = request.headers.get('x-purge-secret');
  if (!env.APPS_SCRIPT_SECRET || auth !== env.APPS_SCRIPT_SECRET) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  if (env.EVENTS_CACHE) await env.EVENTS_CACHE.delete(CACHE_KEY);
  return json({ ok: true });
}

/* ---------------------------------------------------------------- helpers */

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form }
  );
  const data = await res.json();
  return data.success === true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}