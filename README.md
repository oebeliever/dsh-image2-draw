# DSH Image2 Draw (gpt-image-2 generation plugin)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-web%20profile-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-brightgreen)

Adds **Image2 (`gpt-image-2`) generation** to [DeepSeek Harness](https://github.com/deepseek-ai):
text-to-image and image-to-image through any **OpenAI Images-compatible relay API**.
Configure only a `baseURL` and an `API Key`, and generated images appear directly in
the conversation (thumbnails, zoom, Save As) while also landing in `outputs/image2/`.

> **Community fork** — this repository is a maintained fork of the MIT-licensed
> [JuneLearn/dsh-image2-draw](https://github.com/JuneLearn/dsh-image2-draw) with
> gateway-compatibility fixes (see [Fork changes](#fork-changes)). Upstream
> copyright and license are preserved in [LICENSE](./LICENSE).

**Quick install** — pick one line and run it in your terminal:

```bash
# Already running DSH (web profile):
dsh plugin --profile web add github:oebeliever/dsh-image2-draw

# Brand-new machine, one click (auto-installs Node/pnpm/DSH):
# Windows PowerShell:
irm https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.ps1 | iex
# macOS / Linux:
curl -fsSL https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.sh | bash
```

Then restart DSH (`dsh web`), open **Settings → Plugins → Plugin config → Image2 生图**,
enter the `API Key` and `baseURL` of any OpenAI-Images-compatible relay (e.g.
`https://example.com/v1`, `/images/generations` is appended automatically), and ask the
AI to call `image2-generate`. [中文说明](./README.zh-CN.md)

---

## Features

- Adds an **Image2 Draw** settings card under **Settings → Plugins → Plugin config**.
- Requires only a `baseURL` and an `API Key`; default model is `gpt-image-2`.
- Accepts a short base URL like `https://example.com/v1` and appends
  `/images/generations` automatically.
- Derives the image-edit endpoint as `/images/edits` (optional explicit `editURL`).
- `image2-generate` — text-to-image, 1–8 images, sequential requests (no concurrency).
- `image2-edit` — image-to-image with 1–8 PNG / JPEG / WebP reference images.
- Quality levels `low` / `medium` / `high` / `auto` (depends on relay support).
- In-conversation tool card with thumbnails, zoom and Save As; files also saved to
  `outputs/image2/image2-<timestamp>[-N].<ext>`, auto-numbered on name collision.
- **Chat-dock studio** (🎨 above the input box): text-to-image, image-to-image with
  click/drag-drop upload, and a **multi-view character** mode — upload 2–8 photos of
  the same person from different angles and generate new shots that keep the person's
  face, build and hairstyle consistent (multi-source-image `edits` semantics).
- Sizes: adaptive from prompt keywords, `auto` passthrough, gateway-friendly presets
  (`1024x1024` / `1536x1024` / `1024x1536` / `3840x2160` …) and validated custom
  `WIDTHxHEIGHT` (16px multiples, ≤ 3840 edge, 655,360–8,294,400 px², ratio ≤ 3:1).
- API key stored in DSH credentials only — never in the plain settings document and
  never returned by the plugin state endpoint. (Or set the `IMAGE2_API_KEY` env var.)
- Validates settings writes, response sizes, timeouts and input images; HTTP 524 and
  timeouts are **not** auto-retried, avoiding duplicate upstream charges.

## Fork changes

**v0.2.0**

- Size handling aligned with OpenAI Images spec used by common relays (e.g. zzz /
  OpenAI-compatible gateways): `auto` is passed through as-is; portrait/landscape
  presets moved from `768x1024/1024x768` to gateway-safe `1024x1536/1536x1024`;
  documented presets `1024x1024 / 1536x1024 / 1024x1536 / 3840x2160` short-circuit
  validation and go straight to the API.
- `/images/edits` now always sends **repeated standard `image` fields** for multiple
  source images (previously a non-standard `image[]` field for >1 image). This matches
  the OpenAI multi-source-image semantics and unblocks **multi-view character
  consistency** (several photos of the same person → one new image of that person).
  `refs` also accepts **conversation attachment ids (`sha256:…`)** directly — the
  plugin reads them from the attachment store, no local paths or vision tool needed.
- New chat-dock **🎨 studio** (`conversation.input.dock`): text-to-image /
  image-to-image / multi-view character tabs, click & drag-drop upload with previews,
  an "assemble consistency prompt" helper, background task + polling, and result
  gallery with Save As. Studio results live in `~/.dsh/storages/image2-draw/library/`
  (survives restarts), independent from conversation-tool outputs.
- Clearer "no key / wrong group" message (keys must belong to the relay's Image group
  when the relay separates models by token group).

**v0.1.1 (vs upstream v0.1.0)**

- Removed the non-standard `output_format` field from the generations payload — some
  OpenAI-compatible gateways reject it (standard params only: `model/prompt/size/quality/n`).
- `redirect: 'manual'` with clear diagnostics for 3xx responses, including a dedicated
  message for upstream `region-unavailable` (e.g. mainland-China IP blocked — switch to an
  overseas proxy node or another relay).
- Friendlier "not valid JSON" errors that include the actual upstream snippet (gateway
  error page / region block page / wrong baseURL).
- Fixed the settings-card slot registration (`key: 'image2-draw'`) so the card loads
  reliably on current Harness client versions.

## Prerequisites

- [Node.js](https://nodejs.org/) — DSH supports Node 22.19.x or ≥ 24 (24 LTS recommended).
- [Git](https://git-scm.com/) — to fetch plugins from GitHub.
- pnpm — `dsh plugin` runs pnpm in the profile directory (`corepack enable` is enough).
- Network access to `registry.npmjs.org` and `github.com`. From restricted networks,
  set `HTTP_PROXY` / `HTTPS_PROXY` (and `npm_config_proxy`) in the current shell.

## Installation

### Method A — brand-new machine, one click

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/oebeliever/dsh-image2-draw/main/install.sh | bash
```

The script checks Node.js (installs the LTS via winget on Windows if missing), enables
pnpm, globally installs `@deepseek-ai/dsh` when absent, adds this plugin to the `web`
profile, then prints the startup guide.

### Method B — DSH already installed, one command

```bash
dsh plugin --profile web add github:oebeliever/dsh-image2-draw
```

Restart DSH afterwards (`dsh web`); the plugin auto-joins the profile bundle layer via
its `dsh.bundle` declaration — no manual patch editing.

### Method C — no global install, via npx (first run is slower)

```bash
npx --yes -p @deepseek-ai/dsh dsh plugin --profile web add github:oebeliever/dsh-image2-draw
```

Launch the same way afterwards: `npx --yes -p @deepseek-ai/dsh dsh web`.

## Upgrade & uninstall

Upgrade = re-run the same install command (fetches the latest commit), then restart dsh.

Uninstall:

```bash
dsh plugin --profile web remove dsh-image2-draw
```

Restart `dsh web`; the card and tools disappear (images already saved to
`outputs/image2/` are kept).

## Usage

1. **Settings → Plugins → Plugin config → Image2 生图**.
2. Fill in `API Key` and `baseURL` (e.g. `https://example.com/v1`) from your relay.
3. Adjust model / edit endpoint / timeout only if needed; defaults usually work.
4. Save, start a new session, and ask the model to call `image2-generate`, or pass
   reference-image paths to `image2-edit`.
5. Prefer the graphical way for image inputs: open the **🎨 Image2 生图工作台** above
   the input box, pick a tab (文生图 / 图生图 / 多视角人物), drop images in and generate.

Example prompts:

```text
Call image2-generate to create a portrait cinematic poster of a future city at high quality.
```

```text
Call image2-edit with D:\images\room.png and restyle the room with light Japanese wood while preserving the layout.
```

Whether the relay actually supports `gpt-image-2`, editing, custom sizes and quality
levels is up to the provider. HTTP 400 / 404 → check the provider's model name and
Images endpoint format. Size errors → most gateways accept only `auto` / `1024x1024` /
`1536x1024` / `1024x1536` / `3840x2160`; pick a preset instead of a custom `WIDTHxHEIGHT`.
`region-unavailable` → the relay blocks your exit IP region;
switch to an overseas proxy or another provider.

## Limits

- Text-to-image: 1–8 images per call, sent one by one.
- Image-to-image: 1–8 reference images, ≤ 4MB each, ≤ 32MB total.
- References must be PNG / JPEG / WebP; real format is sniffed from magic bytes.
- Relative reference paths resolve against the current session working directory.
- Default timeout 180 s (configurable 1–3600 s); remote result download ≤ 32MB.

## Development

```bash
node --check lib/index.js
node --check lib/client.js
```

Unit tests (`node tests/plugin.test.mjs`) import the `@deepseek-ai/*` runtime peer
packages, so run them inside an environment where those are installed — a DSH profile's
`node_modules` or a Harness source workspace — rather than in a bare checkout.

## Acknowledgements

Original plugin by [JuneLearn](https://github.com/JuneLearn) (MIT). Parts of the
in-conversation attachment and tool-card implementation were adapted from the
MIT-licensed [dsh-multimodal](https://github.com/MC5lan/dsh-multimodal) — see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE) — upstream © 2026 JuneLearn; fork © 2026 oebeliever.
