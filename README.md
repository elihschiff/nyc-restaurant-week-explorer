# NYC Restaurant Week Explorer

A complete snapshot and interactive explorer for **NYC Restaurant Week Summer 2026** (July 20–August 16, with participating restaurants extending through September 6).

The current snapshot contains **620 restaurants**, **440 downloaded menus**, full menu text, official venue metadata, coordinates, images, prices, meal periods, participation weeks, amenities, accessibility details, and dietary tags.

**Live explorer:** https://elihschiff.github.io/nyc-restaurant-week-explorer/

## Explorer

The responsive web UI includes:

- full-text search across restaurants, cuisines, neighborhoods, descriptions, and menu dishes
- filters for borough, neighborhood, cuisine, price, meal period, week, distance, collections, dietary needs, accessibility, amenities, menus, reservations, and saved places
- featured, alphabetical, distance, price, meal-offer, week, and neighborhood sorting
- list, split, and full-map layouts with clustered markers
- browser geolocation, distance calculations, and radius filtering
- restaurant detail drawers with menu text, menu PDFs, offers, contact details, and directions
- local saved places and shareable URL state
- desktop, tablet, and mobile layouts

### Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Validate a build

```bash
npm run lint
npm run build
```

The GitHub Pages workflow runs `npm run build:pages`, exports the static site to `out/`, and deploys every push to `main`.

## Scraper

The scraper discovers the public API used by NYC Tourism's Restaurant Week page, downloads the public restaurant detail pages and menu PDFs, extracts PDF text (including OCR fallback), and writes normalized JSON, NDJSON, CSV, validation data, and a raw archive.

No account, browser profile, or private credential is required. The public site's browser API key is discovered from the current JavaScript bundle at runtime and is not saved to disk.

```bash
python3 scrape_restaurant_week.py \
  --output-dir data/summer-2026-$(date +%F)
```

Useful options:

```bash
python3 scrape_restaurant_week.py --help
python3 scrape_restaurant_week.py --skip-menus
python3 scrape_restaurant_week.py --skip-details
```

The checked local snapshot lives at:

```text
data/summer-2026-2026-07-18/
├── nyc_restaurant_week_summer_2026.json
├── nyc_restaurant_week_summer_2026.ndjson
├── nyc_restaurant_week_summer_2026.csv
├── nyc_restaurant_week_summer_2026.raw.json
├── validation_report.json
├── menus/
└── raw/
```

After taking a new snapshot, update the source path in `scripts/build_ui_data.py` if needed and rebuild the browser dataset:

```bash
npm run data:build
```

This writes the deployable UI dataset to `public/data/restaurants.json`.

## Data notes

- Snapshot generated July 18, 2026.
- 615 official restaurant detail pages were captured successfully.
- Five official detail pages returned HTTP 500; their map locations were supplemented from the restaurants' published addresses.
- The source can change during the event. Rerun the scraper for a fresh snapshot.
- Map rendering uses MapLibre GL with OpenFreeMap tiles and OpenStreetMap data.
