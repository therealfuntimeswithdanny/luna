interface R2HttpMetadata {
  contentType?: string;
}

interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  put(key: string, value: ReadableStream<Uint8Array>, options?: R2PutOptions): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
}

interface Env {
  R2_BUCKET: R2Bucket;
  BUCKET_PUBLIC_HOST?: string;
}

const IMAGE_FORMATS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "avif"];
const VIDEO_FORMATS = ["mp4", "webm", "mov", "avi", "mkv", "gif"];
const GIF_FORMATS = ["gif", "mp4", "webm", "apng"];
const FFMPEG_VENDOR_ASSETS: Record<string, { url: string; contentType: string }> = {
  "/vendor/ffmpeg/ffmpeg.js": {
    url: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/vendor/ffmpeg/util.js": {
    url: "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/vendor/ffmpeg/worker.js": {
    url: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/vendor/ffmpeg/ffmpeg-core.js": {
    url: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/vendor/ffmpeg/ffmpeg-core.wasm": {
    url: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
    contentType: "application/wasm",
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderAppHtml(), {
        headers: buildHtmlHeaders(),
      });
    }

    if (request.method === "GET" && url.pathname in FFMPEG_VENDOR_ASSETS) {
      return handleVendorAsset(url.pathname);
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      return handleUpload(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/download") {
      return handleDownload(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      return handlePublicFileRoute(request, env, url.pathname);
    }

    return json({ error: "Not found" }, 404);
  },
};

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const fileValue = form.get("file");
  const folderValue = form.get("folder");

  if (!(fileValue instanceof File)) {
    return json({ error: "Missing file" }, 400);
  }

  const folder = normalizeFolder(typeof folderValue === "string" ? folderValue : "uploads");
  const originalName = fileValue.name || "upload.bin";
  const extension = getExtension(originalName) || "bin";
  const safeName = slugify(stripExtension(originalName)) || "file";
  const key = `${folder}/${crypto.randomUUID()}-${safeName}.${extension}`;

  await env.R2_BUCKET.put(key, fileValue.stream(), {
    httpMetadata: {
      contentType: fileValue.type || guessMimeType(extension),
    },
    customMetadata: {
      originalName,
      uploadedAt: new Date().toISOString(),
    },
  });

  const reqUrl = new URL(request.url);
  const cdnUrl = buildCdnUrl(env, key);
  const downloadUrl = `${reqUrl.origin}/api/download?key=${encodeURIComponent(key)}&name=${encodeURIComponent(originalName)}`;

  return json({
    key,
    name: originalName,
    size: fileValue.size,
    contentType: fileValue.type || guessMimeType(extension),
    cdnUrl,
    workerFileUrl: `${reqUrl.origin}/files/${key}`,
    downloadUrl,
  });
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const requestedName = url.searchParams.get("name") || "download";

  if (!key) {
    return json({ error: "Missing key" }, 400);
  }

  const object = await env.R2_BUCKET.get(key);
  if (!object) {
    return json({ error: "File not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `attachment; filename="${sanitizeHeaderValue(requestedName)}"`);

  return new Response(object.body, { headers });
}

async function handlePublicFileRoute(request: Request, env: Env, path: string): Promise<Response> {
  const key = path.replace(/^\/files\//, "");
  if (!key) {
    return json({ error: "Missing key" }, 400);
  }

  const object = await env.R2_BUCKET.get(key);
  if (!object) {
    return json({ error: "File not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);

  const url = new URL(request.url);
  if (url.searchParams.get("download") === "1") {
    const filename = url.searchParams.get("name") || key.split("/").pop() || "file";
    headers.set("content-disposition", `attachment; filename="${sanitizeHeaderValue(filename)}"`);
  }

  return new Response(object.body, { headers });
}

function normalizeFolder(folder: string): "originals" | "converted" | "uploads" {
  if (folder === "originals" || folder === "converted") {
    return folder;
  }
  return "uploads";
}

function getExtension(filename: string): string | null {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/i);
  return match ? match[1] : null;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n"]/g, "");
}

function buildCdnUrl(env: Env, key: string): string {
  const rawHost = (env.BUCKET_PUBLIC_HOST || "").trim();
  if (!rawHost) {
    return `/files/${key}`;
  }

  const host = rawHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/${key}`;
}

function guessMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    case "apng":
      return "image/apng";
    default:
      return "application/octet-stream";
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildHtmlHeaders(): Headers {
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' blob:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  return headers;
}

async function handleVendorAsset(pathname: string): Promise<Response> {
  const asset = FFMPEG_VENDOR_ASSETS[pathname];
  if (!asset) {
    return json({ error: "Asset not found" }, 404);
  }

  const upstream = await fetch(asset.url);
  if (!upstream.ok) {
    return new Response("Failed to load vendor asset", { status: 502 });
  }

  const headers = new Headers();
  headers.set("content-type", asset.contentType);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: 200, headers });
}

function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Luna Converter</title>
  <style>
    :root {
      --bg: #f4f2ee;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #5b6474;
      --brand: #0b6bcb;
      --brand-2: #0f9d8a;
      --border: #dce3ef;
      --danger: #b42318;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      background: radial-gradient(circle at top right, #dceefd 0%, #f4f2ee 45%, #efece6 100%);
      color: var(--ink);
      min-height: 100vh;
      padding: 1.5rem;
    }

    .wrap {
      max-width: 880px;
      margin: 0 auto;
      display: grid;
      gap: 1rem;
    }

    .hero {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 1.4rem;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
    }

    h1 {
      margin: 0 0 0.4rem;
      font-size: clamp(1.45rem, 4vw, 2rem);
      letter-spacing: -0.02em;
    }

    .sub {
      margin: 0;
      color: var(--muted);
      line-height: 1.4;
    }

    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 1.2rem;
      display: grid;
      gap: 0.9rem;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
    }

    .row {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: 1fr;
    }

    @media (min-width: 720px) {
      .row {
        grid-template-columns: 1.1fr 0.9fr;
      }
    }

    label {
      font-weight: 600;
      font-size: 0.95rem;
      display: block;
      margin-bottom: 0.35rem;
    }

    input[type="file"],
    select,
    button {
      width: 100%;
      padding: 0.72rem 0.78rem;
      border: 1px solid var(--border);
      border-radius: 10px;
      font: inherit;
      background: #fff;
    }

    button {
      cursor: pointer;
      border: none;
      background: linear-gradient(120deg, var(--brand), var(--brand-2));
      color: white;
      font-weight: 700;
      letter-spacing: 0.01em;
      transition: transform 0.12s ease, filter 0.12s ease;
    }

    button:hover:not(:disabled) {
      transform: translateY(-1px);
      filter: brightness(1.04);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }

    .status {
      font-size: 0.93rem;
      color: var(--muted);
      min-height: 1.2rem;
    }

    .status.error {
      color: var(--danger);
      font-weight: 600;
    }

    .result {
      display: none;
      background: #f9fbff;
      border: 1px solid #dae7fb;
      border-radius: 14px;
      padding: 0.9rem;
      gap: 0.8rem;
    }

    .result.show {
      display: grid;
    }

    .result p {
      margin: 0;
      font-size: 0.92rem;
      color: var(--muted);
      word-break: break-word;
    }

    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
    }

    .link-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      padding: 0.55rem 0.8rem;
      text-decoration: none;
      color: var(--ink);
      background: #fff;
      border: 1px solid var(--border);
      font-weight: 600;
      font-size: 0.92rem;
    }

    .help {
      margin-top: 0.4rem;
      color: var(--muted);
      font-size: 0.84rem;
      line-height: 1.4;
    }

    .kbd {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.82rem;
      background: #eef2fa;
      border: 1px solid #d7deec;
      border-radius: 6px;
      padding: 0.1rem 0.35rem;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>Luna File Converter</h1>
      <p class="sub">Upload a file, convert it in-browser, then store both original and converted outputs in R2.</p>
    </section>

    <section class="panel">
      <div class="row">
        <div>
          <label for="fileInput">Source file</label>
          <input id="fileInput" type="file" />
        </div>
        <div>
          <label for="formatSelect">Convert to</label>
          <select id="formatSelect"></select>
        </div>
      </div>

      <button id="convertBtn" disabled>Convert, Save to R2, and Generate Download</button>
      <p id="status" class="status"></p>

      <div id="result" class="result" aria-live="polite">
        <p id="resultText"></p>
        <div class="links">
          <a id="downloadLink" class="link-btn" href="#" target="_blank" rel="noopener">Download converted file</a>
          <a id="cdnLink" class="link-btn" href="#" target="_blank" rel="noopener">Open CDN URL</a>
          <a id="originalLink" class="link-btn" href="#" target="_blank" rel="noopener">Original file</a>
        </div>
      </div>

      <p class="help">
        Notes: conversion runs in your browser using ffmpeg.wasm. For large videos, this can be memory/CPU heavy.
        Your R2 public host should be set in Worker vars as <span class="kbd">BUCKET_PUBLIC_HOST</span>.
      </p>
    </section>
  </main>

  <script type="module">
    import { FFmpeg } from "/vendor/ffmpeg/ffmpeg.js";
    import { fetchFile, toBlobURL } from "/vendor/ffmpeg/util.js";

    const imageFormats = ${JSON.stringify(IMAGE_FORMATS)};
    const videoFormats = ${JSON.stringify(VIDEO_FORMATS)};
    const gifFormats = ${JSON.stringify(GIF_FORMATS)};

    const mimeByExt = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      avif: "image/avif",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska",
      apng: "image/apng"
    };

    const fileInput = document.getElementById("fileInput");
    const formatSelect = document.getElementById("formatSelect");
    const convertBtn = document.getElementById("convertBtn");
    const statusEl = document.getElementById("status");
    const resultEl = document.getElementById("result");
    const resultTextEl = document.getElementById("resultText");
    const downloadLink = document.getElementById("downloadLink");
    const cdnLink = document.getElementById("cdnLink");
    const originalLink = document.getElementById("originalLink");

    const ffmpeg = new FFmpeg();
    let ffmpegLoaded = false;
    let selectedFile = null;
    let selectedCategory = null;

    function setStatus(text, isError = false) {
      statusEl.textContent = text;
      statusEl.className = isError ? "status error" : "status";
    }

    function getExt(filename) {
      const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/i);
      return match ? match[1] : "";
    }

    function getCategory(file) {
      const ext = getExt(file.name);
      if (ext === "gif") return "gif";
      if (file.type.startsWith("image/")) return "image";
      if (file.type.startsWith("video/")) return "video";
      if (["png", "jpg", "jpeg", "webp", "bmp", "tiff", "avif", "apng"].includes(ext)) return "image";
      if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
      return null;
    }

    function formatsForCategory(category) {
      if (category === "image") return imageFormats;
      if (category === "video") return videoFormats;
      if (category === "gif") return gifFormats;
      return [];
    }

    function populateFormats(category, sourceExt) {
      formatSelect.innerHTML = "";
      const formats = formatsForCategory(category).filter((fmt) => fmt !== sourceExt);
      for (const fmt of formats) {
        const option = document.createElement("option");
        option.value = fmt;
        option.textContent = fmt.toUpperCase();
        formatSelect.appendChild(option);
      }
      if (!formats.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No alternative formats";
        formatSelect.appendChild(option);
      }
      convertBtn.disabled = !formats.length;
    }

    async function ensureFFmpegLoaded() {
      if (ffmpegLoaded) return;
      setStatus("Loading conversion engine (first run takes longer)...");
      const workerURL = await toBlobURL(
        "/vendor/ffmpeg/worker.js",
        "text/javascript"
      );
      await ffmpeg.load({
        workerURL,
        coreURL: await toBlobURL("/vendor/ffmpeg/ffmpeg-core.js", "text/javascript"),
        wasmURL: await toBlobURL("/vendor/ffmpeg/ffmpeg-core.wasm", "application/wasm")
      });
      ffmpegLoaded = true;
    }

    function buildFfmpegArgs(category, inputName, outputName, targetExt) {
      if (category === "video" && targetExt === "gif") {
        return ["-i", inputName, "-vf", "fps=12,scale=640:-1:flags=lanczos", "-y", outputName];
      }
      if (category === "gif" && targetExt === "mp4") {
        return ["-i", inputName, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-y", outputName];
      }
      if (targetExt === "jpg" || targetExt === "jpeg") {
        return ["-i", inputName, "-q:v", "2", "-y", outputName];
      }
      return ["-i", inputName, "-y", outputName];
    }

    async function uploadToR2(file, folder) {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("folder", folder);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: fd
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }

      return response.json();
    }

    function humanSize(bytes) {
      if (bytes < 1024) return bytes + " B";
      const units = ["KB", "MB", "GB"];
      let value = bytes / 1024;
      let unit = units[0];
      for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i];
      }
      return value.toFixed(2) + " " + unit;
    }

    fileInput.addEventListener("change", () => {
      resultEl.classList.remove("show");
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        selectedFile = null;
        selectedCategory = null;
        convertBtn.disabled = true;
        formatSelect.innerHTML = "";
        setStatus("");
        return;
      }

      const category = getCategory(file);
      if (!category) {
        selectedFile = null;
        selectedCategory = null;
        convertBtn.disabled = true;
        formatSelect.innerHTML = "";
        setStatus("Unsupported file type. Use image, video, or gif files.", true);
        return;
      }

      selectedFile = file;
      selectedCategory = category;
      const sourceExt = getExt(file.name);
      populateFormats(category, sourceExt);
      setStatus("Selected " + file.name + " (" + humanSize(file.size) + ").");
    });

    convertBtn.addEventListener("click", async () => {
      if (!selectedFile || !selectedCategory) {
        setStatus("Pick a file first.", true);
        return;
      }

      const targetExt = formatSelect.value;
      if (!targetExt) {
        setStatus("Pick a target format.", true);
        return;
      }

      convertBtn.disabled = true;
      resultEl.classList.remove("show");

      try {
        await ensureFFmpegLoaded();

        setStatus("Uploading original file to R2...");
        const originalUpload = await uploadToR2(selectedFile, "originals");

        setStatus("Converting file...");
        const sourceExt = getExt(selectedFile.name) || "bin";
        const sourceBase = selectedFile.name.replace(/\.[^/.]+$/, "") || "output";
        const inputName = "input." + sourceExt;
        const outputName = "output." + targetExt;

        await ffmpeg.writeFile(inputName, await fetchFile(selectedFile));
        const args = buildFfmpegArgs(selectedCategory, inputName, outputName, targetExt);
        await ffmpeg.exec(args);
        const outputData = await ffmpeg.readFile(outputName);

        const outputArray = outputData instanceof Uint8Array ? outputData : new Uint8Array(outputData.buffer);
        const convertedBlob = new Blob([outputArray], { type: mimeByExt[targetExt] || "application/octet-stream" });
        const convertedFile = new File([convertedBlob], sourceBase + "." + targetExt, {
          type: mimeByExt[targetExt] || "application/octet-stream"
        });

        setStatus("Uploading converted file to R2...");
        const convertedUpload = await uploadToR2(convertedFile, "converted");

        resultTextEl.textContent = "Converted " + selectedFile.name + " -> " + convertedFile.name;
        downloadLink.href = convertedUpload.downloadUrl;
        cdnLink.href = convertedUpload.cdnUrl;
        originalLink.href = originalUpload.cdnUrl;
        resultEl.classList.add("show");

        setStatus("Done. Converted file is stored in R2 and ready for download.");

        try {
          await ffmpeg.deleteFile(inputName);
          await ffmpeg.deleteFile(outputName);
        } catch (_) {
        }
      } catch (error) {
        console.error(error);
        setStatus(error instanceof Error ? error.message : "Conversion failed", true);
      } finally {
        convertBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
