#!/usr/bin/env python3
"""Download and normalize the public NYC Restaurant Week dataset.

The official page renders its restaurant grid from a public, browser-facing API.
Each restaurant detail page also embeds richer venue data in the Next.js React
Flight payload. This script captures both sources, downloads available menu PDFs,
and writes normalized JSON/NDJSON/CSV plus a raw JSON archive.

No login, browser profile, or private credential is required. The API key used by
the public site is discovered from the site's current JavaScript bundle at runtime
and is deliberately not written to the output files.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import gzip
import hashlib
import html
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


LANDING_URL = "https://www.nyctourism.com/program/restaurant-week/"
DETAIL_URL_TEMPLATE = "https://www.nyctourism.com/restaurant-week/{slug}/"
DEFAULT_API_URL = "https://program-api.nyctourism.com/restaurant-week"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36"
)
API_KEY_PATTERN = re.compile(r'["\']x-api-key["\']\s*:\s*["\']([^"\']+)["\']')
SCRIPT_SRC_PATTERN = re.compile(r'<script[^>]+src=["\']([^"\']+)["\']', re.I)
FLIGHT_CALL_PATTERN = re.compile(r"^self\.__next_f\.push\((.*)\)\s*$", re.S)
FLIGHT_RECORD_PATTERN = re.compile(r"^([0-9a-f]+):(.*)$", re.S)
EXACT_FLIGHT_REF_PATTERN = re.compile(r"^\$([0-9a-f]+)$")
OCR_COMPILE_LOCK = threading.Lock()
OCR_EXECUTABLE: Path | None = None


class ScrapeError(RuntimeError):
    pass


class RateLimiter:
    """Limit request starts across all worker threads."""

    def __init__(self, min_interval: float) -> None:
        self.min_interval = max(0.0, min_interval)
        self._lock = threading.Lock()
        self._next_start = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_start - now)
            self._next_start = max(now, self._next_start) + self.min_interval
        if delay:
            time.sleep(delay)


class ScriptCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._in_script = False
        self._current: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "script":
            self._in_script = True
            self._current = []

    def handle_data(self, data: str) -> None:
        if self._in_script:
            self._current.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._in_script:
            self.scripts.append("".join(self._current))
            self._in_script = False
            self._current = []


def log(message: str) -> None:
    stamp = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_json(path: Path, value: Any, *, pretty: bool = True) -> None:
    if pretty:
        payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False)
    else:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    atomic_write(path, (payload + "\n").encode("utf-8"))


def write_gzip(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as f:
        f.write(data)
    os.replace(tmp, path)


def read_gzip(path: Path) -> bytes:
    with gzip.open(path, "rb") as f:
        return f.read()


class HttpClient:
    def __init__(self, *, min_interval: float, retries: int, timeout: float) -> None:
        self.rate_limiter = RateLimiter(min_interval)
        self.retries = retries
        self.timeout = timeout

    def request(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
    ) -> tuple[bytes, dict[str, str], int, str]:
        merged_headers = {
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if headers:
            merged_headers.update(headers)

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            self.rate_limiter.wait()
            request = Request(url, data=body, headers=merged_headers, method=method)
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    return (
                        response.read(),
                        {k.lower(): v for k, v in response.headers.items()},
                        response.status,
                        response.geturl(),
                    )
            except HTTPError as exc:
                last_error = exc
                retryable = exc.code == 429 or 500 <= exc.code < 600
                if not retryable or attempt >= self.retries:
                    error_body = exc.read().decode("utf-8", "replace")[:500]
                    raise ScrapeError(
                        f"HTTP {exc.code} for {method} {url}: {error_body}"
                    ) from exc
                retry_after = exc.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else 0.0
                except ValueError:
                    delay = 0.0
                time.sleep(max(delay, 0.8 * (2**attempt)) + random.uniform(0.0, 0.3))
            except (URLError, TimeoutError, ConnectionError) as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                time.sleep(0.8 * (2**attempt) + random.uniform(0.0, 0.3))
        raise ScrapeError(f"Request failed for {method} {url}: {last_error}")

    def get(self, url: str, headers: dict[str, str] | None = None) -> bytes:
        return self.request(url, headers=headers)[0]

    def post_json(
        self, url: str, value: Any, headers: dict[str, str] | None = None
    ) -> Any:
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        merged = {"Content-Type": "application/json"}
        if headers:
            merged.update(headers)
        body, _, _, _ = self.request(url, method="POST", headers=merged, body=payload)
        return json.loads(body)


def cached_get_gzip(client: HttpClient, url: str, path: Path) -> bytes:
    if path.exists():
        return read_gzip(path)
    body = client.get(url)
    write_gzip(path, body)
    return body


def discover_api_configuration(
    client: HttpClient, landing_html: str, raw_assets_dir: Path, api_key_override: str | None
) -> tuple[str, str, list[str]]:
    script_urls: list[str] = []
    for src in SCRIPT_SRC_PATTERN.findall(landing_html):
        url = urljoin(LANDING_URL, html.unescape(src))
        if url not in script_urls:
            script_urls.append(url)

    if api_key_override:
        return DEFAULT_API_URL, api_key_override, script_urls

    api_url: str | None = None
    api_key: str | None = None
    raw_assets_dir.mkdir(parents=True, exist_ok=True)
    for index, url in enumerate(script_urls):
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", url.rsplit("/", 1)[-1])
        cache_path = raw_assets_dir / f"{index:03d}-{safe_name}.gz"
        try:
            bundle = cached_get_gzip(client, url, cache_path).decode("utf-8", "replace")
        except ScrapeError:
            continue
        if "program-api.nyctourism.com" not in bundle and "x-api-key" not in bundle:
            continue
        key_match = API_KEY_PATTERN.search(bundle)
        url_match = re.search(
            r'["\'](https://program-api\.nyctourism\.com/restaurant-week)["\']',
            bundle,
        )
        if key_match:
            api_key = key_match.group(1)
        if url_match:
            api_url = url_match.group(1)
        if api_key:
            break

    if not api_key:
        raise ScrapeError(
            "Could not discover the browser-facing API key from the current site bundles. "
            "Re-run with --api-key if the site implementation changed."
        )
    return api_url or DEFAULT_API_URL, api_key, script_urls


def fetch_api_page(
    client: HttpClient,
    api_url: str,
    api_key: str,
    page: int,
    cache_dir: Path,
) -> dict[str, Any]:
    cache_path = cache_dir / f"page-{page:04d}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text("utf-8"))
    data = client.post_json(
        api_url,
        {"page": page, "lookup": {}},
        headers={
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nyctourism.com",
            "Referer": LANDING_URL,
            "x-api-key": api_key,
        },
    )
    write_json(cache_path, data, pretty=False)
    return data


def safe_path_component(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return normalized[:100] or "empty"


def fetch_filtered_api_page(
    client: HttpClient,
    api_url: str,
    api_key: str,
    page: int,
    lookup: dict[str, Any],
    cache_path: Path,
) -> dict[str, Any]:
    if cache_path.exists():
        return json.loads(cache_path.read_text("utf-8"))
    data = client.post_json(
        api_url,
        {"page": page, "lookup": lookup},
        headers={
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nyctourism.com",
            "Referer": LANDING_URL,
            "x-api-key": api_key,
        },
    )
    write_json(cache_path, data, pretty=False)
    return data


def enumerate_filtered_query(
    client: HttpClient,
    api_url: str,
    api_key: str,
    lookup: dict[str, Any],
    cache_dir: Path,
    *,
    rounds: int = 3,
) -> tuple[dict[str, dict[str, Any]], list[int], set[int]]:
    """Union repeated filtered pagination passes.

    The production API does not expose a stable sort and was observed returning
    slightly different snapshots from different backend replicas. Repeatedly
    unioning small filtered result sets avoids losing records at page boundaries.
    """
    unique: dict[str, dict[str, Any]] = {}
    filtered_counts: list[int] = []
    global_totals: set[int] = set()
    for round_number in range(1, rounds + 1):
        round_dir = cache_dir / f"round-{round_number}"
        first = fetch_filtered_api_page(
            client,
            api_url,
            api_key,
            1,
            lookup,
            round_dir / "page-0001.json",
        )
        count = int(first.get("count") or 0)
        filtered_counts.append(count)
        if first.get("total") is not None:
            global_totals.add(int(first["total"]))
        first_items = first.get("items") or []
        page_size = len(first_items) or 12
        for item in first_items:
            if item.get("slug"):
                unique[item["slug"]] = item
        for page in range(2, math.ceil(count / page_size) + 1):
            value = fetch_filtered_api_page(
                client,
                api_url,
                api_key,
                page,
                lookup,
                round_dir / f"page-{page:04d}.json",
            )
            filtered_counts.append(int(value.get("count") or count))
            if value.get("total") is not None:
                global_totals.add(int(value["total"]))
            for item in value.get("items") or []:
                if item.get("slug"):
                    unique[item["slug"]] = item
        if len(unique) >= max(filtered_counts, default=0):
            break
    return unique, filtered_counts, global_totals


def enumerate_by_neighborhood(
    client: HttpClient,
    api_url: str,
    api_key: str,
    lookup_options: dict[str, Any],
    cache_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[int]]:
    """Build a complete union using the API's mutually exclusive neighborhoods."""
    neighborhoods = (
        (lookup_options.get("Neighborhood") or {}).get("values") or []
    )
    cuisines = (lookup_options.get("Cuisine") or {}).get("values") or []
    if not neighborhoods:
        return [], [], set()

    all_items: dict[str, dict[str, Any]] = {}
    reports: list[dict[str, Any]] = []
    global_totals: set[int] = set()
    log(
        f"Enumerating {len(neighborhoods)} mutually exclusive neighborhoods "
        "to avoid unstable global pagination"
    )
    for index, neighborhood in enumerate(neighborhoods, start=1):
        neighborhood_dir = cache_dir / safe_path_component(neighborhood)
        base_lookup = {"Neighborhood": {"values": [neighborhood]}}
        items, counts, totals = enumerate_filtered_query(
            client,
            api_url,
            api_key,
            base_lookup,
            neighborhood_dir / "all",
        )
        global_totals.update(totals)
        expected = max(counts, default=0)
        methods = ["neighborhood"]

        # The only exclusive binary filter is Has Menu. It makes the remaining
        # pages small and, unioned with the base pass, filled every observed gap.
        if len(items) < expected:
            methods.append("has_menu_partition")
            for has_menu in ["true", "false"]:
                branch_lookup = {
                    **base_lookup,
                    "Has Menu": {"values": [has_menu]},
                }
                branch, branch_counts, branch_totals = enumerate_filtered_query(
                    client,
                    api_url,
                    api_key,
                    branch_lookup,
                    neighborhood_dir / f"has-menu-{has_menu}",
                )
                items.update(branch)
                global_totals.update(branch_totals)

        # Fallback for a future dataset where a very large neighborhood still
        # cannot be covered. Cuisines overlap, but their union is useful and the
        # already-collected base data retains restaurants with no cuisine value.
        if len(items) < expected and cuisines:
            methods.append("cuisine_union")
            for cuisine in cuisines:
                cuisine_lookup = {
                    **base_lookup,
                    "Cuisine": {"values": [cuisine]},
                }
                branch, _, branch_totals = enumerate_filtered_query(
                    client,
                    api_url,
                    api_key,
                    cuisine_lookup,
                    neighborhood_dir / "cuisines" / safe_path_component(cuisine),
                    rounds=2,
                )
                items.update(branch)
                global_totals.update(branch_totals)
                if len(items) >= expected:
                    break

        all_items.update(items)
        reports.append(
            {
                "neighborhood": neighborhood,
                "advertised_count": expected,
                "unique_slugs_collected": len(items),
                "methods": methods,
                "complete": len(items) >= expected,
            }
        )
        if index % 10 == 0 or index == len(neighborhoods):
            incomplete = sum(1 for report in reports if not report["complete"])
            log(
                f"Enumerated neighborhood {index}/{len(neighborhoods)}: "
                f"{len(all_items)} unique restaurants ({incomplete} incomplete partitions)"
            )
    return list(all_items.values()), reports, global_totals


def fetch_all_listings(
    client: HttpClient,
    api_url: str,
    api_key: str,
    cache_dir: Path,
) -> tuple[
    list[dict[str, Any]],
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
    set[int],
]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    first = fetch_api_page(client, api_url, api_key, 1, cache_dir)
    total = int(first.get("total") or first.get("count") or 0)
    page_size = len(first.get("items") or [])
    if total <= 0 or page_size <= 0:
        raise ScrapeError(f"Unexpected first API page: total={total}, items={page_size}")
    page_count = math.ceil(total / page_size)
    log(f"Official API reports {total} restaurants across {page_count} pages")

    # Keep API paging sequential. It makes the ordering less likely to shift while
    # the underlying program is being updated and is fast compared with details.
    pages = [first]
    for page in range(2, page_count + 1):
        pages.append(fetch_api_page(client, api_url, api_key, page, cache_dir))
        if page % 10 == 0 or page == page_count:
            log(f"Fetched API page {page}/{page_count}")

    unique: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for page in pages:
        for item in page.get("items") or []:
            slug = item.get("slug")
            if not slug:
                continue
            if slug in unique:
                duplicates.append(slug)
            unique[slug] = item
    listings = list(unique.values())
    global_pagination_unique = len(listings)
    if global_pagination_unique != total:
        log(
            f"WARNING: API advertised {total}, but pagination produced "
            f"{global_pagination_unique} unique slugs ({len(duplicates)} duplicates)"
        )
    lookup_options = first.get("lookup") or {}
    partitioned, partition_reports, partition_totals = enumerate_by_neighborhood(
        client,
        api_url,
        api_key,
        lookup_options,
        cache_dir / "partitions" / "neighborhoods",
    )
    if partitioned:
        partitioned_by_slug = {item["slug"]: item for item in partitioned}
        # Preserve anything from the global pass that is temporarily absent from
        # a partition snapshot, while preferring the more targeted responses.
        for item in listings:
            partitioned_by_slug.setdefault(item["slug"], item)
        listings = list(partitioned_by_slug.values())
        advertised_partition_sum = sum(
            report["advertised_count"] for report in partition_reports
        )
        log(
            f"Partitioned enumeration produced {len(listings)} unique slugs; "
            f"neighborhood counts sum to {advertised_partition_sum}"
        )
    api_reported_totals = {
        int(page["total"]) for page in pages if page.get("total") is not None
    }
    api_reported_totals.update(partition_totals)
    return listings, lookup_options, pages, partition_reports, api_reported_totals


def extract_flight_records(page_html: str) -> dict[str, Any]:
    collector = ScriptCollector()
    collector.feed(page_html)
    chunks: list[str] = []
    for script in collector.scripts:
        match = FLIGHT_CALL_PATTERN.match(script.strip())
        if not match:
            continue
        try:
            call = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(call, list) and len(call) > 1 and isinstance(call[1], str):
            chunks.append(call[1])

    records: dict[str, Any] = {}
    for line in "".join(chunks).splitlines():
        match = FLIGHT_RECORD_PATTERN.match(line)
        if not match:
            continue
        try:
            records[match.group(1)] = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
    return records


def walk_json(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json(child)


def resolve_flight_value(
    value: Any,
    records: dict[str, Any],
    *,
    stack: tuple[str, ...] = (),
    depth: int = 0,
) -> Any:
    if depth > 100:
        return {"_unresolved": "maximum React Flight reference depth exceeded"}
    if isinstance(value, str):
        if value == "$undefined":
            return None
        if value.startswith("$$"):
            return value[1:]
        match = EXACT_FLIGHT_REF_PATTERN.match(value)
        if match and match.group(1) in records:
            record_id = match.group(1)
            if record_id in stack:
                return {"$ref": record_id, "circular": True}
            return resolve_flight_value(
                records[record_id],
                records,
                stack=stack + (record_id,),
                depth=depth + 1,
            )
        return value
    if isinstance(value, list):
        return [
            resolve_flight_value(v, records, stack=stack, depth=depth + 1) for v in value
        ]
    if isinstance(value, dict):
        return {
            k: resolve_flight_value(v, records, stack=stack, depth=depth + 1)
            for k, v in value.items()
        }
    return value


def extract_venue_entry(page_html: str, expected_slug: str) -> dict[str, Any]:
    records = extract_flight_records(page_html)
    candidates: list[dict[str, Any]] = []
    for root in records.values():
        for value in walk_json(root):
            if not isinstance(value, dict):
                continue
            fields = value.get("fields")
            if isinstance(fields, dict) and "venueAddress" in fields:
                candidates.append(value)

    if not candidates:
        raise ScrapeError("No venue entry found in the detail page's React Flight data")
    candidates.sort(
        key=lambda candidate: (
            candidate.get("fields", {}).get("slug") == expected_slug,
            len(candidate.get("fields", {})),
        ),
        reverse=True,
    )
    return resolve_flight_value(candidates[0], records)


def rich_text_to_plain_text(value: Any) -> str:
    chunks: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            text = node.get("value")
            if isinstance(text, str):
                chunks.append(text)
            for key, child in node.items():
                if key != "value":
                    visit(child)
            if node.get("nodeType") in {"paragraph", "heading-1", "heading-2", "heading-3"}:
                chunks.append("\n")
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
    text = "".join(chunks)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def normalize_url(url: Any) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    return "https:" + url if url.startswith("//") else url


def normalize_category(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    fields = value.get("fields")
    if not isinstance(fields, dict):
        return None
    sys_value = value.get("sys") if isinstance(value.get("sys"), dict) else {}
    parents: list[str] = []
    for parent in fields.get("parentCategories") or []:
        if isinstance(parent, dict):
            parent_fields = parent.get("fields") or {}
            label = parent_fields.get("title") or parent_fields.get("lookupName")
            if label:
                parents.append(label)
    return {
        "id": sys_value.get("id"),
        "title": fields.get("title"),
        "slug": fields.get("slug"),
        "group": fields.get("categoryGroupName"),
        "lookup_name": fields.get("lookupName"),
        "parents": parents,
        "crm_ids": fields.get("crmIds"),
        "crm_values": fields.get("crmValues"),
    }


def normalize_images(images: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in images or []:
        if not isinstance(item, dict):
            continue
        fields = item.get("fields") or {}
        image = fields.get("image")
        image_fields = image.get("fields") if isinstance(image, dict) else fields
        if not isinstance(image_fields, dict):
            continue
        file_value = image_fields.get("file") or {}
        details = file_value.get("details") or {}
        image_details = details.get("image") or {}
        output.append(
            {
                "url": normalize_url(file_value.get("url") or image_fields.get("mediaAssetFromUrl")),
                "alt": fields.get("alt") or image_fields.get("alt"),
                "credit": fields.get("credit") or image_fields.get("credit"),
                "focal_point": fields.get("focalPoint") or image_fields.get("focalPoint"),
                "content_type": file_value.get("contentType"),
                "file_name": file_value.get("fileName"),
                "bytes": details.get("size"),
                "width": image_details.get("width"),
                "height": image_details.get("height"),
            }
        )
    return output


def parse_address(raw_address: Any) -> dict[str, Any] | None:
    if not isinstance(raw_address, str) or not raw_address.strip():
        return None
    try:
        parts = next(csv.reader([raw_address], skipinitialspace=True))
    except (csv.Error, StopIteration):
        parts = [part.strip() for part in raw_address.split(",")]
    parts = [part.strip() for part in parts]
    result: dict[str, Any] = {"raw": raw_address, "parts": parts}
    if len(parts) >= 4:
        result.update(
            {
                "street": parts[0],
                "locality": ", ".join(parts[1:-2]),
                "postal_code": parts[-2],
                "state": parts[-1],
            }
        )
    return result


def normalize_detail(entry: dict[str, Any], detail_url: str) -> dict[str, Any]:
    fields = entry.get("fields") or {}
    sys_value = entry.get("sys") or {}
    categories: list[dict[str, Any]] = []
    for value in (fields.get("primaryCategories") or []) + (
        fields.get("secondaryCategories") or []
    ):
        category = normalize_category(value)
        if category and category not in categories:
            categories.append(category)
    grouped: dict[str, list[str]] = {}
    for category in categories:
        group = category.get("group") or "Other"
        title = category.get("title")
        if title and title not in grouped.setdefault(group, []):
            grouped[group].append(title)

    social = {
        "twitter": fields.get("twitterHandle"),
        "facebook": fields.get("facebookUrl"),
        "instagram": fields.get("instagram"),
        "pinterest": fields.get("pinterest"),
        "tiktok": fields.get("tikTokHandle"),
    }
    return {
        "official_detail_url": detail_url,
        "contentful_entry_id": sys_value.get("id"),
        "contentful_created_at": sys_value.get("createdAt"),
        "contentful_updated_at": sys_value.get("updatedAt"),
        "contentful_revision": sys_value.get("revision"),
        "title": fields.get("title"),
        "display_title": fields.get("displayTitle"),
        "short_title": fields.get("shortTitle"),
        "sort_title": fields.get("sortTitle"),
        "slug": fields.get("slug"),
        "date_published": fields.get("datePublished"),
        "date_updated": fields.get("dateUpdated"),
        "summary": fields.get("summary"),
        "description": rich_text_to_plain_text(fields.get("body")),
        "phone": fields.get("phone"),
        "website": fields.get("websiteUrl"),
        "address": parse_address(fields.get("venueAddress")),
        "coordinates": fields.get("location"),
        "social": {key: value for key, value in social.items() if value},
        "images": normalize_images(fields.get("images")),
        "categories": categories,
        "category_groups": grouped,
        "crm_listing_id": fields.get("crmListingId"),
        "crm_account_id": fields.get("crmAccountId"),
        "legacy_entry_id": fields.get("legacyEntryId"),
        "sync_status": fields.get("syncStatus"),
        "meta": {
            "title": fields.get("metaTitle"),
            "description": fields.get("metaDescription"),
            "social_title": fields.get("socialMediaTitle"),
            "social_description": fields.get("socialMediaDescription"),
            "no_index": fields.get("noIndex"),
        },
    }


def fetch_detail(
    client: HttpClient,
    listing: dict[str, Any],
    cache_dir: Path,
) -> tuple[str, dict[str, Any] | None, dict[str, Any] | None, str | None]:
    slug = listing["slug"]
    url = DETAIL_URL_TEMPLATE.format(slug=slug)
    cache_path = cache_dir / f"{slug}.html.gz"
    try:
        body = cached_get_gzip(client, url, cache_path)
        page_html = body.decode("utf-8", "replace")
        entry = extract_venue_entry(page_html, slug)
        return slug, normalize_detail(entry, url), entry, None
    except Exception as exc:  # Return per-item errors without aborting all 619 pages.
        return slug, None, None, f"{type(exc).__name__}: {exc}"


def parse_pdfinfo(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized_key = re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_")
        value = value.strip()
        if normalized_key == "pages" and value.isdigit():
            result[normalized_key] = int(value)
        else:
            result[normalized_key] = value
    return result


def macos_vision_ocr(path: Path) -> tuple[str, list[str]]:
    """OCR an image-only PDF using built-in macOS Vision, when available."""
    global OCR_EXECUTABLE
    errors: list[str] = []
    if sys.platform != "darwin":
        return "", ["OCR unavailable: not running on macOS"]
    swiftc = shutil.which("swiftc")
    pdftoppm = shutil.which("pdftoppm")
    source = Path(__file__).with_name("vision_ocr.swift")
    if not swiftc or not pdftoppm or not source.exists():
        return "", ["OCR unavailable: swiftc, pdftoppm, or vision_ocr.swift is missing"]

    with OCR_COMPILE_LOCK:
        if OCR_EXECUTABLE is None:
            source_hash = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
            executable = Path(tempfile.gettempdir()) / f"nyc-rw-vision-ocr-{source_hash}"
            if not executable.exists():
                process = subprocess.run(
                    [swiftc, str(source), "-o", str(executable)],
                    capture_output=True,
                    timeout=180,
                    check=False,
                )
                if process.returncode != 0:
                    return "", [
                        "Vision OCR compile: "
                        + process.stderr.decode("utf-8", "replace").strip()[:1000]
                    ]
            OCR_EXECUTABLE = executable

    with tempfile.TemporaryDirectory(prefix="nyc-rw-ocr-") as temp_dir:
        prefix = Path(temp_dir) / "page"
        render = subprocess.run(
            [pdftoppm, "-png", "-r", "180", str(path), str(prefix)],
            capture_output=True,
            timeout=180,
            check=False,
        )
        if render.returncode != 0:
            return "", [
                "pdftoppm for OCR: "
                + render.stderr.decode("utf-8", "replace").strip()[:1000]
            ]
        images = sorted(Path(temp_dir).glob("page-*.png"))
        if not images:
            return "", ["pdftoppm for OCR produced no page images"]
        process = subprocess.run(
            [str(OCR_EXECUTABLE), *map(str, images)],
            capture_output=True,
            timeout=max(180, 90 * len(images)),
            check=False,
        )
        if process.returncode != 0:
            errors.append(
                "Vision OCR: "
                + process.stderr.decode("utf-8", "replace").strip()[:1000]
            )
            return "", errors
        stderr = process.stderr.decode("utf-8", "replace").strip()
        if stderr:
            errors.append("Vision OCR warnings: " + stderr[:1000])
        return process.stdout.decode("utf-8", "replace").strip(), errors


def inspect_pdf(path: Path) -> tuple[dict[str, Any], str, list[str]]:
    errors: list[str] = []
    metadata: dict[str, Any] = {}
    text = ""
    pdfinfo = shutil.which("pdfinfo")
    pdftotext = shutil.which("pdftotext")
    if pdfinfo:
        try:
            process = subprocess.run(
                [pdfinfo, str(path)], capture_output=True, timeout=60, check=False
            )
            if process.returncode == 0:
                metadata = parse_pdfinfo(process.stdout.decode("utf-8", "replace"))
            else:
                errors.append(
                    "pdfinfo: " + process.stderr.decode("utf-8", "replace").strip()[:500]
                )
        except Exception as exc:
            errors.append(f"pdfinfo: {type(exc).__name__}: {exc}")
    else:
        errors.append("pdfinfo is not installed")
    if pdftotext:
        try:
            process = subprocess.run(
                [pdftotext, "-layout", "-nopgbrk", str(path), "-"],
                capture_output=True,
                timeout=90,
                check=False,
            )
            if process.returncode == 0:
                lines = [line.rstrip() for line in process.stdout.decode("utf-8", "replace").splitlines()]
                while lines and not lines[-1]:
                    lines.pop()
                text = "\n".join(lines)
                if text:
                    metadata["text_extraction_method"] = "pdftotext"
            else:
                errors.append(
                    "pdftotext: "
                    + process.stderr.decode("utf-8", "replace").strip()[:500]
                )
        except Exception as exc:
            errors.append(f"pdftotext: {type(exc).__name__}: {exc}")
    else:
        errors.append("pdftotext is not installed; menu text was not extracted")
    if not text:
        ocr_text, ocr_errors = macos_vision_ocr(path)
        errors.extend(ocr_errors)
        if ocr_text:
            text = ocr_text
            metadata["text_extraction_method"] = "macOS Vision OCR"
    return metadata, text, errors


def fetch_menu(
    client: HttpClient,
    listing: dict[str, Any],
    menus_dir: Path,
    relative_root: Path,
) -> tuple[str, dict[str, Any] | None, str | None]:
    slug = listing["slug"]
    url = listing.get("menuFileUrl")
    if not url:
        return slug, None, None
    extension = Path(url.split("?", 1)[0]).suffix.lower()
    if extension not in {".pdf", ".png", ".jpg", ".jpeg", ".webp"}:
        extension = ".bin"
    path = menus_dir / f"{slug}{extension}"
    try:
        if not path.exists():
            body, _, _, final_url = client.request(url)
            atomic_write(path, body)
        else:
            final_url = url
        body = path.read_bytes()
        metadata: dict[str, Any] = {}
        extracted_text = ""
        extraction_errors: list[str] = []
        if extension == ".pdf":
            metadata, extracted_text, extraction_errors = inspect_pdf(path)
        menu = {
            "url": url,
            "final_url": final_url,
            "local_file": str(path.relative_to(relative_root)),
            "content_type_inferred": "application/pdf" if extension == ".pdf" else None,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "pdf_metadata": metadata if extension == ".pdf" else None,
            "extracted_text": extracted_text or None,
            "text_character_count": len(extracted_text),
            "extraction_errors": extraction_errors,
        }
        return slug, menu, None
    except Exception as exc:
        return slug, None, f"{type(exc).__name__}: {exc}"


def meal_prices(meal_types: Iterable[str]) -> dict[str, list[int]]:
    output: dict[str, list[int]] = {}
    for meal_type in meal_types:
        match = re.match(r"\$(\d+)\s+(.+?)\s+Price$", meal_type)
        if not match:
            continue
        price = int(match.group(1))
        meal = match.group(2).lower().replace("/", "_").replace(" ", "_")
        if price not in output.setdefault(meal, []):
            output[meal].append(price)
    return output


def build_restaurant(
    listing: dict[str, Any],
    detail: dict[str, Any] | None,
    detail_error: str | None,
    menu: dict[str, Any] | None,
    menu_error: str | None,
) -> dict[str, Any]:
    image = listing.get("image") or {}
    ecommerce = listing.get("ecommerce") or {}
    detail_cuisines = ((detail or {}).get("category_groups") or {}).get("Cuisine", [])
    # The grid tags are cuisines followed by the neighborhood. This fallback
    # retains cuisine coverage when an official detail page itself returns 500.
    cuisines = detail_cuisines or [
        tag
        for tag in (listing.get("tags") or [])
        if tag != listing.get("neighborhood")
    ]
    return {
        "name": listing.get("shortTitle") or (detail or {}).get("display_title"),
        "slug": listing.get("slug"),
        "official_detail_url": DETAIL_URL_TEMPLATE.format(slug=listing.get("slug")),
        "borough": listing.get("borough"),
        "neighborhood": listing.get("neighborhood"),
        "primary_category": listing.get("primaryCategory"),
        "summary": listing.get("summary") or (detail or {}).get("summary"),
        "description": (detail or {}).get("description"),
        "website": listing.get("website") or (detail or {}).get("website"),
        "phone": (detail or {}).get("phone"),
        "address": (detail or {}).get("address"),
        "coordinates": (detail or {}).get("coordinates"),
        "tags": listing.get("tags") or [],
        "cuisines": cuisines,
        "accessibility": ((detail or {}).get("category_groups") or {}).get(
            "Accessibility", []
        ),
        "dietary_needs": ((detail or {}).get("category_groups") or {}).get(
            "Dietary Needs", []
        ),
        "amenities": ((detail or {}).get("category_groups") or {}).get("Amenities", []),
        "cost_categories": ((detail or {}).get("category_groups") or {}).get("Cost", []),
        "all_category_groups": (detail or {}).get("category_groups", {}),
        "all_categories": (detail or {}).get("categories", []),
        "meal_types": listing.get("mealTypes") or [],
        "meal_prices": meal_prices(listing.get("mealTypes") or []),
        "weeks_participating": listing.get("restaurantInclusionWeek") or [],
        "collections": listing.get("collections") or [],
        "has_menu": bool(listing.get("menuFileUrl")),
        "menu": menu,
        "menu_error": menu_error,
        "reservation": (
            {
                "partner": ecommerce.get("partnerName") or ecommerce.get("title"),
                "partner_id": ecommerce.get("partnerId"),
            }
            if ecommerce
            else None
        ),
        "grid_image": {
            "url": normalize_url(image.get("url")),
            "alt": image.get("alt"),
        },
        "images": (detail or {}).get("images", []),
        "social": (detail or {}).get("social", {}),
        "source_ids": {
            "contentful_entry_id": (detail or {}).get("contentful_entry_id"),
            "crm_listing_id": (detail or {}).get("crm_listing_id"),
            "crm_account_id": (detail or {}).get("crm_account_id"),
            "legacy_entry_id": (detail or {}).get("legacy_entry_id"),
        },
        "source_metadata": {
            "contentful_created_at": (detail or {}).get("contentful_created_at"),
            "contentful_updated_at": (detail or {}).get("contentful_updated_at"),
            "contentful_revision": (detail or {}).get("contentful_revision"),
            "date_published": (detail or {}).get("date_published"),
            "date_updated": (detail or {}).get("date_updated"),
            "sync_status": (detail or {}).get("sync_status"),
            "meta": (detail or {}).get("meta"),
        },
        "detail_scrape_error": detail_error,
    }


def write_ndjson(path: Path, restaurants: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        for restaurant in restaurants:
            f.write(json.dumps(restaurant, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
    os.replace(tmp, path)


def write_csv(path: Path, restaurants: list[dict[str, Any]]) -> None:
    columns = [
        "name",
        "slug",
        "borough",
        "neighborhood",
        "cuisines",
        "meal_types",
        "weeks_participating",
        "collections",
        "website",
        "phone",
        "address",
        "latitude",
        "longitude",
        "menu_url",
        "reservation_partner",
        "reservation_partner_id",
        "official_detail_url",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for item in restaurants:
            address = item.get("address") or {}
            coordinates = item.get("coordinates") or {}
            menu = item.get("menu") or {}
            reservation = item.get("reservation") or {}
            writer.writerow(
                {
                    "name": item.get("name"),
                    "slug": item.get("slug"),
                    "borough": item.get("borough"),
                    "neighborhood": item.get("neighborhood"),
                    "cuisines": " | ".join(item.get("cuisines") or []),
                    "meal_types": " | ".join(item.get("meal_types") or []),
                    "weeks_participating": " | ".join(
                        item.get("weeks_participating") or []
                    ),
                    "collections": " | ".join(item.get("collections") or []),
                    "website": item.get("website"),
                    "phone": item.get("phone"),
                    "address": address.get("raw"),
                    "latitude": coordinates.get("lat"),
                    "longitude": coordinates.get("lon") or coordinates.get("lng"),
                    "menu_url": menu.get("url"),
                    "reservation_partner": reservation.get("partner"),
                    "reservation_partner_id": reservation.get("partner_id"),
                    "official_detail_url": item.get("official_detail_url"),
                }
            )
    os.replace(tmp, path)


def summary_counts(restaurants: list[dict[str, Any]], field: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in restaurants:
        value = item.get(field)
        values = value if isinstance(value, list) else [value]
        for entry in values:
            if entry not in (None, ""):
                counts[str(entry)] = counts.get(str(entry), 0) + 1
    return dict(sorted(counts.items(), key=lambda pair: (-pair[1], pair[0].lower())))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data") / dt.date.today().isoformat(),
        help="Output and cache directory (default: data/YYYY-MM-DD)",
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--min-request-interval",
        type=float,
        default=0.10,
        help="Minimum seconds between HTTP request starts across all workers",
    )
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument(
        "--api-key",
        default=os.environ.get("NYC_TOURISM_PROGRAM_API_KEY"),
        help="Optional override; by default the key is discovered from the public JS bundle",
    )
    parser.add_argument("--skip-details", action="store_true")
    parser.add_argument("--skip-menus", action="store_true")
    parser.add_argument(
        "--event-name", default="NYC Restaurant Week Summer 2026"
    )
    parser.add_argument("--event-start", default="2026-07-20")
    parser.add_argument("--event-end", default="2026-08-16")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    raw_dir = output_dir / "raw"
    raw_details_dir = raw_dir / "details"
    raw_api_dir = raw_dir / "api"
    menus_dir = output_dir / "menus"
    for directory in [output_dir, raw_dir, raw_details_dir, raw_api_dir, menus_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    started_at = utc_now()
    client = HttpClient(
        min_interval=args.min_request_interval,
        retries=args.retries,
        timeout=args.timeout,
    )

    log(f"Output directory: {output_dir}")
    landing_bytes = cached_get_gzip(client, LANDING_URL, raw_dir / "landing.html.gz")
    landing_html = landing_bytes.decode("utf-8", "replace")
    api_url, api_key, script_urls = discover_api_configuration(
        client, landing_html, raw_dir / "assets", args.api_key
    )
    log(f"Discovered public browser API configuration from {len(script_urls)} script bundles")

    (
        listings,
        lookup,
        api_pages,
        partition_reports,
        api_reported_totals,
    ) = fetch_all_listings(
        client, api_url, api_key, raw_api_dir
    )

    details: dict[str, dict[str, Any]] = {}
    raw_entries: dict[str, dict[str, Any]] = {}
    detail_errors: dict[str, str] = {}
    if not args.skip_details:
        log(f"Fetching {len(listings)} restaurant detail pages with {args.workers} workers")
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [
                executor.submit(fetch_detail, client, listing, raw_details_dir)
                for listing in listings
            ]
            for completed, future in enumerate(
                concurrent.futures.as_completed(futures), start=1
            ):
                slug, detail, entry, error = future.result()
                if detail:
                    details[slug] = detail
                if entry:
                    raw_entries[slug] = entry
                if error:
                    detail_errors[slug] = error
                if completed % 50 == 0 or completed == len(futures):
                    log(
                        f"Processed detail {completed}/{len(futures)} "
                        f"({len(detail_errors)} errors)"
                    )

    menus: dict[str, dict[str, Any]] = {}
    menu_errors: dict[str, str] = {}
    menu_listings = [listing for listing in listings if listing.get("menuFileUrl")]
    if not args.skip_menus:
        log(f"Downloading and extracting {len(menu_listings)} menu files")
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [
                executor.submit(fetch_menu, client, listing, menus_dir, output_dir)
                for listing in menu_listings
            ]
            for completed, future in enumerate(
                concurrent.futures.as_completed(futures), start=1
            ):
                slug, menu, error = future.result()
                if menu:
                    menus[slug] = menu
                if error:
                    menu_errors[slug] = error
                if completed % 50 == 0 or completed == len(futures):
                    log(
                        f"Processed menu {completed}/{len(futures)} "
                        f"({len(menu_errors)} errors)"
                    )

    restaurants = [
        build_restaurant(
            listing,
            details.get(listing["slug"]),
            detail_errors.get(listing["slug"]),
            menus.get(listing["slug"]),
            menu_errors.get(listing["slug"]),
        )
        for listing in listings
    ]
    restaurants.sort(key=lambda item: ((item.get("name") or "").casefold(), item["slug"]))

    finished_at = utc_now()
    stats = {
        "restaurants": len(restaurants),
        "api_advertised_total": api_pages[0].get("total"),
        "api_reported_totals_observed": sorted(api_reported_totals),
        "neighborhood_advertised_count_sum": sum(
            report["advertised_count"] for report in partition_reports
        ),
        "neighborhood_partitions": len(partition_reports),
        "incomplete_neighborhood_partitions": sum(
            1 for report in partition_reports if not report["complete"]
        ),
        "details_scraped": len(details),
        "detail_errors": len(detail_errors),
        "restaurants_with_menu_url": len(menu_listings),
        "menus_downloaded": len(menus),
        "menu_errors": len(menu_errors),
        "menus_with_extracted_text": sum(
            1 for value in menus.values() if value.get("extracted_text")
        ),
        "menus_text_from_pdftotext": sum(
            1
            for value in menus.values()
            if (value.get("pdf_metadata") or {}).get("text_extraction_method")
            == "pdftotext"
        ),
        "menus_text_from_macos_vision_ocr": sum(
            1
            for value in menus.values()
            if (value.get("pdf_metadata") or {}).get("text_extraction_method")
            == "macOS Vision OCR"
        ),
        "boroughs": summary_counts(restaurants, "borough"),
        "neighborhoods": summary_counts(restaurants, "neighborhood"),
        "cuisines": summary_counts(restaurants, "cuisines"),
        "meal_types": summary_counts(restaurants, "meal_types"),
        "weeks_participating": summary_counts(restaurants, "weeks_participating"),
        "collections": summary_counts(restaurants, "collections"),
    }
    event = {
        "name": args.event_name,
        "official_program_start": args.event_start,
        "official_program_end": args.event_end,
        "extensions": (
            "Some restaurants list additional participation weeks after the official end date; "
            "see each restaurant's weeks_participating field."
        ),
        "official_landing_page": LANDING_URL,
    }
    source = {
        "started_at": started_at,
        "finished_at": finished_at,
        "official_landing_page": LANDING_URL,
        "official_program_api": api_url,
        "detail_url_template": DETAIL_URL_TEMPLATE,
        "notes": [
            "The public site's browser API key was discovered at runtime and is not included here.",
            "Raw API responses, compressed detail HTML, and menu files are retained beside this file.",
            "The API has no stable global sort and can report slightly different totals from different replicas; mutually exclusive neighborhood partitions are unioned for complete coverage.",
            "Restaurant Week details can change; rerun the script to take a new snapshot.",
        ],
    }
    normalized_output = {
        "schema_version": "1.0.0",
        "generated_at": finished_at,
        "event": event,
        "source": source,
        "stats": stats,
        "filter_options": lookup,
        "restaurants": restaurants,
    }
    raw_output = {
        "schema_version": "1.0.0",
        "generated_at": finished_at,
        "source": source,
        "lookup": lookup,
        "api_listings": listings,
        "neighborhood_partition_reports": partition_reports,
        "contentful_venue_entries_by_slug": raw_entries,
        "detail_errors": detail_errors,
        "menu_errors": menu_errors,
    }
    validation = {
        "generated_at": finished_at,
        "stats": stats,
        "detail_errors": detail_errors,
        "menu_errors": menu_errors,
        "checks": {
            "unique_slugs": len({item["slug"] for item in restaurants})
            == len(restaurants),
            "matches_neighborhood_advertised_count_sum": not partition_reports
            or len(restaurants)
            == sum(report["advertised_count"] for report in partition_reports),
            "all_neighborhood_partitions_complete": all(
                report["complete"] for report in partition_reports
            ),
            "all_detail_pages_parsed": args.skip_details
            or len(details) == len(restaurants),
            "all_menu_urls_downloaded": args.skip_menus
            or len(menus) == len(menu_listings),
        },
    }

    base = "nyc_restaurant_week_summer_2026"
    log("Writing normalized JSON, raw JSON, NDJSON, CSV, and validation report")
    write_json(output_dir / f"{base}.json", normalized_output)
    write_json(output_dir / f"{base}.raw.json", raw_output)
    write_ndjson(output_dir / f"{base}.ndjson", restaurants)
    write_csv(output_dir / f"{base}.csv", restaurants)
    write_json(output_dir / "validation_report.json", validation)

    log(
        f"Done: {len(restaurants)} restaurants, {len(details)} rich details, "
        f"{len(menus)} menus ({stats['menus_with_extracted_text']} with text)"
    )
    if detail_errors or menu_errors:
        log("Completed with per-item errors; see validation_report.json")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("Interrupted; caches are preserved and the same command can resume")
        raise SystemExit(130)
    except ScrapeError as exc:
        log(f"ERROR: {exc}")
        raise SystemExit(1)
