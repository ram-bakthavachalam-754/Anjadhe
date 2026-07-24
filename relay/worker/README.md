# Anjadhe relay — Cloudflare Worker

The production deployment of the relay. See [`../README.md`](../README.md) for
the protocol and the zero-knowledge model — both are unchanged here.

**Shape:** the Worker routes each WebSocket to a per-routing-ID Durable Object
(`RelayRoom`) by the first path segment of the connect URL. Each room uses the
WebSocket Hibernation API, so the many always-connected Macs cost almost
nothing while idle.

## Deploy

```sh
cd relay/worker
npm install
npx wrangler login        # one-time — opens a browser
npx wrangler deploy
```

`deploy` prints the public URL, e.g.
`https://anjadhe-relay.<your-subdomain>.workers.dev`. The app connects over
WebSocket, so the **relay URL is the `wss://` form** of that:
`wss://anjadhe-relay.<your-subdomain>.workers.dev`.

Then point the app at it — set `PRODUCTION_RELAY_URL` in `main.js`.

## Local test

```sh
npx wrangler dev          # serves on http://127.0.0.1:8787
```

`wrangler dev` runs the Worker + Durable Object locally, so you can pair
against `ws://127.0.0.1:8787` exactly as you would the Node relay.

To check the relay end to end, run `node smoke.mjs` in another shell while
`wrangler dev` is up — it drives the real channel endpoints through the
Worker: the `hello` handshake, an encrypted round-trip, a Mac→phone push,
and unpaired-peer rejection. Point it elsewhere with `RELAY_URL`.

## Custom domain (optional, for a stable address)

In the Cloudflare dashboard: Workers & Pages → `anjadhe-relay` → Settings →
Domains & Routes → add e.g. `relay.anjadhe.com`. Then use
`wss://relay.anjadhe.com` as the relay URL — it survives redeploys.

## Health

`GET /healthz` returns `ok`.

## Why a Worker instead of the Node relay (`../server.js`)

The Node relay is kept for local development and the channel tests. The
Worker is what real users reach: no server to run or patch, scales to zero
when idle, and is globally close to users. The routing-ID Durable Object is
the natural unit — one object per Mac↔phone room.
