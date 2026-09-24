# LocaStack brand

Mark: **Dominant** — a 2×2 field of rounded cells on a 24-unit grid, three cells at 28–40% ink and one larger lit cell (the local node). 22% corner radius.

- `mark.svg` — monochrome mark, `currentColor`; use inline in UI at 16–32 px.
- `favicon.svg` — mark with light/dark `prefers-color-scheme` handling; served from `packages/dashboard/public/`.
- `app-icon.svg` — 512×512 dark squircle app icon (macOS/PWA/README).
- React: `packages/dashboard/src/shared/brand/logo.tsx` exports `LogoMark` and `Logo` (mark + wordmark).

Wordmark: "LocaStack" in Geist 600, letter-spacing −0.02em (−0.03em above 24 px). Lit cell may take the brand accent when one is chosen; everything else stays neutral.
