# Render Deployment (Backend + S3 Storage)

## 1) Create a Web Service in Render

- Runtime: `Node`
- Root Directory: `backend`
- Build Command: `npm ci && npm run build`
- Start Command: `npm run start`
- Health Check Path: `/api/health`

You can also use the blueprint file at repository root: `render.yaml`.

## 2) Required Environment Variables

Set these in Render service settings:

- `STORAGE_PROVIDER=s3`
- `S3_BUCKET=<your-bucket-name>`
- `S3_REGION=<your-region>`
- `S3_ENDPOINT=<provider-endpoint>` (for S3-compatible storage; leave empty for AWS S3)
- `S3_ACCESS_KEY_ID=<access-key>`
- `S3_SECRET_ACCESS_KEY=<secret-key>`
- `S3_PREFIX=library/`
- `S3_FORCE_PATH_STYLE=true` (usually true for MinIO/Selectel/other compatible providers; false for AWS S3)

Optional matching/LLM envs:

- `EMBEDDINGS_PROVIDER=local` or `openai`
- `OPENAI_API_KEY=<key>` (required only if OpenAI mode is used)
- `JUDGE_PROVIDER=openai` or `ollama` (for Render usually use `openai` or leave empty)
- `OPENAI_JUDGE_MODEL=gpt-4o-mini`

## 3) First Start Validation

After deploy:

- Call `GET /api/health` and confirm `{ "ok": true }`.
- Upload one file to `POST /api/library/add` and check that object appears in bucket/prefix.
- Call `GET /api/library/list` and verify `storedPath` is `s3://...`.

## 4) Reindex Existing Objects

If you already have files in your bucket under `S3_PREFIX`, call:

- `POST /api/library/reindexStored`

It rebuilds `library-index.json` from objects in S3.
