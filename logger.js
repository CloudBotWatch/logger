// ASN organization prefixes that indicate datacenter/hosting/CDN infrastructure
const DATACENTER_PATTERNS = /\b(amazon|aws|google|microsoft|azure|cloudflare|digitalocean|linode|vultr|hetzner|ovh|fastly|akamai|limelight|stackpath|zscaler|oracle cloud|rackspace|ibm cloud|alibaba|tencent|huawei|softlayer|cogent|lumen|centurylink|hurricane electric|he\.net|choopa|constant contact|quadranet|tzulo|psychz|path\.net|nexeon|packet|equinix|databank|cyrusone|coresite|switch|vaultworks|greencloudvps|buyvm|frantech|ponynet|serverius|datacamp|m247|reliablesite|sharktech|colo4|colohouse|cologix|flexential|volico|latisys|peak10|tierpoint|sungard|evocative|xo communications|windstream|zayo|inap|centrilogic|webair|datapipe|singlehop|superb|micfo|temok|hostwinds|terrahost|online\.net|scaleway|exoscale|upcloud|brightbox|catalyst cloud|fuga cloud|citynetwork|glesys|ipv4net|ntschina|kddi|ntt|softbank|docomo|att|verizon|comcast|charter|cox|centurylink|frontier|windstream|consolidated|mediacom|suddenlink|sparklight|buckeye|cincinnati bell|hawaiian telcom|cincinnati)\b/i;

function classifyAsn(org) {
  if (!org) return 'residential';
  return DATACENTER_PATTERNS.test(org) ? 'datacenter' : 'residential';
}

function maskIp(ip, asnClass) {
  if (asnClass === 'datacenter') return ip;
  // Mask to /24 for residential — drop last octet (IPv4) or last 80 bits (IPv6 simplification)
  if (ip && ip.includes(':')) {
    // IPv6: keep first 4 groups
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::/64';
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

function shouldLog(request, env, asnClass) {
  const htmlOnly = (env.LOG_HTML_ONLY || 'true') === 'true';
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
    const cf = request.cf || {};
    const asnOrg = cf.asOrganization || null;
    const asnClass = classifyAsn(asnOrg);

    if (!shouldLog(request, env, asnClass)) {
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
