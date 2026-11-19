# Myanmar AI Comic Reader

A mobile-first Burmese comic reader: open comics in the browser, extract text with OCR,
translate it into natural Burmese with AI, and listen to it read aloud.

## Features
- Open images, PDF and CBZ/ZIP files (processed in the browser)
- OCR for Burmese, English, Japanese, Korean and Chinese comics
- AI Burmese translation through GonkaRouter (`/api/translate`)
- Read aloud with the device's Burmese voice, auto-advancing pages

## Run locally
```bash
npm install
npm run dev
```
The translate button needs the Cloudflare Function, so it only works on Cloudflare Pages
(or with `npx wrangler pages dev dist`).

## Deploy on Cloudflare Pages
- Build command: `npm run build`
- Output directory: `dist`
- The `functions/` folder is picked up automatically.
- Add these under **Settings → Variables and Secrets** (use *Secret* for the key; never commit it):
  - `GONKA_API_KEY` — your GonkaRouter API key
  - `GONKA_MODEL` — optional, defaults to `zai-org/GLM-5.3-Flash`

The GitHub Pages workflow still builds the static reader, but translation only works on Cloudflare.
