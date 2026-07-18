# NYC Restaurant Week Explorer

A complete snapshot and interactive explorer for **NYC Restaurant Week Summer 2026** (July 20–August 16, with participating restaurants extending through September 6).

The current snapshot contains **620 restaurants**, **440 downloaded menus**, full menu text, official venue metadata, coordinates, images, prices, meal periods, participation weeks, amenities, accessibility details, dietary tags, and NYC Health inspection data for **582 matched venues**.

**Live explorer:** https://elihschiff.github.io/nyc-restaurant-week-explorer/

## Explorer

The responsive web UI includes:

- full-text search across restaurants, cuisines, neighborhoods, descriptions, and menu dishes
- filters for borough, neighborhood, cuisine, price, meal period, week, distance, NYC health grade, collections, dietary needs, accessibility, amenities, menus, reservations, and saved places
- featured, alphabetical, distance, price, meal-offer, week, neighborhood, health-grade, and inspection-score sorting
- list, split, and full-map layouts with clustered markers
- browser geolocation, distance calculations, and radius filtering
- restaurant detail drawers with menu text, menu PDFs, offers, contact details, directions, NYC health grades, recent inspection scores, and violations
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

### NYC Health inspection enrichment

The health enrichment script matches venues conservatively against the public NYC Health ABC Eats restaurant list, fetches recent inspection details for confident matches, and writes grades, scores, recent history, and violation details into the browser dataset:

```bash
npm run data:health
```

Responses are cached in the ignored `data/abc-eats-cache/` directory so repeat runs do not refetch unchanged records. Use `python3 scripts/enrich_health_inspections.py --refresh` to force a fresh pull. The ignored `data/health-inspection-match-report.json` records the matching evidence and uncertain venues for review.

`npm run data:refresh` rebuilds the Restaurant Week browser data and then applies the health enrichment in one command.

## Data notes

- Snapshot generated July 18, 2026.
- 615 official restaurant detail pages were captured successfully.
- Five official detail pages returned HTTP 500; their map locations were supplemented from the restaurants' published addresses.
- Inspection records come from NYC Health's public [ABC Eats](https://a816-health.nyc.gov/ABCEatsRestaurants/) endpoints. Current grades and latest inspection scores are different measures; lower inspection scores mean fewer violation points.
- Health matching deliberately leaves uncertain venues unmatched rather than risk showing another business's inspection record.
- The source can change during the event. Rerun the scraper for a fresh snapshot.
- Map rendering uses MapLibre GL with OpenFreeMap tiles and OpenStreetMap data.
