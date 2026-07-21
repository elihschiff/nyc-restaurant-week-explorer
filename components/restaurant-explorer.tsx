"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Crosshair,
  Grid2X2,
  Heart,
  List,
  ListFilter,
  LoaderCircle,
  LocateFixed,
  Map as MapIcon,
  PanelLeftClose,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  UtensilsCrossed,
  X,
} from "lucide-react";
import type {
  FilterState,
  LocationPoint,
  Restaurant,
  RestaurantDataset,
  SortMode,
  ViewMode,
} from "@/lib/types";
import { EMPTY_FILTERS } from "@/lib/types";
import {
  displayCollection,
  displayHealthGrade,
  displayWeek,
  HEALTH_GRADE_ORDER,
  mealPrices,
  mealPeriodMatches,
  minimumPrice,
  restaurantDistance,
  restaurantMatchesSearch,
  searchScore,
} from "@/lib/explorer";
import FilterPanel, { type ExplorerFacets, type FacetOption } from "./filter-panel";
import RestaurantCard from "./restaurant-card";
import DetailDrawer from "./detail-drawer";

const MapView = dynamic(() => import("./map-view"), {
  ssr: false,
  loading: () => (
    <div className="map-loading">
      <LoaderCircle size={24} className="spin" /> Loading the map…
    </div>
  ),
});

const SAVED_KEY = "nyc-rw-2026-saved";

function countFacet(
  restaurants: Restaurant[],
  readValues: (restaurant: Restaurant) => string[],
): FacetOption[] {
  const counts = new Map<string, number>();
  restaurants.forEach((restaurant) => {
    new Set(readValues(restaurant)).forEach((value) => {
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    });
  });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function selectedIn(values: string[], selected: string[]): boolean {
  return selected.length === 0 || selected.some((value) => values.includes(value));
}

function directSelected(value: string, selected: string[]): boolean {
  return selected.length === 0 || selected.includes(value);
}

function activeFilterCount(filters: FilterState): number {
  return (
    filters.boroughs.length +
    filters.neighborhoods.length +
    filters.cuisines.length +
    filters.lunchPrices.length +
    filters.dinnerPrices.length +
    filters.mealPeriods.length +
    filters.weeks.length +
    filters.collections.length +
    filters.accessibility.length +
    filters.dietaryNeeds.length +
    filters.amenities.length +
    filters.healthGrades.length +
    Number(filters.healthScoreMin !== null || filters.healthScoreMax !== null) +
    Number(filters.hasMenu) +
    Number(filters.hasReservation) +
    Number(filters.savedOnly) +
    Number(filters.maxDistance !== null)
  );
}

function queryList(params: URLSearchParams, key: string): string[] {
  return params.get(key)?.split("|").filter(Boolean) ?? [];
}

function initialBrowserSettings(): {
  query: string;
  sort: SortMode;
  view: ViewMode;
  filters: FilterState;
  filtersOpen: boolean;
} {
  if (typeof window === "undefined") {
    return {
      query: "",
      sort: "best-match",
      view: "split",
      filters: EMPTY_FILTERS,
      filtersOpen: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const requestedSort = params.get("sort");
  const radius = params.get("radius");
  const parsedRadius = radius === null ? null : Number(radius);
  const scoreMin = params.get("score-min");
  const parsedScoreMin = scoreMin === null ? null : Number(scoreMin);
  const scoreMax = params.get("score-max");
  const parsedScoreMax = scoreMax === null ? null : Number(scoreMax);
  return {
    query: params.get("q") ?? "",
    view: (["split", "list", "map"] as const).includes(requestedView as ViewMode)
      ? (requestedView as ViewMode)
      : "split",
    sort: (["best-match", "name", "distance", "price", "offers", "weeks", "neighborhood", "health-grade", "health-score"] as const).includes(
      requestedSort as SortMode,
    )
      ? (requestedSort as SortMode)
      : "best-match",
    filters: {
      boroughs: queryList(params, "borough"),
      neighborhoods: queryList(params, "neighborhood"),
      cuisines: queryList(params, "cuisine"),
      lunchPrices: queryList(params, "lunch-price"),
      dinnerPrices: queryList(params, "dinner-price"),
      mealPeriods: queryList(params, "meal"),
      weeks: queryList(params, "week"),
      collections: queryList(params, "collection"),
      accessibility: queryList(params, "access"),
      dietaryNeeds: queryList(params, "diet"),
      amenities: queryList(params, "amenity"),
      healthGrades: queryList(params, "grade"),
      healthScoreMin:
        parsedScoreMin !== null && Number.isFinite(parsedScoreMin) ? parsedScoreMin : null,
      healthScoreMax:
        parsedScoreMax !== null && Number.isFinite(parsedScoreMax) ? parsedScoreMax : null,
      hasMenu: params.get("menu") === "1",
      hasReservation: params.get("reservation") === "1",
      savedOnly: params.get("saved") === "1",
      maxDistance: parsedRadius !== null && Number.isFinite(parsedRadius) ? parsedRadius : null,
    },
    filtersOpen: window.innerWidth >= 1180,
  };
}

function initialSavedRestaurants(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = window.localStorage.getItem(SAVED_KEY);
    return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function sortRestaurants(
  restaurants: Restaurant[],
  sort: SortMode,
  query: string,
): Restaurant[] {
  return [...restaurants].sort((a, b) => {
    if (sort === "best-match") {
      if (query.trim()) {
        const score = searchScore(b, query) - searchScore(a, query);
        if (score) return score;
      } else {
        const featuredA = a.collections.length * 20 + Number(Boolean(a.menu)) * 4 + a.weeksParticipating.length;
        const featuredB = b.collections.length * 20 + Number(Boolean(b.menu)) * 4 + b.weeksParticipating.length;
        if (featuredA !== featuredB) return featuredB - featuredA;
      }
    }
    if (sort === "distance") {
      return (a.distanceMiles ?? Number.POSITIVE_INFINITY) - (b.distanceMiles ?? Number.POSITIVE_INFINITY);
    }
    if (sort === "price") {
      return (minimumPrice(a) ?? 999) - (minimumPrice(b) ?? 999) || a.name.localeCompare(b.name);
    }
    if (sort === "offers") {
      return b.mealTypes.length - a.mealTypes.length || a.name.localeCompare(b.name);
    }
    if (sort === "weeks") {
      return b.weeksParticipating.length - a.weeksParticipating.length || a.name.localeCompare(b.name);
    }
    if (sort === "neighborhood") {
      return a.neighborhood.localeCompare(b.neighborhood) || a.name.localeCompare(b.name);
    }
    if (sort === "health-score") {
      return (
        (a.healthInspection?.score ?? Number.POSITIVE_INFINITY) -
          (b.healthInspection?.score ?? Number.POSITIVE_INFINITY) ||
        a.name.localeCompare(b.name)
      );
    }
    if (sort === "health-grade") {
      const rawGradeA = a.healthInspection
        ? HEALTH_GRADE_ORDER.indexOf(a.healthInspection.grade)
        : -1;
      const rawGradeB = b.healthInspection
        ? HEALTH_GRADE_ORDER.indexOf(b.healthInspection.grade)
        : -1;
      const gradeA = rawGradeA < 0 ? Number.POSITIVE_INFINITY : rawGradeA;
      const gradeB = rawGradeB < 0 ? Number.POSITIVE_INFINITY : rawGradeB;
      return gradeA - gradeB || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
}

function filterLabel(key: keyof FilterState, value: string): string {
  if (key === "lunchPrices") return `Lunch $${value}`;
  if (key === "dinnerPrices") return `Dinner $${value}`;
  if (key === "mealPeriods") {
    return {
      "weekday-lunch": "Weekday lunch",
      "weekday-dinner": "Weekday dinner",
      "sunday-lunch": "Sunday brunch",
      "sunday-dinner": "Sunday dinner",
    }[value] ?? value;
  }
  if (key === "weeks") return displayWeek(value);
  if (key === "collections") return displayCollection(value);
  if (key === "healthGrades") return displayHealthGrade(value);
  return value;
}

export default function RestaurantExplorer() {
  const [initialSettings] = useState(initialBrowserSettings);
  const [dataset, setDataset] = useState<RestaurantDataset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialSettings.query);
  const [sort, setSort] = useState<SortMode>(initialSettings.sort);
  const [view, setView] = useState<ViewMode>(initialSettings.view);
  const [filters, setFilters] = useState<FilterState>(initialSettings.filters);
  const [filtersOpen, setFiltersOpen] = useState(initialSettings.filtersOpen);
  const [visibleState, setVisibleState] = useState({ key: "", count: 30 });
  const [saved, setSaved] = useState<Set<string>>(initialSavedRestaurants);
  const [userLocation, setUserLocation] = useState<LocationPoint | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [locationPending, setLocationPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const resultsRegion = useRef<HTMLElement>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const datasetUrl = new URL("data/restaurants.json", document.baseURI).toString();
    fetch(datasetUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Dataset request failed (${response.status})`);
        return response.json() as Promise<RestaurantDataset>;
      })
      .then(setDataset)
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : "Could not load the dataset"),
      );
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (view !== "split") params.set("view", view);
    if (sort !== "best-match") params.set("sort", sort);
    const lists: Array<[string, string[]]> = [
      ["borough", filters.boroughs],
      ["neighborhood", filters.neighborhoods],
      ["cuisine", filters.cuisines],
      ["lunch-price", filters.lunchPrices],
      ["dinner-price", filters.dinnerPrices],
      ["meal", filters.mealPeriods],
      ["week", filters.weeks],
      ["collection", filters.collections],
      ["access", filters.accessibility],
      ["diet", filters.dietaryNeeds],
      ["amenity", filters.amenities],
      ["grade", filters.healthGrades],
    ];
    lists.forEach(([key, values]) => {
      if (values.length) params.set(key, values.join("|"));
    });
    if (filters.hasMenu) params.set("menu", "1");
    if (filters.hasReservation) params.set("reservation", "1");
    if (filters.savedOnly) params.set("saved", "1");
    if (filters.maxDistance !== null) params.set("radius", String(filters.maxDistance));
    if (filters.healthScoreMin !== null)
      params.set("score-min", String(filters.healthScoreMin));
    if (filters.healthScoreMax !== null)
      params.set("score-max", String(filters.healthScoreMax));
    const queryString = params.toString();
    window.history.replaceState(null, "", queryString ? `?${queryString}` : window.location.pathname);
  }, [filters, query, sort, view]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const restaurants = useMemo(() => dataset?.restaurants ?? [], [dataset]);
  const facets = useMemo<ExplorerFacets>(
    () => ({
      boroughs: countFacet(restaurants, (restaurant) => [restaurant.borough]),
      neighborhoods: countFacet(restaurants, (restaurant) => [restaurant.neighborhood]),
      cuisines: countFacet(restaurants, (restaurant) => restaurant.cuisines),
      weeks: countFacet(restaurants, (restaurant) => restaurant.weeksParticipating),
      collections: countFacet(restaurants, (restaurant) => restaurant.collections),
      accessibility: countFacet(restaurants, (restaurant) => restaurant.accessibility),
      dietaryNeeds: countFacet(restaurants, (restaurant) => restaurant.dietaryNeeds),
      amenities: countFacet(restaurants, (restaurant) => restaurant.amenities),
      healthGrades: countFacet(restaurants, (restaurant) =>
        restaurant.healthInspection ? [restaurant.healthInspection.grade] : [],
      ),
      healthScoreRange: (() => {
        const scores = restaurants.flatMap((restaurant) => {
          const score = restaurant.healthInspection?.score;
          return typeof score === "number" ? [score] : [];
        });
        return scores.length ? { min: Math.min(...scores), max: Math.max(...scores) } : null;
      })(),
    }),
    [restaurants],
  );

  const enrichedRestaurants = useMemo(
    () =>
      restaurants.map((restaurant) => {
        const distance = restaurantDistance(restaurant, userLocation);
        return distance === null ? restaurant : { ...restaurant, distanceMiles: distance };
      }),
    [restaurants, userLocation],
  );

  const filteredRestaurants = useMemo(() => {
    const matches = enrichedRestaurants.filter((restaurant) => {
      if (!restaurantMatchesSearch(restaurant, query)) return false;
      if (!directSelected(restaurant.borough, filters.boroughs)) return false;
      if (!directSelected(restaurant.neighborhood, filters.neighborhoods)) return false;
      if (!selectedIn(restaurant.cuisines, filters.cuisines)) return false;
      if (!selectedIn(mealPrices(restaurant, "lunch").map(String), filters.lunchPrices))
        return false;
      if (!selectedIn(mealPrices(restaurant, "dinner").map(String), filters.dinnerPrices))
        return false;
      if (
        filters.mealPeriods.length &&
        !filters.mealPeriods.some((period) => mealPeriodMatches(restaurant, period))
      )
        return false;
      if (!selectedIn(restaurant.weeksParticipating, filters.weeks)) return false;
      if (!selectedIn(restaurant.collections, filters.collections)) return false;
      if (!selectedIn(restaurant.accessibility, filters.accessibility)) return false;
      if (!selectedIn(restaurant.dietaryNeeds, filters.dietaryNeeds)) return false;
      if (!selectedIn(restaurant.amenities, filters.amenities)) return false;
      if (
        filters.healthGrades.length &&
        (!restaurant.healthInspection ||
          !filters.healthGrades.includes(restaurant.healthInspection.grade))
      )
        return false;
      if (filters.healthScoreMin !== null || filters.healthScoreMax !== null) {
        const score = restaurant.healthInspection?.score;
        if (
          typeof score !== "number" ||
          (filters.healthScoreMin !== null && score < filters.healthScoreMin) ||
          (filters.healthScoreMax !== null && score > filters.healthScoreMax)
        )
          return false;
      }
      if (filters.hasMenu && !restaurant.menu) return false;
      if (filters.hasReservation && !restaurant.reservation) return false;
      if (filters.savedOnly && !saved.has(restaurant.slug)) return false;
      if (
        filters.maxDistance !== null &&
        (restaurant.distanceMiles === undefined || restaurant.distanceMiles > filters.maxDistance)
      )
        return false;
      return true;
    });
    return sortRestaurants(matches, sort, query);
  }, [enrichedRestaurants, filters, query, saved, sort]);

  const restaurantBySlug = useMemo(
    () => new Map(enrichedRestaurants.map((restaurant) => [restaurant.slug, restaurant])),
    [enrichedRestaurants],
  );
  const selectedRestaurant = selectedSlug ? restaurantBySlug.get(selectedSlug) ?? null : null;
  const detailRestaurant = detailSlug ? restaurantBySlug.get(detailSlug) ?? null : null;
  const activeCount = activeFilterCount(filters);
  const resultsKey = JSON.stringify([filters, query, sort, view]);
  const visibleCount = visibleState.key === resultsKey ? visibleState.count : 30;

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;
    if (!sentinel || visibleCount >= filteredRestaurants.length) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setVisibleState((current) => {
          const currentCount = current.key === resultsKey ? current.count : 30;
          return {
            key: resultsKey,
            count: Math.min(currentCount + 30, filteredRestaurants.length),
          };
        });
      },
      { root: resultsRegion.current, rootMargin: "500px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filteredRestaurants.length, resultsKey, visibleCount]);

  const toggleSaved = useCallback((slug: string) => {
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      try {
        window.localStorage.setItem(SAVED_KEY, JSON.stringify([...next]));
      } catch {
        // Saving remains available in memory if storage is disabled.
      }
      return next;
    });
  }, []);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setToast("Location is not supported by this browser.");
      return;
    }
    setLocationPending(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({ lat: position.coords.latitude, lon: position.coords.longitude });
        setLocationPending(false);
        setSort("distance");
        setToast("Location added — results can now be sorted by distance.");
      },
      (error) => {
        setLocationPending(false);
        setToast(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was declined."
            : "We could not determine your location.",
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 },
    );
  }, []);

  const shareView = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast("A link to this view was copied.");
    } catch {
      setToast("Copy the URL in your browser to share this view.");
    }
  }, []);

  const copyRestaurantName = useCallback(async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setToast(`Copied “${name}”.`);
    } catch {
      setToast("The restaurant name could not be copied.");
    }
  }, []);

  const toggleQuickArray = (
    key: "lunchPrices" | "dinnerPrices" | "mealPeriods" | "boroughs" | "healthGrades",
    value: string,
  ) => {
    const current = filters[key];
    setFilters({
      ...filters,
      [key]: current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    });
  };

  const removeFilter = (key: keyof FilterState | "healthScoreRange", value?: string) => {
    if (key === "healthScoreRange") {
      setFilters({ ...filters, healthScoreMin: null, healthScoreMax: null });
      return;
    }
    if (Array.isArray(filters[key])) {
      setFilters({
        ...filters,
        [key]: (filters[key] as string[]).filter((entry) => entry !== value),
      });
    } else if (key === "maxDistance") {
      setFilters({ ...filters, maxDistance: null });
    } else {
      setFilters({ ...filters, [key]: false });
    }
  };

  const activeChips = useMemo(() => {
    const values: Array<{
      key: keyof FilterState | "healthScoreRange";
      value?: string;
      label: string;
    }> = [];
    const arrayKeys: Array<keyof FilterState> = [
      "boroughs",
      "neighborhoods",
      "cuisines",
      "lunchPrices",
      "dinnerPrices",
      "mealPeriods",
      "weeks",
      "collections",
      "accessibility",
      "dietaryNeeds",
      "amenities",
      "healthGrades",
    ];
    arrayKeys.forEach((key) => {
      (filters[key] as string[]).forEach((value) =>
        values.push({ key, value, label: filterLabel(key, value) }),
      );
    });
    if (filters.hasMenu) values.push({ key: "hasMenu", label: "Has menu" });
    if (filters.hasReservation)
      values.push({ key: "hasReservation", label: "Reservable" });
    if (filters.savedOnly) values.push({ key: "savedOnly", label: "Saved" });
    if (filters.maxDistance !== null)
      values.push({ key: "maxDistance", label: `Within ${filters.maxDistance} mi` });
    if (filters.healthScoreMin !== null || filters.healthScoreMax !== null) {
      const scoreLabel =
        filters.healthScoreMin !== null && filters.healthScoreMax !== null
          ? `Score ${filters.healthScoreMin}–${filters.healthScoreMax}`
          : filters.healthScoreMin !== null
            ? `Score ${filters.healthScoreMin}+`
            : `Score ≤ ${filters.healthScoreMax}`;
      values.push({ key: "healthScoreRange", label: scoreLabel });
    }
    return values;
  }, [filters]);

  if (loadError) {
    return (
      <main className="load-state error-state">
        <UtensilsCrossed size={34} />
        <h1>The restaurant list could not be loaded.</h1>
        <p>{loadError}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }

  if (!dataset) {
    return (
      <main className="load-state">
        <div className="brand-mark large-brand-mark">
          <UtensilsCrossed size={24} />
        </div>
        <LoaderCircle className="spin" size={22} />
        <p>Setting the table for 620 restaurants…</p>
      </main>
    );
  }

  const compactCards = view === "split";
  const resultsToRender = filteredRestaurants.slice(0, visibleCount);

  return (
    <main className="explorer-app">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <UtensilsCrossed size={20} />
          </div>
          <div className="brand-copy">
            <span>Summer 2026 · NYC</span>
            <strong>Restaurant Week Explorer</strong>
          </div>
        </div>

        <label className="global-search">
          <Search size={19} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search restaurants, cuisines, neighborhoods or dishes"
            aria-label="Search restaurants and menu dishes"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={17} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>

        <div className="header-actions">
          <button type="button" onClick={requestLocation} className={userLocation ? "is-active" : ""}>
            {locationPending ? (
              <LoaderCircle size={18} className="spin" />
            ) : userLocation ? (
              <LocateFixed size={18} />
            ) : (
              <Crosshair size={18} />
            )}
            <span>{userLocation ? "Located" : "Near me"}</span>
          </button>
          <button
            type="button"
            onClick={() => setFilters({ ...filters, savedOnly: !filters.savedOnly })}
            className={filters.savedOnly ? "is-active" : ""}
          >
            <Heart size={18} fill={filters.savedOnly ? "currentColor" : "none"} />
            <span>Saved</span>
            {saved.size ? <em>{saved.size}</em> : null}
          </button>
        </div>
      </header>

      <nav className="discovery-bar" aria-label="Discovery controls">
        <div className="quick-filters">
          <button
            type="button"
            className={`filter-master-button ${filtersOpen ? "is-active" : ""}`}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            {filtersOpen ? <PanelLeftClose size={17} /> : <SlidersHorizontal size={17} />}
            Filters
            {activeCount ? <strong>{activeCount}</strong> : null}
          </button>
          <span className="quick-divider" />
          {[
            ["lunchPrices", "30", "Lunch $30"],
            ["lunchPrices", "45", "Lunch $45"],
            ["dinnerPrices", "45", "Dinner $45"],
            ["dinnerPrices", "60", "Dinner $60"],
            ["mealPeriods", "weekday-lunch", "Lunch"],
            ["mealPeriods", "weekday-dinner", "Dinner"],
            ["boroughs", "Brooklyn", "Brooklyn"],
            ["healthGrades", "A", "NYC grade A"],
          ].map(([key, value, label]) => {
            const active = (filters[key as "lunchPrices" | "dinnerPrices" | "mealPeriods" | "boroughs" | "healthGrades"] as string[]).includes(value);
            return (
              <button
                type="button"
                key={`${key}-${value}`}
                className={`quick-filter ${active ? "is-active" : ""}`}
                onClick={() => toggleQuickArray(key as "lunchPrices" | "dinnerPrices" | "mealPeriods" | "boroughs" | "healthGrades", value)}
              >
                {active ? <Check size={13} /> : null}
                {label}
              </button>
            );
          })}
        </div>

        <div className="view-controls">
          <button type="button" onClick={shareView} className="share-button" aria-label="Copy link to this view">
            <Share2 size={16} />
          </button>
          <div className="view-toggle" aria-label="View style">
            <button
              type="button"
              className={view === "list" ? "is-active" : ""}
              onClick={() => setView("list")}
              aria-label="List view"
            >
              <Grid2X2 size={16} />
            </button>
            <button
              type="button"
              className={`split-view-button ${view === "split" ? "is-active" : ""}`}
              onClick={() => setView("split")}
              aria-label="Split list and map view"
            >
              <SplitSquareHorizontal size={16} />
            </button>
            <button
              type="button"
              className={view === "map" ? "is-active" : ""}
              onClick={() => setView("map")}
              aria-label="Map view"
            >
              <MapIcon size={16} />
            </button>
          </div>
        </div>
      </nav>

      {activeChips.length ? (
        <div className="active-filter-strip">
          <span>Active</span>
          <div>
            {activeChips.map((chip) => (
              <button
                type="button"
                key={`${chip.key}-${chip.value ?? "toggle"}`}
                onClick={() => removeFilter(chip.key, chip.value)}
              >
                {chip.label} <X size={12} />
              </button>
            ))}
          </div>
          <button type="button" className="clear-all-link" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear all
          </button>
        </div>
      ) : null}

      <div className={`explorer-body view-${view} ${filtersOpen ? "filters-open" : ""}`}>
        {filtersOpen ? (
          <>
            <div className="filter-mobile-backdrop" onClick={() => setFiltersOpen(false)} />
            <FilterPanel
              filters={filters}
              facets={facets}
              activeCount={activeCount}
              hasLocation={Boolean(userLocation)}
              onChange={setFilters}
              onReset={() => setFilters(EMPTY_FILTERS)}
              onClose={() => setFiltersOpen(false)}
              onRequestLocation={requestLocation}
            />
          </>
        ) : null}

        <section ref={resultsRegion} className="results-region" aria-label="Restaurant results">
          <div className="results-header">
            <div>
              <span className="results-eyebrow">
                <Sparkles size={14} /> July 20 – August 16
              </span>
              <h1>
                {filteredRestaurants.length.toLocaleString()} restaurant
                {filteredRestaurants.length === 1 ? "" : "s"}
              </h1>
              <p>
                {query ? `Matches for “${query}”` : "Prix-fixe dining across all five boroughs"}
              </p>
            </div>
            <label className="sort-control">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(event) => {
                  const nextSort = event.target.value as SortMode;
                  if (nextSort === "distance" && !userLocation) requestLocation();
                  setSort(nextSort);
                }}
              >
                <option value="best-match">{query ? "Best match" : "Featured"}</option>
                <option value="name">Name A–Z</option>
                <option value="distance">Closest to me</option>
                <option value="price">Lowest price</option>
                <option value="offers">Most meal offers</option>
                <option value="weeks">Most weeks</option>
                <option value="neighborhood">Neighborhood</option>
                <option value="health-grade">NYC health grade</option>
                <option value="health-score">Lowest inspection score</option>
              </select>
              <ChevronDown size={14} />
            </label>
          </div>

          {filteredRestaurants.length ? (
            <>
              <div className={`restaurant-grid ${compactCards ? "restaurant-list-compact" : ""}`}>
                {resultsToRender.map((restaurant) => (
                  <RestaurantCard
                    key={restaurant.slug}
                    restaurant={restaurant}
                    saved={saved.has(restaurant.slug)}
                    selected={selectedSlug === restaurant.slug}
                    compact={compactCards}
                    onCopyName={() => copyRestaurantName(restaurant.name)}
                    onOpen={() => {
                      setSelectedSlug(restaurant.slug);
                      setDetailSlug(restaurant.slug);
                    }}
                    onSelect={() => setSelectedSlug(restaurant.slug)}
                    onToggleSaved={() => toggleSaved(restaurant.slug)}
                  />
                ))}
              </div>
              {visibleCount < filteredRestaurants.length ? (
                <div
                  ref={loadMoreSentinel}
                  className="auto-load-sentinel"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  Loading more restaurants
                  <span>{visibleCount} of {filteredRestaurants.length}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-results">
              <ListFilter size={30} />
              <h2>No tables match this combination.</h2>
              <p>Try removing a cuisine, location, or price filter.</p>
              <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setQuery(""); }}>
                Reset the search
              </button>
            </div>
          )}
        </section>

        <div className="map-region">
          <MapView
            restaurants={filteredRestaurants}
            selected={selectedRestaurant}
            userLocation={userLocation}
            maxDistance={filters.maxDistance}
            saved={saved}
            onSelect={setSelectedSlug}
            onOpenDetails={(restaurant) => setDetailSlug(restaurant.slug)}
            onCopyName={copyRestaurantName}
            onRequestLocation={requestLocation}
            onToggleSaved={toggleSaved}
            layoutKey={`${view}-${filtersOpen}`}
          />
        </div>
      </div>

      <div className="mobile-bottom-bar">
        <button type="button" onClick={() => setFiltersOpen(true)}>
          <SlidersHorizontal size={17} /> Filters {activeCount ? <strong>{activeCount}</strong> : null}
        </button>
        <button type="button" onClick={() => setView(view === "map" ? "list" : "map")}>
          {view === "map" ? <List size={17} /> : <MapIcon size={17} />}
          {view === "map" ? "List" : "Map"}
        </button>
      </div>

      <DetailDrawer
        key={detailRestaurant?.slug ?? "closed"}
        restaurant={detailRestaurant}
        saved={detailRestaurant ? saved.has(detailRestaurant.slug) : false}
        onClose={() => setDetailSlug(null)}
        onCopyName={copyRestaurantName}
        onToggleSaved={() => detailRestaurant && toggleSaved(detailRestaurant.slug)}
      />

      {toast ? <div className="app-toast">{toast}</div> : null}
    </main>
  );
}
