// netlify/functions/provider.js
// Unified proxy for Fox SMS (REST v2) and Simxpro (SMS-Activate protocol)
// API keys are read from Netlify environment variables — NEVER exposed to frontend.

const FOX_BASE  = 'https://foxsms.xyz/api/v2';
const SIMX_BASE = 'https://simxpro.org/api/stubs/handler_api.php';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(body)
  };
}

async function foxFetch(path, options = {}) {
  const key = process.env.FOX_SMS_API_KEY;
  if (!key) throw new Error('FOX_SMS_API_KEY not set in Netlify environment');
  const res = await fetch(FOX_BASE + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function simxFetch(params) {
  const key = process.env.SIMXPRO_API_KEY;
  if (!key) throw new Error('SIMXPRO_API_KEY not set in Netlify environment');
  const qs = new URLSearchParams({ api_key: key, ...params }).toString();
  const res = await fetch(`${SIMX_BASE}?${qs}`);
  const text = await res.text();
  return text;
}

function parseSimxStatus(text) {
  if (text.startsWith('STATUS_WAIT_CODE')) return { status: 'waiting' };
  if (text.startsWith('STATUS_WAIT_RETRY')) return { status: 'waiting', retry: text.split(':')[1] };
  if (text.startsWith('STATUS_OK:')) return { status: 'received', code: text.split(':')[1] };
  if (text.startsWith('STATUS_CANCEL')) return { status: 'cancelled' };
  return { status: 'unknown', raw: text };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { action, provider, ...params } = body;
  if (!action) return json(400, { error: 'Missing action' });

  try {
    // ═══════════════════════════════════════════════════════
    // FOX SMS — REST API v2
    // ═══════════════════════════════════════════════════════
    if (provider === 'foxsms') {
      if (action === 'balance') {
        const r = await foxFetch('/balance');
        return json(200, {
          success: r.success,
          balance: r.data?.balance ?? null,
          currency: r.data?.currency ?? 'INR'
        });
      }

      if (action === 'catalog') {
        const r = await foxFetch('/sms/catalog');
        if (!r.success) return json(200, { success: false, error: r.error || r.raw });
        // Normalise to { countries: [{ code, name, services: [...] }] }
        const countries = (r.data?.countries || []).map(c => ({
          code: c.country,
          name: c.name,
          services: (c.services || []).map(s => ({
            service_code: s.service_code,
            name: s.name,
            price: s.price,
            stock: s.stock,
            in_stock: s.in_stock
          }))
        }));
        return json(200, {
          success: true,
          currency: r.data?.currency || 'INR',
          total_countries: countries.length,
          countries
        });
      }

      if (action === 'prices') {
        const country = params.country || '';
        const service = params.service || '';
        const r = await foxFetch(`/sms/price?country=${encodeURIComponent(country)}&service_code=${encodeURIComponent(service)}`);
        return json(200, {
          success: r.success,
          available: r.data?.available,
          price: r.data?.price,
          options: r.data?.options || []
        });
      }

      if (action === 'buy') {
        const r = await foxFetch('/sms/order', {
          method: 'POST',
          headers: { 'Idempotency-Key': params.idempotency_key || `meow-${Date.now()}-${Math.random().toString(36).slice(2)}` },
          body: JSON.stringify({
            country: params.country,
            service_code: params.service,
            ...(params.max_price ? { max_price: params.max_price } : {})
          })
        });
        if (!r.success) return json(200, { success: false, error: r.error?.message || r.error || r.raw });
        return json(200, {
          success: true,
          order_id: r.data.order_id,
          number: r.data.number,
          status: r.data.status,
          price: r.data.price,
          expires_at: r.data.expires_at
        });
      }

      if (action === 'check') {
        const r = await foxFetch(`/sms/orders/${encodeURIComponent(params.order_id)}`);
        if (!r.success) return json(200, { success: false, error: r.error?.message || r.raw });
        const d = r.data || {};
        return json(200, {
          success: true,
          status: d.status,
          number: d.number,
          otp: d.otp || null,
          sms: (d.sms || []).map(m => ({ from: m.from || 'Provider', text: m.text || m.message || '', time: m.received_at || m.time }))
        });
      }

      if (action === 'cancel') {
        const r = await foxFetch(`/sms/orders/${encodeURIComponent(params.order_id)}/cancel`, { method: 'POST' });
        return json(200, { success: r.success, message: r.error?.message || (r.success ? 'Cancelled' : 'Failed') });
      }

      if (action === 'complete') {
        // Fox v2 has no separate "complete" — use cancel only for real cancellation.
        return json(200, { success: true, message: 'Fox SMS orders auto-complete when OTP arrives.' });
      }

      return json(400, { error: 'Unknown Fox action: ' + action });
    }

    // ═══════════════════════════════════════════════════════
    // SIMXPRO — SMS-Activate compatible
    // ═══════════════════════════════════════════════════════
    if (provider === 'simxpro') {
      if (action === 'balance') {
        const t = await simxFetch({ action: 'getBalance' });
        if (t.startsWith('ACCESS_BALANCE:')) {
          return json(200, { success: true, balance: parseFloat(t.split(':')[1]), currency: 'INR' });
        }
        return json(200, { success: false, error: t });
      }

      if (action === 'countries') {
        const t = await simxFetch({ action: 'getCountries' });
        try {
          const raw = JSON.parse(t);
          const countries = Object.values(raw).map(c => ({ code: String(c.id), name: c.eng || c.name || String(c.id) }));
          return json(200, { success: true, countries });
        } catch { return json(200, { success: false, error: t }); }
      }

      if (action === 'catalog') {
        // Simxpro: get countries, then get prices per country (all services)
        const ct = await simxFetch({ action: 'getCountries' });
        let countryMap = {};
        try { countryMap = JSON.parse(ct); } catch { return json(200, { success: false, error: 'Country parse failed' }); }

        const countries = [];
        const entries = Object.values(countryMap).slice(0, 30); // cap to keep function under 10s
        await Promise.all(entries.map(async c => {
          const pt = await simxFetch({ action: 'getPrices', country: String(c.id) });
          try {
            const pm = JSON.parse(pt);
            const countryPrices = pm[String(c.id)] || {};
            const services = Object.entries(countryPrices).map(([code, p]) => ({
              service_code: code,
              name: code,
              price: p.cost,
              stock: p.count,
              in_stock: (p.count || 0) > 0
            }));
            if (services.length) countries.push({ code: String(c.id), name: c.eng || String(c.id), services });
          } catch { /* skip bad country */ }
        }));

        return json(200, {
          success: true,
          currency: 'INR',
          total_countries: countries.length,
          countries
        });
      }

      if (action === 'prices') {
        const t = await simxFetch({ action: 'getPrices', service: params.service, country: params.country });
        try {
          const d = JSON.parse(t);
          const key = String(params.country);
          const s = d[key]?.[params.service];
          return json(200, { success: true, available: !!s, price: s?.cost, stock: s?.count });
        } catch { return json(200, { success: false, error: t }); }
      }

      if (action === 'buy') {
        const t = await simxFetch({ action: 'getNumber', service: params.service, country: params.country });
        if (t.startsWith('ACCESS_NUMBER:')) {
          const [, orderId, number] = t.split(':');
          return json(200, { success: true, order_id: orderId, number, status: 'waiting' });
        }
        if (t.startsWith('NO_NUMBERS')) return json(200, { success: false, error: 'No numbers available' });
        if (t.startsWith('NO_BALANCE')) return json(200, { success: false, error: 'Provider wallet empty' });
        return json(200, { success: false, error: t });
      }

      if (action === 'check') {
        const t = await simxFetch({ action: 'getStatus', id: params.order_id });
        const parsed = parseSimxStatus(t);
        return json(200, { success: true, ...parsed });
      }

      if (action === 'cancel') {
        const t = await simxFetch({ action: 'setStatus', id: params.order_id, status: '8' });
        return json(200, { success: t.startsWith('ACCESS_CANCEL') || t.startsWith('ACCESS_ACTIVATION'), raw: t });
      }

      if (action === 'complete') {
        const t = await simxFetch({ action: 'setStatus', id: params.order_id, status: '6' });
        return json(200, { success: t.startsWith('ACCESS_ACTIVATION'), raw: t });
      }

      return json(400, { error: 'Unknown Simxpro action: ' + action });
    }

    return json(400, { error: 'Unknown provider: ' + provider });
  } catch (err) {
    console.error('Provider error:', err);
    return json(500, { error: err.message || 'Internal error' });
  }
};