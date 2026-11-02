# deploy/env — server-only secret files (never committed)

`docker-compose.prod.yml` reads these files. Render them on the server from your secrets manager,
then `chmod 600 deploy/env/*.env`. Templates: `deploy/env.templates/`.

| File | Used by | Template |
| --- | --- | --- |
| `api.env` | api, indexer | `deploy/env.templates/api.env.example` |
| `postgres.env` | postgres | `deploy/env.templates/postgres.env.example` |
| `caddy.env` | caddy | `deploy/env.templates/caddy.env.example` |
| `../../.env` (repo root) | web **build args** (public values only) | `deploy/env.templates/web-build.env.example` |
