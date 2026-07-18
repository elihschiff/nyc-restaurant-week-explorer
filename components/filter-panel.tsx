"use client";

import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Crosshair,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { FilterState } from "@/lib/types";
import { BOROUGH_ORDER, COLLECTION_LABELS, displayWeek } from "@/lib/explorer";

export type FacetOption = { value: string; count: number };

export type ExplorerFacets = {
  boroughs: FacetOption[];
  neighborhoods: FacetOption[];
  cuisines: FacetOption[];
  weeks: FacetOption[];
  collections: FacetOption[];
  accessibility: FacetOption[];
  dietaryNeeds: FacetOption[];
  amenities: FacetOption[];
};

type ArrayFilterKey =
  | "boroughs"
  | "neighborhoods"
  | "cuisines"
  | "prices"
  | "mealPeriods"
  | "weeks"
  | "collections"
  | "accessibility"
  | "dietaryNeeds"
  | "amenities";

type FilterPanelProps = {
  filters: FilterState;
  facets: ExplorerFacets;
  activeCount: number;
  hasLocation: boolean;
  onChange: (filters: FilterState) => void;
  onReset: () => void;
  onClose: () => void;
  onRequestLocation: () => void;
};

function FacetSection({
  title,
  options,
  selected,
  onToggle,
  searchable = false,
  defaultOpen = true,
  labelTransform,
}: {
  title: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
  searchable?: boolean;
  defaultOpen?: boolean;
  labelTransform?: (value: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(defaultOpen || selected.length > 0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const values = normalized
      ? options.filter((option) => option.value.toLocaleLowerCase().includes(normalized))
      : options;
    return [...values].sort((a, b) => {
      const selectedDelta = Number(selected.includes(b.value)) - Number(selected.includes(a.value));
      return selectedDelta || b.count - a.count || a.value.localeCompare(b.value);
    });
  }, [options, query, selected]);
  const visible = expanded || query ? filtered : filtered.slice(0, 8);

  return (
    <details
      className="filter-section"
      open={sectionOpen}
      onToggle={(event) => setSectionOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{title}</span>
        {selected.length ? <span className="filter-section-count">{selected.length}</span> : null}
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="filter-section-body">
        {searchable && options.length > 8 ? (
          <label className="facet-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Find ${title.toLocaleLowerCase()}`}
            />
          </label>
        ) : null}
        <div className="facet-options">
          {visible.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label key={option.value} className="facet-option">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(option.value)}
                />
                <span className="facet-checkbox">{checked ? <Check size={11} /> : null}</span>
                <span className="facet-label">
                  {labelTransform ? labelTransform(option.value) : option.value}
                </span>
                <span className="facet-count">{option.count}</span>
              </label>
            );
          })}
        </div>
        {!query && filtered.length > 8 ? (
          <button
            type="button"
            className="facet-show-more"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : `Show all ${filtered.length}`}
          </button>
        ) : null}
      </div>
    </details>
  );
}

export default function FilterPanel({
  filters,
  facets,
  activeCount,
  hasLocation,
  onChange,
  onReset,
  onClose,
  onRequestLocation,
}: FilterPanelProps) {
  const toggleArray = (key: ArrayFilterKey, value: string) => {
    const current = filters[key];
    onChange({
      ...filters,
      [key]: current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    });
  };

  const boroughs = [...facets.boroughs].sort(
    (a, b) => BOROUGH_ORDER.indexOf(a.value) - BOROUGH_ORDER.indexOf(b.value),
  );

  return (
    <aside className="filter-panel" aria-label="Restaurant filters">
      <div className="filter-panel-header">
        <div>
          <span className="filter-panel-eyebrow">Refine your table</span>
          <h2>
            <SlidersHorizontal size={18} /> Filters
            {activeCount ? <span>{activeCount}</span> : null}
          </h2>
        </div>
        <button type="button" onClick={onClose} className="filter-close" aria-label="Close filters">
          <X size={19} />
        </button>
      </div>

      <div className="filter-panel-scroll">
        <section className="filter-quick-section">
          <div className="filter-mini-title">Prix fixe price</div>
          <div className="choice-chip-grid choice-chip-grid-three">
            {["30", "45", "60"].map((price) => (
              <button
                type="button"
                key={price}
                className={filters.prices.includes(price) ? "is-active" : ""}
                onClick={() => toggleArray("prices", price)}
              >
                ${price}
              </button>
            ))}
          </div>

          <div className="filter-mini-title">When</div>
          <div className="choice-chip-grid choice-chip-grid-two">
            {[
              ["weekday-lunch", "Weekday lunch"],
              ["weekday-dinner", "Weekday dinner"],
              ["sunday-lunch", "Sunday brunch"],
              ["sunday-dinner", "Sunday dinner"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={filters.mealPeriods.includes(value) ? "is-active" : ""}
                onClick={() => toggleArray("mealPeriods", value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <FacetSection
          title="Borough"
          options={boroughs}
          selected={filters.boroughs}
          onToggle={(value) => toggleArray("boroughs", value)}
        />
        <FacetSection
          title="Neighborhood"
          options={facets.neighborhoods}
          selected={filters.neighborhoods}
          onToggle={(value) => toggleArray("neighborhoods", value)}
          searchable
        />
        <FacetSection
          title="Cuisine"
          options={facets.cuisines}
          selected={filters.cuisines}
          onToggle={(value) => toggleArray("cuisines", value)}
          searchable
        />

        <details className="filter-section" open>
          <summary>
            <span>Distance</span>
            {filters.maxDistance ? (
              <span className="filter-section-count">{filters.maxDistance} mi</span>
            ) : null}
            <ChevronDown size={15} />
          </summary>
          <div className="filter-section-body distance-filter">
            {hasLocation ? (
              <>
                <label htmlFor="distance-select">Show restaurants within</label>
                <select
                  id="distance-select"
                  value={filters.maxDistance ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...filters,
                      maxDistance: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                >
                  <option value="">Any distance</option>
                  <option value="0.5">0.5 mile</option>
                  <option value="1">1 mile</option>
                  <option value="2">2 miles</option>
                  <option value="3">3 miles</option>
                  <option value="5">5 miles</option>
                  <option value="10">10 miles</option>
                </select>
              </>
            ) : (
              <button type="button" className="location-filter-button" onClick={onRequestLocation}>
                <Crosshair size={15} /> Use my location
              </button>
            )}
          </div>
        </details>

        <FacetSection
          title="Participation week"
          options={facets.weeks}
          selected={filters.weeks}
          onToggle={(value) => toggleArray("weeks", value)}
          labelTransform={displayWeek}
          defaultOpen={false}
        />
        <FacetSection
          title="Curated collection"
          options={facets.collections}
          selected={filters.collections}
          onToggle={(value) => toggleArray("collections", value)}
          labelTransform={(value) => COLLECTION_LABELS[value] ?? value}
          defaultOpen={false}
        />
        <FacetSection
          title="Dietary needs"
          options={facets.dietaryNeeds}
          selected={filters.dietaryNeeds}
          onToggle={(value) => toggleArray("dietaryNeeds", value)}
          defaultOpen={false}
        />
        <FacetSection
          title="Accessibility"
          options={facets.accessibility}
          selected={filters.accessibility}
          onToggle={(value) => toggleArray("accessibility", value)}
          defaultOpen={false}
        />
        <FacetSection
          title="Amenities"
          options={facets.amenities}
          selected={filters.amenities}
          onToggle={(value) => toggleArray("amenities", value)}
          searchable
          defaultOpen={false}
        />

        <section className="filter-toggle-section">
          <label className="switch-row">
            <span>
              <strong>Published menu</strong>
              <small>Only show restaurants with a menu PDF</small>
            </span>
            <input
              type="checkbox"
              checked={filters.hasMenu}
              onChange={(event) => onChange({ ...filters, hasMenu: event.target.checked })}
            />
            <span className="switch-control" />
          </label>
          <label className="switch-row">
            <span>
              <strong>Online reservation</strong>
              <small>OpenTable partner listings</small>
            </span>
            <input
              type="checkbox"
              checked={filters.hasReservation}
              onChange={(event) =>
                onChange({ ...filters, hasReservation: event.target.checked })
              }
            />
            <span className="switch-control" />
          </label>
          <label className="switch-row">
            <span>
              <strong>Saved places</strong>
              <small>Your picks on this device</small>
            </span>
            <input
              type="checkbox"
              checked={filters.savedOnly}
              onChange={(event) => onChange({ ...filters, savedOnly: event.target.checked })}
            />
            <span className="switch-control" />
          </label>
        </section>
      </div>

      <div className="filter-panel-footer">
        <button type="button" className="filter-reset" onClick={onReset} disabled={!activeCount}>
          <RotateCcw size={15} /> Reset
        </button>
        <button type="button" className="filter-done" onClick={onClose}>
          Show results
        </button>
      </div>
    </aside>
  );
}
