#!/usr/bin/env python3
"""Build the compact browser dataset used by the Restaurant Week explorer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


LOCATION_FALLBACKS: dict[str, dict[str, Any]] = {
    # Five NYC Tourism detail pages returned HTTP 500 during this snapshot.
    # Addresses/phones come from the restaurants' sites; coordinates are the
    # corresponding OpenStreetMap Nominatim address matches from 2026-07-18.
    "alta-calidad": {
        "address": {
            "raw": "552 Vanderbilt Avenue, Brooklyn, NY 11238",
            "street": "552 Vanderbilt Avenue",
            "locality": "Brooklyn",
            "state": "NY",
            "postal_code": "11238",
        },
        "coordinates": {"lat": 40.6801088, "lon": -73.9681963},
        "phone": "718-622-1111",
    },
    "catria-nyc": {
        "address": {
            "raw": "461 W 34th St, New York, NY 10001",
            "street": "461 W 34th St",
            "locality": "New York",
            "state": "NY",
            "postal_code": "10001",
        },
        "coordinates": {"lat": 40.7546901, "lon": -73.9986506},
        "phone": "646-437-6740",
    },
    "city-vineyard": {
        "address": {
            "raw": "233 West Street (Pier 26), New York, NY 10013",
            "street": "233 West Street (Pier 26)",
            "locality": "New York",
            "state": "NY",
            "postal_code": "10013",
        },
        "coordinates": {"lat": 40.7213004, "lon": -74.0116974},
    },
    "kru": {
        "address": {
            "raw": "190 N 14th St, Brooklyn, NY 11249",
            "street": "190 N 14th St",
            "locality": "Brooklyn",
            "state": "NY",
            "postal_code": "11249",
        },
        "coordinates": {"lat": 40.7228203, "lon": -73.9557852},
    },
    "sushi-of-gari-46": {
        "address": {
            "raw": "347 West 46th Street, New York, NY 10036",
            "street": "347 West 46th Street",
            "locality": "New York",
            "state": "NY",
            "postal_code": "10036",
        },
        "coordinates": {"lat": 40.7607070, "lon": -73.9895762},
        "phone": "212-957-0046",
    },
}


def compact_restaurant(item: dict[str, Any]) -> dict[str, Any]:
    fallback = LOCATION_FALLBACKS.get(item["slug"], {})
    menu = item.get("menu") or {}
    images = [
        {
            "url": image.get("url"),
            "alt": image.get("alt"),
            "credit": image.get("credit"),
        }
        for image in item.get("images") or []
        if image.get("url")
    ]
    return {
        "name": item.get("name"),
        "slug": item.get("slug"),
        "officialDetailUrl": item.get("official_detail_url"),
        "borough": item.get("borough"),
        "neighborhood": item.get("neighborhood"),
        "summary": item.get("summary"),
        "description": item.get("description"),
        "website": item.get("website"),
        "phone": item.get("phone") or fallback.get("phone"),
        "address": item.get("address") or fallback.get("address"),
        "coordinates": item.get("coordinates") or fallback.get("coordinates"),
        "cuisines": item.get("cuisines") or [],
        "accessibility": item.get("accessibility") or [],
        "dietaryNeeds": item.get("dietary_needs") or [],
        "amenities": item.get("amenities") or [],
        "costCategories": item.get("cost_categories") or [],
        "mealTypes": item.get("meal_types") or [],
        "mealPrices": item.get("meal_prices") or {},
        "weeksParticipating": item.get("weeks_participating") or [],
        "collections": item.get("collections") or [],
        "menu": (
            {
                "url": menu.get("url"),
                "text": menu.get("extracted_text"),
                "pages": (menu.get("pdf_metadata") or {}).get("pages"),
                "extractionMethod": (menu.get("pdf_metadata") or {}).get(
                    "text_extraction_method"
                ),
            }
            if menu
            else None
        ),
        "reservation": item.get("reservation"),
        "gridImage": item.get("grid_image"),
        "images": images,
        "social": item.get("social") or {},
        "detailSourceError": bool(item.get("detail_scrape_error")),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("data/summer-2026-2026-07-18/nyc_restaurant_week_summer_2026.json"),
    )
    parser.add_argument(
        "--output", type=Path, default=Path("public/data/restaurants.json")
    )
    args = parser.parse_args()

    source = json.loads(args.input.read_text("utf-8"))
    restaurants = [compact_restaurant(item) for item in source["restaurants"]]
    output = {
        "generatedAt": source.get("generated_at"),
        "event": source.get("event"),
        "stats": {
            "restaurants": len(restaurants),
            "mappedRestaurants": sum(
                bool(item.get("coordinates")) for item in restaurants
            ),
            "restaurantsWithMenus": sum(bool(item.get("menu")) for item in restaurants),
            "boroughs": source.get("stats", {}).get("boroughs", {}),
        },
        "restaurants": restaurants,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(restaurants)} restaurants "
        f"({args.output.stat().st_size / 1024 / 1024:.1f} MiB) to {args.output}"
    )


if __name__ == "__main__":
    main()
