# CloudBotWatch Logger

A universal Cloudflare edge telemetry collector. Point it at any HTTP endpoint — works out of the box with [CloudBotWatch.com](https://cloudbotwatch.com), or bring your own backend.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CloudBotWatch/logger)

---

## What it does

The Worker intercepts every request passing through your Cloudflare zone, assembles a privacy-minimised telemetry record from Cloudflare edge metadata, and forwards it to your configured endpoint — all inside `ctx.waitUntil`, so your visitors are never affected.

Every outbound request is signed with HMAC-SHA256 (`X-Timestamp` + `X-Signature` headers) so your backend can verify the payload came from your Worker and not an external source.

---

## Quick start (Wrangler CLI)

```bash
git clone https://github.com/CloudBotWatch/logger.git
cd logger
npm install
cp .env.example .env
# Edit .env — set LOG_ENDPOINT and LOG_SECRET
npx wrangler dev
```

To deploy:

```bash
npx wrangler deploy
```

Set secrets in production (never commit them):

```bash
npx wrangler secret put LOG_SECRET
npx wrangler secret put LOG_ENDPOINT
```

---

## Configuration

All settings are Cloudflare Worker environment variables. The `[vars]` block in `wrangler.toml` sets the defaults; override them in the Cloudflare dashboard under **Workers & Pages → your worker → Settings → Variables**.

| Variable | Default | Description |
|---|---|---|
| `LOG_ENDPOINT` | *(required)* | URL to POST telemetry to — CloudBotWatch ingest URL, ELK, Datadog, or any HTTP endpoint |
| `LOG_SECRET` | *(required)* | HMAC-SHA256 signing secret shared with your backend. Minimum 32 characters. |
| `LOG_HTML_ONLY` | `true` | When `true`, only log requests where the `Accept` header includes `text/html` — skips assets, XHR, and API calls. Best signal-to-noise ratio for bot detection. |
| `LOG_SAMPLE_RATE` | `1` | Fraction of requests to log (`0.0`–`1.0`). Set to `0.1` to log 10% of traffic. Useful for very high-traffic sites. |

---

## Collected fields

| Field | Value |
|---|---|
| `hostname` | Site hostname |
| `path` | Full URL path — query string excluded |
| `ray_suffix` | Last 4 characters of `CF-Ray` header only |
| `ip_range` | `/24` for residential ASNs; full IP for datacenter ASNs |
| `country` | Cloudflare country code |
| `asn` | Autonomous System Number |
| `asn_organization` | `request.cf.asOrganization` — human-readable ASN name |
| `cache_status` | `CF-Cache-Status` value |
| `referer` | Full Referer URL (truncated at 500 characters) |
| `user_agent` | Raw User-Agent string |
| `method` | HTTP method |
| `status` | HTTP response status code |

### Deliberately not collected

- Full IP address
- Full CF-Ray ID (last 4 characters only)
- Query strings
- Cookies or `Authorization` headers
- Request or response bodies
- Any sensitive headers

---

## IP masking

The Worker classifies the request's ASN organisation name against a built-in datacenter/backbone regex before sending:

- **Datacenter / hosting / backbone ASN** — full IP retained (infrastructure IPs are not personal data)
- **Residential / mobile ISP** — IP masked to `/24` before the payload leaves the Worker

This masking happens at the edge, before transmission. Your backend never receives an unmasked residential IP.

---

## Request signing

Every POST to `LOG_ENDPOINT` includes two headers:

```
X-Timestamp: <unix seconds>
X-Signature: <hex HMAC-SHA256>
```

The signature is computed over `timestamp=<X-Timestamp>&body=<raw JSON body>` using the `LOG_SECRET` key. Your backend should reject requests where the timestamp is more than 5 minutes old and where the signature does not match.

---

## Operational modes

| Mode | How to configure | Use case |
|---|---|---|
| HTML-only (default) | `LOG_HTML_ONLY=true` | Best bot detection signal — page loads only, no assets |
| Full logging | `LOG_HTML_ONLY=false` | Complete request picture for active incident investigation |
| Sampled | `LOG_SAMPLE_RATE=0.1` | 10% sample for very high-traffic sites managing ingestion cost |

---

## Using with CloudBotWatch

[CloudBotWatch.com](https://cloudbotwatch.com) is the hosted backend built for this Worker. It provides:

- Bot scoring per session group using Ray suffix, asset loading, timing, and ASN signals
- ASN intelligence with per-ASN risk profiles and classification
- WAF recommendation module — copy-paste Cloudflare WAF expressions ready to deploy
- Cross-site threat feed (ASNs observed as suspicious across multiple customer sites)
- Weekly email reports with traffic quality summary

After signing up, set `LOG_ENDPOINT` to your site's CloudBotWatch ingest URL and `LOG_SECRET` to the HMAC secret shown in the dashboard. No other changes needed.

---

## Privacy

CloudBotWatch Logger uses only metadata already available to Cloudflare at the edge. It does not use tracking cookies, JavaScript snippets, pixels, or advertising identifiers. All IP masking happens inside the Worker before any data leaves your zone.

See [cloudbotwatch.com/privacy](https://cloudbotwatch.com/privacy) for the full data processing and retention policy.
