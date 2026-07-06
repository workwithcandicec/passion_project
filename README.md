# Passion Project Planner

Turn the books you already own into week-by-week passion project plans. Photograph your bookshelf (or Kindle library, or audiobook app), name your passions, answer one coaching question per passion, and get a 4/8/12-week plan for each — the more books a passion has, the longer its plan. Add books over time; the agent folds them into your projects.

Built with React + Vite. AI calls go through a tiny Cloudflare Worker that keeps the API key secret. Plans export as Markdown or calendar (.ics) files. Your library lives in your browser's localStorage — nothing is stored on a server.

## What you need

- A GitHub account (hosts the site, free)
- A Cloudflare account (hosts the API proxy, free tier is plenty)
- An Anthropic API key from https://console.anthropic.com (pay-per-use; a full shelf scan plus plans typically costs a few cents)
- Node.js 18+ only if you want to run it locally — deployment itself needs no local tooling

## Deploy in three steps

### 1. Push this repo to GitHub

Create a new **public** repo named `passion-project-planner` (the name matters — see note below), then upload all of these files, or:

```bash
git init && git add -A && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/passion-project-planner.git
git push -u origin main
```

> **Different repo name?** Edit `base` in `vite.config.js` to match: `base: "/your-repo-name/"`.

### 2. Deploy the Worker (holds your API key)

**Dashboard route (no command line):**
1. In the Cloudflare dashboard: **Workers & Pages → Create → Worker**. Name it `passion-project-proxy`, deploy the default, then **Edit code**.
2. Replace the contents with `worker/worker.js` from this repo. **Deploy.**
3. Go to the Worker's **Settings → Variables and Secrets → Add**:
   - Type **Secret**, name `ANTHROPIC_API_KEY`, value = your Anthropic key.
4. Copy the Worker URL (looks like `https://passion-project-proxy.YOURNAME.workers.dev`).

**CLI route:**
```bash
cd worker
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

### 3. Connect and publish the site

1. Paste your Worker URL into `src/config.js` and push the change.
2. In your GitHub repo: **Settings → Pages → Source → GitHub Actions**.
3. The included workflow builds and deploys automatically on every push to `main`. Your site appears at `https://YOUR-USERNAME.github.io/passion-project-planner/`.

### 4. Recommended: lock the Worker to your site

Once the site is live, add a **plaintext variable** on the Worker named `ALLOWED_ORIGIN` with value `https://YOUR-USERNAME.github.io`. This stops other websites from using your Worker (and your API credit). Without it the Worker answers anyone.

## Run locally

```bash
npm install
npm run dev
```

## Costs

Hosting is free (GitHub Pages + Cloudflare Workers free tier, 100k requests/day). The only cost is Anthropic API usage on your key — image scans are the priciest calls and still run pennies. Set a spending limit in the Anthropic console for peace of mind.

## Notes

- **iPhone photos:** HEIC images are converted to JPEG in the browser automatically.
- **Privacy:** photos are sent to the Anthropic API for title extraction and are not stored by this app; your library data never leaves your browser's localStorage.
- **Forking:** anyone who forks this needs their own Worker and Anthropic key — the app is fully functional but intentionally ships with no credentials.
