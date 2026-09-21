# Free-hosted friends pilot

This pilot is designed for the owner and a small number of invited friends. It keeps the
existing vinext frontend and FastAPI recommendation logic while allowing the owner's home
computer to remain off.

## Hosting shape

```text
phone or desktop browser
  -> Cloudflare Worker (vinext UI, free allowance)
  -> Render free web service (FastAPI, may sleep when idle)
  -> Neon free PostgreSQL (durable scores and ownership)
```

No public deployment, service account connection, or paid resource is created by this
repository configuration alone.

## Pilot behavior

- Each invited person receives a different access key.
- The API derives a stable private owner ID from the key label and scopes every score import,
  B50 read, edit, source-image operation, and recommendation request to that owner.
- The homepage lists the signed-in person's most recent import, B50, and recommendation link.
- Complete DX NET JSON import is the supported cloud update path.
- Remote image OCR is disabled in the hosted configuration. Local OCR remains available.
- A Render free service can sleep after inactivity, so the first request can be slow.

## Required secrets and settings

Render must receive these values through its dashboard, never through Git:

| Variable | Example/meaning |
| --- | --- |
| `MAIUP_DATABASE_URL` | Neon PostgreSQL connection string, including required TLS options |
| `MAIUP_ACCESS_KEYS` | `owner:long-random-key,friend-a:different-long-random-key` |
| `MAIUP_CORS_ORIGINS` | Exact deployed Cloudflare origin, with no trailing slash |

`render.yaml` enables access-key enforcement, disables cloud OCR, and synchronizes the catalog
when a fresh database has no published snapshot.

The frontend build must receive:

```text
NEXT_PUBLIC_API_ORIGIN=https://the-render-service.example
```

Access keys are bearer secrets. Give each person only their own key. Rotating or removing one
entry blocks future access for that person without exposing another person's records. Do not put
real keys in screenshots, documentation, source control, or chat logs.

## Validation gate before deployment

1. Backend Ruff and pytest pass.
2. Frontend production build passes.
3. Two test keys cannot read each other's import IDs.
4. A fresh PostgreSQL database can synchronize the catalog and complete a JSON import.
5. Real Android/iOS browser checks are recorded separately from desktop and automated tests.
6. The owner reviews Render, Neon, and Cloudflare dashboards and confirms that every selected
   resource is on a free plan before creation.

The DX NET exporter remains an experimental user-initiated browser tool. It does not collect
SEGA credentials or cookies, and JSON upload remains the fallback. Public distribution still
requires the terms and source-rights decision described in
[`public-hosting-research.en.md`](public-hosting-research.en.md).
