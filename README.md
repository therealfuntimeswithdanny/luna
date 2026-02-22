# Luna File Converter Worker

Cloudflare Worker app with a simple web UI that:
- uploads original files to an R2 bucket bound as `R2_BUCKET`
- converts files in-browser with `ffmpeg.wasm` (images, gifs, and videos)
- uploads converted output to R2
- provides a download button and CDN URL

## 1) Configure R2 binding

Edit `/Users/danielmorrisey/Documents/GitHub/luna/wrangler.toml` and replace:

- `bucket_name = "YOUR_R2_BUCKET_NAME"`
- `preview_bucket_name = "YOUR_R2_BUCKET_NAME"`

`BUCKET_PUBLIC_HOST` is already set to:
- `luna-cdn.madebydanny.uk`

## 2) Install and run

```bash
npm install
npm run dev
```

Then open the local Wrangler URL and use the UI.

## 3) Deploy

```bash
npm run deploy
```

## Notes

- Conversion runs in the browser (not on Worker CPU), so very large files can be slow.
- If `BUCKET_PUBLIC_HOST` is unset, the app still works via Worker-hosted file routes.
