// Netlify Function：接收前端事件、寫入 Supabase user_events
// 端點：POST /api/track
// payload: { event_name, properties, session_id, line_id?, is_in_line?, os?, language? }

let supabaseRequest = null;
const crypto = require('crypto');
try {
  ({ supabaseRequest } = require('./supabase/client'));
} catch (err) {
  console.log('[track] Supabase client 未找到:', err.message);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const headers = corsHeaders();

  if ((event.body || '').length > 16384) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'payload too large' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  const {
    event_name, properties = {}, session_id,
    line_id = null, is_in_line = null, os = null, language = null,
  } = payload;

  if (!isSafeToken(event_name, 80) || !isSafeToken(session_id, 120)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'event_name and session_id required' }) };
  }

  // 沒有 Supabase（本機開發 / 缺環境變數），靜默 ack 不拖累前端
  if (!supabaseRequest) {
    console.log('[track] no supabase, dropping:', event_name);
    return { statusCode: 202, headers, body: JSON.stringify({ ok: true, dropped: true }) };
  }

  try {
    const requestHeaders = event.headers || {};
    const userAgent = requestHeaders['user-agent'] || requestHeaders['User-Agent'] || null;
    await supabaseRequest('user_events', {
      method: 'POST',
      body: JSON.stringify({
        line_id: line_id ? `sha256:${crypto.createHash('sha256').update(String(line_id)).digest('hex')}` : null,
        session_id,
        event_name,
        properties: sanitize(properties),
        is_in_line,
        os,
        language,
        user_agent: userAgent,
      }),
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[track] insert failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function isSafeToken(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(value);
}

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [String(k).slice(0, 80), sanitize(v, depth + 1)]));
  }
  return String(value).slice(0, 100);
}
