# rpc-cache-cf-worker

A [Cloudflare Worker](https://workers.cloudflare.com/) that caches RPC queries
on the edge for Cosmos SDK nodes.

## Development

### Run locally

```sh
npm run dev
# OR
wrangler dev --local --persist
```

### Configuration

1. Copy `wrangler.toml.example` to `wrangler.toml`.

2. Deploy to Cloudflare:

   ```sh
   wrangler publish
   # OR
   npm run deploy
   ```

3. In the Cloudflare Worker dashboard, under Triggers, add a route that assigns
   the Worker to run in front of your RPC route.

## Deploy

```sh
wrangler publish
# OR
npm run deploy
```
