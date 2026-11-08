# Putting Mastermind on a server

The game, the REST API and the MCP endpoint are one Node.js process. On a plain VPS run it on its
own port; behind an existing web server mount it under a prefix with `--base-path` (the examples use
`/games/mastermind` on a cPanel host, which is how https://cocojs.com/games/mastermind/ runs).

## First time

1. **Copy the files** (everything but `server/data`):

   ```bash
   DEPLOY_HOST=myhost DEPLOY_DIR=/home/cocojs/mastermind DEPLOY_OWNER=cocojs tools/deploy.sh
   ```

2. **Install the service.** Adjust paths, user and the Node binary in `mastermind.service`, then:

   ```bash
   scp deploy/mastermind.service myhost:/etc/systemd/system/mastermind.service
   ssh myhost 'systemctl daemon-reload && systemctl enable --now mastermind && systemctl status mastermind --no-pager'
   ssh myhost 'curl -s http://127.0.0.1:8772/games/mastermind/api/health'
   ```

   Environment variables understood by the server: `HOST`, `PORT`, `MASTERMIND_DATA`,
   `MASTERMIND_BASE_PATH`, `MASTERMIND_PUBLIC_URL`, `MASTERMIND_API_KEY`, `MASTERMIND_ALLOWED_ORIGINS`.

3. **Proxy it.** Add the rules from `apache-mastermind.conf` to the vhost (on cPanel: an include under
   `/etc/apache2/conf.d/userdata/ssl/2_4/<user>/<domain>/`, then `/scripts/rebuildhttpdconf &&
   /scripts/restartsrv_httpd`). For nginx the equivalent is:

   ```nginx
   location /games/mastermind { proxy_pass http://127.0.0.1:8772; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
   ```

4. **Regenerate the docs with the public address** so the examples and the OpenAPI document point at
   the live server, and redeploy:

   ```bash
   node tools/gen-docs.mjs --public-url=https://example.com/games/mastermind
   ```

## Every later release

```bash
DEPLOY_HOST=myhost DEPLOY_DIR=/home/cocojs/mastermind DEPLOY_OWNER=cocojs tools/deploy.sh
```

The script streams a tar archive over SSH, fixes ownership and restarts the unit; `server/data/state.json`
(live games and the scoreboard) is never overwritten.

## Checks

```bash
curl -s https://example.com/games/mastermind/api/health
curl -s -X POST https://example.com/games/mastermind/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
node tools/play-demo.js --url https://example.com/games/mastermind/mcp --player "Smoke test"
```
