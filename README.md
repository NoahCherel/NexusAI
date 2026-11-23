# NexusAI

A roleplay front-end in the spirit of SillyTavern, used as a home-screen web app (PWA) on
iPhone. Characters, conversations, memories and settings live **in the browser only**
(IndexedDB + localStorage). The Next.js server just relays calls to the AI providers
(OpenRouter, NanoGPT, OpenAI) and to the character-card sites.

Stack: Next.js 16, React 19, Tailwind 4, zustand, IndexedDB schema v9.

## Run

```bash
npm install
npm run dev                    # development, http://localhost:3000
npm run build && npm start     # production build
```

## Deploy

Vercel builds `main` automatically. Pushing another branch only creates a preview at a
different address, and a different address means a different, empty browser storage.

- API keys are stored encrypted in the browser, but they pass through this deployment's
  server routes (`/api/chat`, `/api/validate`, …) on their way to the provider.
- Some card sites sit behind Cloudflare and may refuse a cloud server; the importer then
  retries the request from the browser.

## Data and backups

- **Réglages → Sauvegardes → « Télécharger une sauvegarde globale »** writes every
  conversation, character, memory and setting into one compressed `.json.gz` file, read page
  by page so it works on large libraries. Save it through the share sheet
  (« Enregistrer dans Fichiers » → iCloud Drive).
- **« Restaurer un fichier de sauvegarde globale »** checks the whole file before writing
  anything, then only adds what is missing: it never deletes or overwrites. Old `.json`
  backups still restore.
- API keys are never restored: enter them again on a new device.
- A home-screen app has its own storage, separate from Safari's. The `/rescue` page opened in
  Safari does not see the app's data; use the backup section inside the app.

## Checks

```bash
npm run format:check
npm run lint
npm run type-check
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) runs all five on every push and pull request to `main`.
