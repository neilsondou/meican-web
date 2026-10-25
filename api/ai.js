const { AI_KEYS } = require('../lib/ai-keys');

const AI_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const VISION_MODEL = 'glm-4v-flash';
const TEXT_MODEL = 'glm-4-flash';
// Vercel 普通函数请求体上限约 4.5 MB，给 base64 图片留一点余量。
const MAX_BODY_BYTES = 4_200_000;
// 最近 30 天的饮食与体重 JSON 可能超过两万字符。
const MAX_TEXT_CHARS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const buckets = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: '此来源未被允许。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST 请求。' });
    return;
  }

  try {
    const ip = clientIp(req);
    if (!allowRequest(ip)) {
      throw new HttpError(429, '请求有些频繁，请稍后再试。');
    }

    const body = await readJson(req);
    const parsed = validateMessages(body.messages);
    if (!parsed) {
      throw new HttpError(400, 'AI 请求格式不正确。');
    }

    const keys = loadKeys();
    if (keys.length === 0) {
      throw new HttpError(503, '服务尚未配置 AI 密钥。');
    }

    const payload = {
      model: parsed.hasImage ? VISION_MODEL : TEXT_MODEL,
      messages: body.messages,
    };
    if (!parsed.hasImage) {
      payload.temperature = clampNumber(body.temperature, 0, 1, 0.4);
      payload.max_tokens = 600;
    }

    let lastStatus = 0;
    for (const key of rotate(keys)) {
      let response;
      try {
        response = await fetch(AI_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(55_000),
        });
      } catch {
        lastStatus = 0;
        continue;
      }

      const text = await response.text();
      if (response.ok) {
        sendRawJson(res, 200, text);
        return;
      }

      lastStatus = response.status;
      if (!canRetry(response.status)) {
        sendJson(res, 502, {
          error: `AI 服务请求失败（HTTP ${response.status}）。`,
        });
        return;
      }
    }

    if (lastStatus === 429) {
      throw new HttpError(429, 'AI 服务当前请求较多，请稍后重试。');
    }
    throw new HttpError(503, 'AI 服务暂时不可用，请稍后重试。');
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error('AI proxy error:', error);
    sendJson(res, 500, { error: '服务器内部错误，请稍后重试。' });
  }
};

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedOrigin(origin, req.headers.host)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  return true;
}

function isAllowedOrigin(origin, host) {
  try {
    const parsed = new URL(origin);
    if (host && parsed.host === host) return true;
    if (parsed.protocol === 'https:' && parsed.hostname === 'meican.dou.asia') {
      return true;
    }
    if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.vercel.app')) {
      return true;
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function allowRequest(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    if (buckets.size > 5000) {
      for (const [key, value] of buckets) {
        if (now - value.start >= RATE_WINDOW_MS) buckets.delete(key);
      }
    }
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

async function readJson(req) {
  let raw;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > MAX_BODY_BYTES) {
        throw new HttpError(413, '请求内容太大。');
      }
      raw = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) {
        throw new HttpError(413, '请求内容太大。');
      }
      raw = req.body;
    } else if (req.body && typeof req.body === 'object') {
      return req.body;
    }
  }

  if (raw === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError(413, '请求内容太大。');
      }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, '请求格式不正确。');
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 8) {
    return null;
  }
  let hasImage = false;
  for (const message of messages) {
    if (!message || (message.role !== 'system' && message.role !== 'user')) {
      return null;
    }
    if (typeof message.content === 'string') {
      if (message.content.length > MAX_TEXT_CHARS) return null;
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return null;
    }
    for (const part of message.content) {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || part.text.length > MAX_TEXT_CHARS) {
          return null;
        }
      } else if (part.type === 'image_url') {
        const url = part.image_url && part.image_url.url;
        if (
          typeof url !== 'string' ||
          !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(url) ||
          url.length > MAX_BODY_BYTES
        ) {
          return null;
        }
        hasImage = true;
      } else {
        return null;
      }
    }
  }
  return { hasImage };
}

function loadKeys() {
  const envKeys = (process.env.MEICAN_AI_KEYS || '')
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  const embedded = Array.isArray(AI_KEYS)
    ? AI_KEYS.map((key) => String(key).trim()).filter(Boolean)
    : [];
  return [...new Set([...envKeys, ...embedded])];
}

function rotate(items) {
  const start = Math.floor(Math.random() * items.length);
  return [...items.slice(start), ...items.slice(0, start)];
}

function canRetry(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

function clampNumber(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function sendRawJson(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}
