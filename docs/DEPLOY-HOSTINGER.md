# Deploy to Hostinger VPS with Docker

Target URL: **https://serpapiplaces.dhakafareast.tech**

The stack is three containers behind an existing Traefik instance:

| Container | Role | Network |
| --- | --- | --- |
| `serp-places-api` | Fastify API + built client on `:3001` | `internal`, `traefik` |
| `serp-places-worker` | Background jobs (exports, retention) | `internal` |
| `serp-places-db` | PostgreSQL 16 | `internal` |

Only the API joins the external Traefik network. Traefik terminates TLS and routes the hostname to `api:3001`.

## 1. DNS

In Hostinger hPanel → **Domains → dhakafareast.tech → DNS Zone**, add:

| Type | Name | Points to | TTL |
| --- | --- | --- | --- |
| `A` | `serpapiplaces` | your VPS IPv4 | 300 |

Remove any `AAAA` record for `serpapiplaces` unless your VPS has working IPv6. A wrong `AAAA` record makes Let's Encrypt fail.

Verify from your machine (wait for propagation, usually a few minutes):

```bash
dig +short A serpapiplaces.dhakafareast.tech
```

## 2. VPS prerequisites

- A Hostinger VPS with a Docker template (Docker Engine + Compose plugin).
- SSH access: hPanel → **VPS → Manage → SSH access**.
- Firewall allows TCP `22`, `80`, `443`. Do **not** expose `3001` or `5432`.
- Traefik already running and attached to a Docker network (the Hostinger Docker template provides one; confirm the name in step 4).

```bash
ssh root@YOUR_VPS_IP
docker --version
docker compose version
docker network ls | grep -i traefik
```

## 3. Get the code

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/Pulakhitman/serpapi-places.git
cd serpapi-places
```

## 4. Create the production `.env`

```bash
cp .env.example .env
openssl rand -base64 32     # -> APP_ACCESS_KEY
openssl rand -hex 24        # -> POSTGRES_PASSWORD (alphanumeric, URL-safe)
openssl rand -hex 32        # -> SETTINGS_ENCRYPTION_KEY
```

Edit `.env` and set at minimum:

```dotenv
APP_ACCESS_KEY=<generated>
POSTGRES_PASSWORD=<generated>
SETTINGS_ENCRYPTION_KEY=<generated>
SERPAPI_API_KEY=<your SerpApi key, or leave empty and save it in Settings>

APP_ORIGIN=https://serpapiplaces.dhakafareast.tech
APP_HOST=serpapiplaces.dhakafareast.tech

TRAEFIK_NETWORK=traefik
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_HTTP_ENTRYPOINT=web
TRAEFIK_CERT_RESOLVER=letsencrypt

SERPAPI_REVIEWS_ENABLED=true
SERPAPI_EXPORT_ENABLED=true
SERPAPI_STORAGE_DAYS=0
SERPAPI_REVIEW_RETENTION_DAYS=0
```

Notes:

- `APP_ORIGIN` must match the public URL exactly, or login/CSRF requests are rejected.
- If `docker network ls` shows a different Traefik network name, set `TRAEFIK_NETWORK` to it.
- If Traefik uses a different cert resolver, set `TRAEFIK_CERT_RESOLVER` accordingly.
- Keep `.env` out of Git. It is already ignored.

Harden it:

```bash
chmod 600 .env
```

## 5. Build and start

```bash
docker compose build
docker compose up -d
docker compose ps
```

Migrations run automatically when the API starts. First build takes a few minutes.

Watch the logs:

```bash
docker compose logs -f --tail=100 api
```

## 6. Verify

```bash
# from the VPS
curl -s http://127.0.0.1:3001/health/ready   # internal check, if you map the port; otherwise skip
docker compose exec api node -e "fetch('http://127.0.0.1:3001/health/ready').then(async r=>console.log(r.status, await r.text()))"

# from anywhere once DNS + TLS are ready
curl -s https://serpapiplaces.dhakafareast.tech/health/ready
```

Expected: `{"status":"ready"}`.

Then open `https://serpapiplaces.dhakafareast.tech`, sign in with `APP_ACCESS_KEY`, and run one small OSM search plus one SerpApi search to confirm provider access and the budget counters.

## 7. Updating

```bash
cd /opt/serpapi-places
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Never run `docker compose down -v` during an update: it deletes the PostgreSQL and export volumes.

## 8. Backups

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U places -Fc places_discovery > backups/places-$(date +%F).dump
docker run --rm -v serp_places_data:/data -v "$PWD/backups:/backup" alpine \
  tar czf /backup/serp-places-data-$(date +%F).tar.gz -C /data .
```

Copy backups off the VPS. Restore commands are in the main `README.md`.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| `502 Bad Gateway` from Traefik | `docker network ls`; the API must be on the same network as `TRAEFIK_NETWORK`. Recreate after fixing: `docker compose up -d --force-recreate api` |
| Certificate not issued | `dig +short A serpapiplaces.dhakafareast.tech` must equal the VPS IP; remove stray `AAAA`; ports 80/443 open; check `docker logs <traefik-container>` |
| Login loop or 403 `invalid_origin` | `APP_ORIGIN` must be exactly `https://serpapiplaces.dhakafareast.tech` (no trailing slash) |
| API restarts at boot | `docker compose logs api`; usually a bad `.env` value or the database is not healthy yet |
| `EADDRINUSE` in logs | Port `3001` is not published by this compose file, so this means a second API container is running; `docker ps` |
| SerpApi calls return 401 | `SERPAPI_API_KEY` missing or empty inside the container: `docker compose exec api printenv SERPAPI_API_KEY` |

## 10. Using Hostinger Docker Manager instead of SSH

Docker Manager's **Compose from URL** pulls only the Compose file, but this project builds from source (`build: .`), so the build context must exist on the server. Use the SSH flow above as the primary method. If you prefer Docker Manager, clone the repo on the VPS first (or use its terminal), then open the project from `/opt/serpapi-places`. The same `.env` and Traefik network rules apply.

## Security checklist before going live

- [ ] `APP_ACCESS_KEY` is long and random; it is the only login.
- [ ] `SETTINGS_ENCRYPTION_KEY` is set and backed up; without it, a key saved in Settings cannot be decrypted after rotation.
- [ ] `POSTGRES_PASSWORD` is random; the database is not published to the host.
- [ ] `.env` is `chmod 600` and not in Git.
- [ ] The retired `GOOGLE_PLACES_*` variables are absent; that API key is revoked.
- [ ] `SERPAPI_MONTHLY_LIMIT` / `SERPAPI_DAILY_LIMIT` match the budget you actually want.
- [ ] Backups run and are copied off the VPS.
