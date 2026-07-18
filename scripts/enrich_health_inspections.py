#!/usr/bin/env python3
"""Match Restaurant Week venues to NYC Health's ABC Eats inspection records.

The script uses the public ABC Eats endpoints that power NYC's restaurant
inspection search. It intentionally keeps conservative matching thresholds:
an uncertain restaurant is better left unmatched than assigned another
business's inspection history.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


BOROUGHS = ("Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island")
BOROUGH_URL = (
    "https://a816-health.nyc.gov/ABCEatsRestaurants/App/GetEntitiesByBoro/{borough}"
)
DETAIL_URL = (
    "https://a816-health.nyc.gov/ABCEatsRestaurants/App/GetEntityDetail?camisId={camis}"
)
OFFICIAL_URL = "https://a816-health.nyc.gov/ABCEatsRestaurants/#!/Search/{camis}"
SOCRATA_URL = "https://data.cityofnewyork.us/resource/43nn-pn8j.json"
USER_AGENT = "NYC-Restaurant-Week-Explorer/1.0 (public-data refresh)"

BOROUGH_ALIASES = {"The Bronx": "Bronx"}
NAME_LOCATION_PHRASES = (
    "times square",
    "upper east side",
    "upper west side",
    "lower east side",
    "midtown east",
    "midtown west",
    "midtown",
    "financial district",
    "flatiron district",
    "flatiron",
    "union square",
    "bryant park",
    "battery park",
    "rockefeller center",
    "columbus circle",
    "hudson yards",
    "grand central",
    "williamsburg",
    "brooklyn heights",
    "downtown brooklyn",
    "long island city",
    "manhattan",
    "brooklyn",
    "queens",
    "staten island",
    "bronx",
    "nyc",
    "new york",
)
NAME_NOISE = {"restaurant", "restaurants", "the"}
STREET_REPLACEMENTS = {
    "avenue": "ave",
    "av": "ave",
    "street": "st",
    "road": "rd",
    "boulevard": "blvd",
    "place": "pl",
    "lane": "ln",
    "drive": "dr",
    "parkway": "pkwy",
    "highway": "hwy",
    "east": "e",
    "west": "w",
    "north": "n",
    "south": "s",
}


def fetch_json(url: str, *, attempts: int = 4) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(0.8 * (2**attempt))
    raise RuntimeError("unreachable")


def cache_is_fresh(path: Path, max_age_hours: int = 18) -> bool:
    if not path.exists():
        return False
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    return datetime.now(UTC) - modified < timedelta(hours=max_age_hours)


def cached_json(path: Path, url: str, *, refresh: bool) -> Any:
    if not refresh and cache_is_fresh(path):
        return json.loads(path.read_text("utf-8"))
    data = fetch_json(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def ascii_text(value: Any) -> str:
    return unicodedata.normalize("NFKD", str(value or "")).encode(
        "ascii", "ignore"
    ).decode()


def normalized_words(value: Any) -> list[str]:
    text = ascii_text(value).lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return [word for word in text.split() if word]


def normalize_name(value: Any, *, remove_locations: bool = True) -> str:
    text = " ".join(normalized_words(value))
    if remove_locations:
        for phrase in NAME_LOCATION_PHRASES:
            text = re.sub(rf"\b{re.escape(phrase)}\b", " ", text)
    words = [word for word in text.split() if word not in NAME_NOISE]
    return " ".join(words)


def normalize_address(value: Any) -> str:
    words = normalized_words(value)
    normalized: list[str] = []
    for word in words:
        word = re.sub(r"(?<=\d)(st|nd|rd|th)$", "", word)
        word = STREET_REPLACEMENTS.get(word, word)
        if word not in {"new", "york", "ny"}:
            normalized.append(word)
    return " ".join(normalized)


def normalized_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) == 10 else ""


def similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    sequence = SequenceMatcher(None, left, right).ratio()
    left_words, right_words = set(left.split()), set(right.split())
    overlap = len(left_words & right_words) / max(
        1, min(len(left_words), len(right_words))
    )
    return max(sequence, overlap * 0.92)


def miles_between(
    lat1: float | None,
    lon1: float | None,
    lat2: float | None,
    lon2: float | None,
) -> float | None:
    if None in {lat1, lon1, lat2, lon2}:
        return None
    lat1r, lat2r = math.radians(float(lat1)), math.radians(float(lat2))
    dlat = lat2r - lat1r
    dlon = math.radians(float(lon2) - float(lon1))
    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1r) * math.cos(lat2r) * math.sin(dlon / 2) ** 2
    )
    return 3958.8 * 2 * math.asin(math.sqrt(value))


def chunks(values: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def fetch_phone_camises(
    phones: list[str], cache_dir: Path, *, refresh: bool
) -> dict[str, set[str]]:
    cache_path = cache_dir / "socrata-phone-camises.json"
    if not refresh and cache_is_fresh(cache_path):
        stored = json.loads(cache_path.read_text("utf-8"))
        if set(phones).issubset(set(stored.get("queriedPhones", []))):
            return {
                phone: set(camises)
                for phone, camises in stored.get("camisesByPhone", {}).items()
            }

    phone_camises: dict[str, set[str]] = defaultdict(set)
    for group in chunks(sorted(set(phones)), 35):
        literals = ",".join(f"'{phone}'" for phone in group)
        query = urllib.parse.urlencode(
            {
                "$select": "camis,phone",
                "$where": f"phone in({literals})",
                "$limit": "50000",
            }
        )
        for row in fetch_json(f"{SOCRATA_URL}?{query}"):
            phone = normalized_phone(row.get("phone"))
            camis = str(row.get("camis") or "")
            if phone and camis:
                phone_camises[phone].add(camis)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "queriedPhones": sorted(set(phones)),
                "camisesByPhone": {
                    phone: sorted(camises)
                    for phone, camises in sorted(phone_camises.items())
                },
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return phone_camises


def fetch_borough_restaurants(cache_dir: Path, *, refresh: bool) -> list[dict[str, Any]]:
    restaurants: list[dict[str, Any]] = []
    for borough in BOROUGHS:
        path = cache_dir / f"borough-{borough.lower().replace(' ', '-')}.json"
        restaurants.extend(
            cached_json(
                path,
                BOROUGH_URL.format(borough=urllib.parse.quote(borough)),
                refresh=refresh,
            )
        )
    return restaurants


def candidate_features(
    restaurant: dict[str, Any],
    health: dict[str, Any],
    phone_match: bool,
    rw_name: str,
    rw_address: str,
) -> dict[str, Any]:
    health_name = health["_normalizedName"]
    health_address = health["_normalizedAddress"]
    coordinates = restaurant.get("coordinates") or {}
    distance = miles_between(
        coordinates.get("lat"),
        coordinates.get("lon", coordinates.get("lng")),
        health.get("MostRecent_Latitude"),
        health.get("MostRecent_Longitude"),
    )
    same_zip = bool(
        (restaurant.get("address") or {}).get("postal_code")
        and str((restaurant.get("address") or {}).get("postal_code"))
        == str(health.get("MostRecentZipCode") or "")
    )
    name_score = similarity(rw_name, health_name)
    address_score = similarity(rw_address, health_address)
    distance_score = 0.0 if distance is None else max(0.0, 1 - distance / 0.8)
    total = (
        name_score * 0.55
        + address_score * 0.20
        + distance_score * 0.15
        + float(same_zip) * 0.03
        + float(phone_match) * 0.22
    )
    # A shared reservation/hotel phone can point at multiple venues. Penalize
    # a far-away candidate unless the street address is an exact-level match.
    if distance is not None and distance > 0.75 and address_score < 0.90:
        total -= 0.20
    return {
        "name": round(name_score, 4),
        "address": round(address_score, 4),
        "distanceMiles": round(distance, 4) if distance is not None else None,
        "sameZip": same_zip,
        "phone": phone_match,
        "total": round(total, 4),
    }


def is_confident(features: dict[str, Any]) -> bool:
    name = features["name"]
    address = features["address"]
    distance = features["distanceMiles"]
    nearby = distance is not None and distance <= 0.35
    very_nearby = distance is not None and distance <= 0.10
    same_zip = features["sameZip"]

    if features["phone"] and (name >= 0.48 or address >= 0.72 or very_nearby):
        return True
    if name >= 0.98 and (same_zip or nearby or address >= 0.68):
        return True
    if name >= 0.84 and nearby:
        return True
    if name >= 0.72 and address >= 0.72 and (same_zip or nearby):
        return True
    if name >= 0.62 and address >= 0.91 and nearby:
        return True
    return False


def match_restaurants(
    restaurants: list[dict[str, Any]],
    health_rows: list[dict[str, Any]],
    phone_camises: dict[str, set[str]],
) -> tuple[dict[str, tuple[dict[str, Any], dict[str, Any]]], list[dict[str, Any]]]:
    by_camis = {str(row.get("CurrentDecalNumber")): row for row in health_rows}
    by_name: dict[tuple[str, str], list[str]] = defaultdict(list)
    by_address: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    by_grid: dict[tuple[str, int, int], list[str]] = defaultdict(list)

    for camis, row in by_camis.items():
        borough = str(row.get("MostRecentVendingBoro") or "")
        name = normalize_name(row.get("EntityName"))
        address = normalize_address(row.get("MostRecentVendingLocation"))
        row["_normalizedName"] = name
        row["_normalizedAddress"] = address
        if name:
            by_name[(borough, name)].append(camis)
        if address:
            by_address[(borough, str(row.get("MostRecentZipCode") or ""), address)].append(
                camis
            )
        lat, lon = row.get("MostRecent_Latitude"), row.get("MostRecent_Longitude")
        if lat is not None and lon is not None:
            by_grid[(borough, round(float(lat) * 1000), round(float(lon) * 1000))].append(
                camis
            )

    matches: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    report: list[dict[str, Any]] = []
    for restaurant in restaurants:
        borough = BOROUGH_ALIASES.get(restaurant.get("borough"), restaurant.get("borough"))
        phone = normalized_phone(restaurant.get("phone"))
        name = normalize_name(restaurant.get("name"))
        address_data = restaurant.get("address") or {}
        address = normalize_address(address_data.get("street"))
        match_address = normalize_address(address_data.get("raw") or address_data.get("street"))
        zip_code = str(address_data.get("postal_code") or "")
        candidates: set[str] = set(phone_camises.get(phone, set())) if phone else set()
        candidates.update(by_name.get((borough, name), []))
        candidates.update(by_address.get((borough, zip_code, address), []))

        coordinates = restaurant.get("coordinates") or {}
        lat = coordinates.get("lat")
        lon = coordinates.get("lon", coordinates.get("lng"))
        if lat is not None and lon is not None:
            lat_cell, lon_cell = round(float(lat) * 1000), round(float(lon) * 1000)
            for lat_delta in range(-5, 6):
                for lon_delta in range(-5, 6):
                    candidates.update(
                        by_grid.get((borough, lat_cell + lat_delta, lon_cell + lon_delta), [])
                    )

        ranked: list[tuple[dict[str, Any], dict[str, Any]]] = []
        phone_matches = phone_camises.get(phone, set()) if phone else set()
        for camis in candidates:
            health = by_camis.get(camis)
            if not health or health.get("MostRecentVendingBoro") != borough:
                continue
            features = candidate_features(
                restaurant, health, camis in phone_matches, name, match_address
            )
            ranked.append((features, health))
        ranked.sort(key=lambda item: item[0]["total"], reverse=True)

        best = ranked[0] if ranked else None
        runner_up = ranked[1] if len(ranked) > 1 else None
        confident = bool(best and is_confident(best[0]))
        # Avoid ambiguous same-brand locations unless the location evidence distinguishes them.
        if confident and runner_up and best[0]["total"] - runner_up[0]["total"] < 0.025:
            best_distance = best[0]["distanceMiles"]
            next_distance = runner_up[0]["distanceMiles"]
            if not best[0]["phone"] and not (
                best_distance is not None
                and next_distance is not None
                and best_distance + 0.08 < next_distance
            ):
                confident = False

        record = {
            "restaurant": restaurant.get("name"),
            "slug": restaurant.get("slug"),
            "address": address_data.get("raw"),
            "matched": confident,
            "candidate": best[1].get("EntityName") if best else None,
            "camis": best[1].get("CurrentDecalNumber") if best else None,
            "candidateAddress": best[1].get("MostRecentVendingLocation") if best else None,
            "features": best[0] if best else None,
            "runnerUp": (
                {
                    "candidate": runner_up[1].get("EntityName"),
                    "camis": runner_up[1].get("CurrentDecalNumber"),
                    "features": runner_up[0],
                }
                if runner_up
                else None
            ),
        }
        report.append(record)
        if confident and best:
            matches[str(restaurant["slug"])] = (best[1], best[0])

    return matches, report


def latest_inspection(details: dict[str, Any]) -> dict[str, Any] | None:
    inspections = details.get("InspectionCollection") or []
    inspections = sorted(
        inspections, key=lambda item: str(item.get("InspectionDate") or ""), reverse=True
    )
    return inspections[0] if inspections else None


def compact_inspection(inspection: dict[str, Any]) -> dict[str, Any]:
    violations = inspection.get("ViolationCollection") or []
    return {
        "date": inspection.get("InspectionDate"),
        "result": inspection.get("InspectionResult"),
        "score": parse_score(inspection.get("TotalScore")),
        "violationCount": len(violations),
        "criticalViolationCount": sum(
            "critical" in str(violation.get("ViolationLevel") or "").lower()
            for violation in violations
        ),
    }


def parse_score(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def health_record(
    listing: dict[str, Any], details: dict[str, Any], matched_at: str
) -> dict[str, Any]:
    entity = details.get("Entity") or listing
    inspection = latest_inspection(details)
    violations = (inspection or {}).get("ViolationCollection") or []
    history = sorted(
        details.get("InspectionCollection") or [],
        key=lambda item: str(item.get("InspectionDate") or ""),
        reverse=True,
    )[:3]
    camis = str(entity.get("CamisID") or listing.get("CurrentDecalNumber"))
    return {
        "camis": camis,
        "grade": entity.get("Grade") or listing.get("Grade") or "Not Yet Graded",
        "score": parse_score((inspection or {}).get("TotalScore")),
        "inspectionDate": (inspection or {}).get("InspectionDate"),
        "inspectionResult": (inspection or {}).get("InspectionResult"),
        "violationCount": len(violations),
        "criticalViolationCount": sum(
            "critical" in str(violation.get("ViolationLevel") or "").lower()
            for violation in violations
        ),
        "violations": [
            {
                "description": violation.get("ViolationDesc"),
                "critical": "critical"
                in str(violation.get("ViolationLevel") or "").lower(),
            }
            for violation in violations
            if violation.get("ViolationDesc")
        ],
        "inspectionHistory": [compact_inspection(item) for item in history],
        "officialUrl": OFFICIAL_URL.format(camis=camis),
        "matchedName": entity.get("EntityName") or listing.get("EntityName"),
        "matchedAddress": entity.get("MostRecentVendingLocation")
        or listing.get("MostRecentVendingLocation"),
        "matchedAt": matched_at,
    }


def fetch_details_for_matches(
    matches: dict[str, tuple[dict[str, Any], dict[str, Any]]],
    cache_dir: Path,
    *,
    refresh: bool,
    workers: int,
) -> dict[str, dict[str, Any]]:
    unique_listings = {
        str(listing["CurrentDecalNumber"]): listing for listing, _features in matches.values()
    }

    def load(camis: str) -> tuple[str, dict[str, Any]]:
        path = cache_dir / "details" / f"{camis}.json"
        return (
            camis,
            cached_json(path, DETAIL_URL.format(camis=camis), refresh=refresh),
        )

    results: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(load, camis): camis for camis in unique_listings}
        completed = 0
        for future in as_completed(futures):
            camis = futures[future]
            try:
                loaded_camis, details = future.result()
                results[loaded_camis] = details
            except Exception as error:
                print(f"  warning: could not fetch details for {camis}: {error}")
            completed += 1
            if completed % 50 == 0 or completed == len(futures):
                print(f"  fetched {completed}/{len(futures)} detail records")
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input", type=Path, default=Path("public/data/restaurants.json")
    )
    parser.add_argument(
        "--output", type=Path, default=Path("public/data/restaurants.json")
    )
    parser.add_argument(
        "--cache-dir", type=Path, default=Path("data/abc-eats-cache")
    )
    parser.add_argument(
        "--report", type=Path, default=Path("data/health-inspection-match-report.json")
    )
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--skip-details", action="store_true")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    dataset = json.loads(args.input.read_text("utf-8"))
    restaurants = dataset["restaurants"]
    print("Fetching current ABC Eats restaurant listings…")
    health_rows = fetch_borough_restaurants(args.cache_dir, refresh=args.refresh)
    print(f"  loaded {len(health_rows):,} NYC Health restaurant records")

    phones = [normalized_phone(item.get("phone")) for item in restaurants]
    phones = [phone for phone in phones if phone]
    print("Looking up CAMIS IDs by phone…")
    phone_camises = fetch_phone_camises(phones, args.cache_dir, refresh=args.refresh)
    print(f"  found inspection records for {len(phone_camises):,} phone numbers")

    print("Matching Restaurant Week venues…")
    matches, report = match_restaurants(restaurants, health_rows, phone_camises)
    print(f"  confidently matched {len(matches)}/{len(restaurants)} restaurants")

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if args.skip_details:
        print(f"Wrote matching review to {args.report}")
        return

    print("Fetching matched inspection histories…")
    details = fetch_details_for_matches(
        matches,
        args.cache_dir,
        refresh=args.refresh,
        workers=max(1, args.workers),
    )
    matched_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    enriched = 0
    for restaurant in restaurants:
        restaurant.pop("healthInspection", None)
        match = matches.get(str(restaurant["slug"]))
        if not match:
            continue
        listing, _features = match
        camis = str(listing["CurrentDecalNumber"])
        if camis not in details:
            continue
        restaurant["healthInspection"] = health_record(
            listing, details[camis], matched_at
        )
        enriched += 1

    grades = Counter(
        item["healthInspection"]["grade"]
        for item in restaurants
        if item.get("healthInspection")
    )
    dataset["healthInspectionsUpdatedAt"] = matched_at
    dataset["stats"]["healthInspectionsMatched"] = enriched
    dataset["stats"]["healthGrades"] = dict(sorted(grades.items()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(dataset, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {enriched} health-inspection matches "
        f"({args.output.stat().st_size / 1024 / 1024:.1f} MiB) to {args.output}"
    )


if __name__ == "__main__":
    main()
