# Savannah Trace — brand guidelines

Version 1.0 · 8 November 2026 · owner: Savannah Fruits Company Limited (SFCL)
Visual sheet: [`docs/brand/brand-guidelines.html`](brand/brand-guidelines.html) (open in a browser). Logo files: [`docs/brand/`](brand/).

## 1. The name

**Savannah Trace** is SFCL's chain-of-custody system for organic shea: from the collection areas of northern Ghana, through post-harvest, butter centres, the warehouse and export, to refining or filtering in Amsterdam and the client.

- Write it as two words, both capitalised: **Savannah Trace**. Never *SavannahTrace*, *Savanna Trace* or *S-Trace*. Do not abbreviate it to *ST*.
- In running text, the company stays **Savannah Fruits Company** (or *SFCL* internally). Savannah Trace is the product and SFCL is the issuer: "Issued by Savannah Fruits Company Limited through Savannah Trace."
- Descriptor, when one is needed: *chain-of-custody traceability for organic shea*.

## 2. Personality and voice

**Exact, calm, accountable.** The product's job is to be believed by auditors, certifiers and clients.

| We are | We are not |
|---|---|
| Plain: "Received 4,250 kg at Tamba Butter Centre" | Promotional: "Seamless end-to-end visibility!" |
| Specific: lot IDs, kilograms, dates, places | Vague: "your products", "the supply chain" |
| Honest about limits: "Trace geometry is illustrative" | Over-claiming: "GPS-verified", "blockchain-secured" |
| Respectful of collectors: names never public | Extractive: individual collectors on customer pages |

Sentence case everywhere: buttons, headings and menus. Use numerals and units (`20,160 kg`, `3 Nov 2026`). Don't use exclamation marks or emoji in the product.

## 3. Logo

### The mark

A Shea-gold sun rising over the savannah horizon. Below it, a route runs from an **origin lot** (ivory square) to a **destination lot** (gold square). The place, the product and the custody chain are in one glyph. The lots are square because the interface is square: every lot is a box with an ID.

The mark is built on a 32-unit grid:

- tile: 32 × 32, radius 1.5
- sun: radius 9, centred at (16, 16)
- horizon: 25 × 1.8
- route: 14 × 1.4
- lots: 4.8 × 4.8

### Lockups and files

| File | Use |
|---|---|
| `savannah-trace-logo.svg` | Primary: mark + wordmark on white or Kernel Ivory |
| `savannah-trace-logo-reversed.svg` | On Baobab or Charcoal: glyph without tile, *Trace* in Shea Gold |
| `savannah-trace-logo-mono.svg` | One ink: stamps, fax, engraving, single-colour print |
| `savannah-trace-mark.svg` | App icon, favicon (`public/favicon.svg`), avatars, small spaces |
| `savannah-trace-icon-square.svg` | Full-bleed square for app stores and OS icons that apply their own mask |

The wordmark is IBM Plex Sans: **Savannah** in SemiBold (600) and **Trace** in Regular (400), tracking −1%. *Trace* is set in Baobab 600 on light grounds and in Shea Gold on dark grounds. The SVG files have the letters outlined, so they render without the font installed.

### Clear space and minimum size

- **Clear space:** keep at least the width of one lot square (0.15 × the mark's height) clear on all sides. Around the full lockup, keep half the mark's height.
- **Minimum size:** the mark at 16 px on screen or 5 mm in print; the lockup at 120 px or 30 mm wide. Below that, use the mark alone.

### Don't

- Recolour the sun, the lots or the tile, or swap gold and ivory.
- Round the tile further, put the mark in a circle, or add a drop shadow, outline, gradient or glow.
- Stretch it, rotate it, or set the wordmark in another typeface or weight.
- Place the primary logo on photography or mid-tones. Use the reversed logo on a solid Baobab or Charcoal panel instead.
- Combine the mark with the SFCL company logo into a new symbol. Show them side by side, separated by a hairline rule.

## 4. Colour

### Core palette

| Name | Hex | RGB | Role |
|---|---|---|---|
| **Baobab** | `#1C4532` | 28 69 50 | Primary brand colour. Logo tile, primary buttons, customer page header |
| **Baobab 600** | `#2A6046` | 42 96 70 | Links, hover, focus ring, *Trace* in the wordmark, success |
| **Shea Gold** | `#D2A24C` | 210 162 76 | Accent: the sun, the destination lot, *Trace* on dark grounds. **Never text on light grounds** |
| **Kernel Ivory** | `#F6F3EB` | 246 243 235 | Page background, reversed text |
| **Charcoal** | `#16191A` | 22 25 26 | Body text, mono logo |

### Neutrals

| Name | Hex | Role |
|---|---|---|
| White | `#FFFFFF` | Panels and tables (surface) |
| Parchment | `#F0ECE2` | Secondary surface, table headers |
| Sand | `#E5E0D3` | Tertiary surface, selected rows |
| Stone | `#DCD6C8` | Hairline rules and borders (decorative, not for meaning) |
| Stone strong | `#B5AE9E` | Input borders, strong dividers |
| Graphite | `#3A3D39` | Secondary text |
| Slate | `#5A5D55` | Muted text, captions |
| Baobab wash | `#E8EEE8` | Positive background tint |

### Functional colours (state only, never decoration)

| Name | Text | Wash | Meaning |
|---|---|---|---|
| Harmattan | `#8A5A10` | `#F6EDDB` | Needs review, warnings, demo labels |
| Laterite | `#9B3B26` | `#F6E5DF` | Blocking findings, errors, destructive actions |
| Volta | `#2C5466` | `#E3EBEE` | Information, in-transit |

### Product colours (maps, genealogy, markers)

- OFN, raw nuts: `#8A5A2B`
- ODK, kernels: `#B7821C`
- OSB, butter: `#2A6046`
- Refined or filtered: `#2F6F73`

### Proportion

Roughly **70% Ivory and white, 20% Charcoal text, 8% Baobab, 2% Shea Gold**. Gold is a signature, not a fill. If a screen looks gold, there is too much.

### Contrast (WCAG 2.1)

Measured on the actual hex values:

| Pair | Ratio | Result |
|---|---|---|
| Charcoal on Ivory | 15.9 : 1 | AAA |
| Slate on Ivory | 6.1 : 1 | AA (AAA large) |
| Baobab on Ivory | 9.7 : 1 | AAA |
| Baobab 600 on white | 7.3 : 1 | AAA |
| Ivory on Baobab | 9.7 : 1 | AAA |
| Shea Gold on Baobab | 4.6 : 1 | AA |
| Shea Gold on Charcoal | 7.6 : 1 | AAA |
| Harmattan on its wash | 5.1 : 1 | AA |
| Laterite on its wash | 5.6 : 1 | AA |
| Volta on its wash | 6.8 : 1 | AA |
| **Shea Gold on Ivory** | **2.1 : 1** | **Fails: never use gold for text or meaningful icons on light grounds** |

## 5. Typography

- **IBM Plex Sans** for all interface and document text. Use weights 400, 500 and 600 only.
- **IBM Plex Mono** for identifiers and quantities: lot IDs (`ORSB 26901-R1`), LPO and SFCL numbers, kilograms in tables, timestamps in audit logs.
- Both are open-source (SIL OFL) and bundled with the app (`@fontsource`), so no font is loaded from a third party. In email, fall back to Arial and Consolas.

The app uses this scale (px): 26 customer title, 22 page title, 15 section, 14 body, 13 secondary, 12 caption, 11 eyebrow (uppercase, +8% tracking).

## 6. Interface rules

These rules are permanent:

- **Square geometry.** Controls use a 2 px radius, and nothing exceeds 4 px. No capsules, lozenges or pill buttons.
- **Flat navigation.** Sidebar links are compact and sit on a transparent background. The active item is shown only by a weight change (600) and a stronger icon. There is no tinted background, no coloured left stripe and no card around links.
- **Hairlines, not shadows.** Separate with 1 px Stone rules. No decorative shadows and no gradients.
- **Colour carries meaning.** Baobab is for primary action, the functional colours are for state, and the product colours are for data.
- **Icons:** Lucide, 16–18 px, 1.75 stroke. Use the custom event markers on maps and timelines.

## 7. Applications

- **Customer trace page:** Baobab header with the reversed lockup and "Savannah Fruits Company" as issuer. Every customer link and QR code should resolve to `trace.savannahfruits.com`.
- **Email** (`supabase/templates/`): an Ivory canvas, a white card and a Baobab header band with a live-text wordmark, with no images (images are often blocked). The 6-digit code is set in Plex Mono, Baobab, 30 px.
- **Exports:** CSV files carry no styling. PDF reports, when added, should use the primary lockup top-left, Charcoal text, Stone rules and a footer that names the issuer and the export date.
- **QR codes:** Charcoal on white with a quiet zone of 4 modules. Do not put the logo inside the code. Place the mark beside it with the caption "Scan to trace this lot".
- **Favicon and app icon:** `public/favicon.svg` and `public/apple-touch-icon.png` (180 px).

## 8. Source of truth

- **CSS tokens:** `src/styles.css`, at `:root`, with the palette names above.
- **React:** `src/components/Brand.tsx` (`BrandMark`, `Wordmark`).
- **Logo files:** `docs/brand/`.

If a colour or the mark's geometry changes, update all three together.
