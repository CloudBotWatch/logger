// ASN organization prefixes that indicate datacenter/hosting/CDN infrastructure.
// A match here means the full IP is stored, so the list must bias toward false
// negatives: no consumer/mobile ISPs, no bare words likely to appear in
// residential org names. When in doubt, leave it out — a missed datacenter
// gets over-masked; a wrong match leaks a residential IP.
const DATACENTER_PATTERNS = /\b(amazon|aws|google|microsoft|azure|cloudflare|digitalocean|linode|vultr|hetzner|ovh|fastly|akamai|limelight|stackpath|zscaler|oracle cloud|rackspace|ibm cloud|alibaba|tencent|huawei|softlayer|cogent|hurricane electric|he\.net|choopa|constant contact|quadranet|tzulo|psychz|path\.net|nexeon|equinix|databank|cyrusone|coresite|vaultworks|greencloudvps|buyvm|frantech|ponynet|serverius|datacamp|m247|reliablesite|sharktech|colo4|colohouse|cologix|flexential|volico|latisys|peak10|tierpoint|sungard|evocative|xo communications|zayo|inap|centrilogic|webair|datapipe|singlehop|micfo|temok|hostwinds|terrahost|online\.net|scaleway|exoscale|upcloud|brightbox|catalyst cloud|fuga cloud|citynetwork|glesys|ipv4net|ntschina)\b/i;

function classifyAsn(org) {
  if (!org) return 'residential';
  return DATACENTER_PATTERNS.test(org) ? 'datacenter' : 'residential';
}

function expandIpv6Groups(ip) {
  const idx = ip.indexOf('::');
  const head = idx === -1 ? ip : ip.slice(0, idx);
  const tail = idx === -1 ? '' : ip.slice(idx + 2);
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  return headParts.concat(Array(missing).fill('0'), tailParts);
}

function maskIp(ip, asnClass) {
  if (asnClass === 'datacenter') return ip;
  // Mask to /24 (IPv4) or /64 (IPv6) for residential
  if (ip && ip.includes(':')) {
    return expandIpv6Groups(ip).slice(0, 4).join(':') + '::/64';
  }
  const parts = ip ? ip.split('.') : [];
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.0/24';
  return ip;
}

async function signRequest(secret, timestamp, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `timestamp=${timestamp}&body=${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function raySuffixFromResponse(response) {
  const ray = response.headers.get('CF-Ray') || '';
  const id = (ray.split('-')[0] || '').trim();
  return id.length >= 4 ? id.slice(-4) : (id || null);
}

function buildPayload(request, cf, response) {
  const url = new URL(request.url);
  const asn = cf.asn ? Number(cf.asn) : null;
  const asnOrg = cf.asOrganization || null;
  const asnClass = classifyAsn(asnOrg);
  const ip = request.headers.get('cf-connecting-ip') || '';

  return {
    hostname: url.hostname,
    path: url.pathname,
    ray_suffix: raySuffixFromResponse(response),
    ip_range: maskIp(ip, asnClass),
    country: cf.country || null,
    asn: asn,
    asn_organization: asnOrg,
    cache_status: response.headers.get('CF-Cache-Status') || null,
    referer: request.headers.get('referer') || null,
    user_agent: request.headers.get('user-agent') || null,
    method: request.method,
    status: null, // filled after proxying if needed; worker sends 0 pre-response
  };
}

function shouldLog(request, env) {
  const htmlOnly = (env.LOG_HTML_ONLY || 'false') === 'true';
  const sampleRate = parseFloat(env.LOG_SAMPLE_RATE || '1');

  if (htmlOnly) {
    const accept = request.headers.get('accept') || '';
    // Skip requests that don't accept HTML (assets, XHR, etc.)
    if (!accept.includes('text/html')) return false;
  }

  if (sampleRate < 1 && Math.random() > sampleRate) return false;

  return true;
}

export default {
  async fetch(request, env, ctx) {
    // If the Worker itself throws or exceeds CPU limits, let the request
    // pass through to the origin instead of failing the visitor's request.
    ctx.passThroughOnException();

    const cf = request.cf || {};

    if (!shouldLog(request, env)) {
      return fetch(request);
    }

    const response = await fetch(request);

    const endpoint = env.LOG_ENDPOINT;
    const secret = env.LOG_SECRET;

    if (!endpoint || !secret) {
      return response;
    }

    const payload = buildPayload(request, cf, response);
    payload.status = response.status;

    ctx.waitUntil((async () => {
      try {
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
        // Telemetry failures must never affect the origin response
      }
    })());

    return response;
  },
};
