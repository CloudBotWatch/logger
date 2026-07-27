/*!
 * CloudBotWatch Logger — https://github.com/CloudBotWatch/logger
 * Copyright (c) 2026 CloudBotWatch. Released under the MIT License.
 */

function expandIpv6Groups(ip) {
  const idx = ip.indexOf('::');
  const head = idx === -1 ? ip : ip.slice(0, idx);
  const tail = idx === -1 ? '' : ip.slice(idx + 2);
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  return headParts.concat(Array(missing).fill('0'), tailParts);
}

function maskIp(ip) {
  if (!ip) return null;

  if (ip.includes(':')) {
    return expandIpv6Groups(ip).slice(0, 4).join(':') + '::/64';
  }

  const parts = ip.split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.0/24';

  return null;
}

const keyCache = new Map();

async function hmacKey(secret) {
  let key = keyCache.get(secret);

  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    keyCache.set(secret, key);
  }

  return key;
}

async function hmacHex(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function signRequest(secret, timestamp, body) {
  return hmacHex(secret, `timestamp=${timestamp}&body=${body}`);
}

function clientHash(secret, ip, userAgent) {
  return hmacHex(secret, `v1\n${ip}\n${userAgent || ''}`);
}

async function buildPayload(request, cf, response, secret) {
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipRange = maskIp(ip);

  if (!ipRange) return null;

  const userAgent = request.headers.get('user-agent') || null;

  return {
    hostname: url.hostname,
    path: url.pathname,
    client_hash: await clientHash(secret, ip, userAgent),
    ip_range: ipRange,
    country: cf.country || null,
    asn: cf.asn ? Number(cf.asn) : null,
    asn_organization: cf.asOrganization || null,
    cache_status: response.headers.get('CF-Cache-Status') || null,
    referer: request.headers.get('referer') || null,
    user_agent: userAgent,
    method: request.method,
    status: null,
  };
}

export default {
  async fetch(request, env, ctx) {
    ctx.passThroughOnException();

    const cf = request.cf || {};

    const response = await fetch(request);

    const endpoint = env.LOG_ENDPOINT;
    const secret = env.LOG_SECRET;

    if (!endpoint || !secret) {
      return response;
    }

    ctx.waitUntil((async () => {
      try {
        const payload = await buildPayload(request, cf, response, secret);

        if (!payload) return;

        payload.status = response.status;

        const body = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = await signRequest(secret, timestamp, body);

        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-timestamp': timestamp,
            'x-signature': signature,
          },
          body,
        });
      } catch (_) {
      }
    })());

    return response;
  },
};
