// Optional Cloudflare Worker proxy for My Commute.
// Use it only if the app shows "browser blocked the request (CORS)", or if you
// don't want your API key stored on your phone.
//
// Setup (free): dash.cloudflare.com -> Workers & Pages -> Create Worker -> paste
// this file -> Deploy. Then Settings -> Variables -> add a Secret named
// TFNSW_KEY with your API key. Put the worker URL in the app's "Proxy URL"
// setting and leave the API key field empty.

const ALLOWED_ORIGIN = '*'; // e.g. 'https://theabhash.github.io' to lock it down

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const u = new URL(req.url);
    if (!/^\/v1\/(tp|gtfs)\//.test(u.pathname)) {
      return new Response('Not allowed', { status: 403, headers: cors });
    }
    const upstream = await fetch('https://api.transport.nsw.gov.au' + u.pathname + u.search, {
      headers: { Authorization: 'apikey ' + env.TFNSW_KEY },
    });
    const h = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: h });
  },
};
