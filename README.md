# CRM Construction

This repository contains a Vite/React client and an Express server deployed as
one Node web service. The production build writes the browser application to
`dist/public` and the server bundle to `dist/index.js`.

Render installs development dependencies during the build because Vite and the
TypeScript build tooling are required to create the production bundle.

## Deploy to Render

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. In Render, create a **Blueprint** and select the repository. Render reads
   `render.yaml` and creates one web service.
3. Enter every environment variable Render prompts for. Use the same final
   Render URL (for example, `https://crm-construction.onrender.com`) for
   `FRONTEND_URL`, `BASE_URL`, and `CLIENT_URL`.
4. Set `GOOGLE_CALLBACK_URL` to
   `https://YOUR-SERVICE.onrender.com/api/auth/google/callback` and add that
   exact URI to the Google OAuth client's authorized redirect URIs.
5. After deployment, set the Stripe webhook endpoint to
   `https://YOUR-SERVICE.onrender.com/api/stripe/webhook` and copy its signing
   secret into `STRIPE_WEBHOOK_SECRET`.
6. Apply database migrations once with `npm run db:migrate` against the same
   `DATABASE_URL` before using the application.

The app uses same-origin API and WebSocket URLs in production, so no separate
client service or `VITE_API_URL`/`VITE_WS_URL` is needed on Render.

Render's filesystem is ephemeral. Files that must survive restarts should use
the configured Cloudinary integration or another object store instead of the
local `uploads` directory.

## Local verification

Copy `.env.example` to `.env` and fill in `DATABASE_URL`. The included OpenAI
placeholder is enough for non-AI UI/API tests; use a real key to exercise AI,
voice, or VSL features. Google OAuth and Stripe are optional for local startup;
their endpoints return `503` until configured.

```sh
npm ci
npm run dev
```

For a production-mode local smoke test:

```sh
npm run check
npm run build
npm start
```
