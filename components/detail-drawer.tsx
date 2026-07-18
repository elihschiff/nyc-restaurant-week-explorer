"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Accessibility,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  Heart,
  MapPin,
  Navigation,
  Phone,
  ShieldCheck,
  Utensils,
  X,
} from "lucide-react";
import type { Restaurant } from "@/lib/types";
import {
  displayCollection,
  displayHealthGrade,
  displayMealType,
  formatDistance,
  healthGradeClass,
  imageFor,
} from "@/lib/explorer";

type DetailDrawerProps = {
  restaurant: Restaurant | null;
  saved: boolean;
  onClose: () => void;
  onToggleSaved: () => void;
};

function formatInspectionDate(value: string | null): string {
  if (!value) return "Not available";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function DetailDrawer({
  restaurant,
  saved,
  onClose,
  onToggleSaved,
}: DetailDrawerProps) {
  const [tab, setTab] = useState<"overview" | "menu">("overview");

  useEffect(() => {
    if (!restaurant) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [restaurant, onClose]);

  const directionsUrl = useMemo(() => {
    if (!restaurant) return "";
    const location = restaurant.coordinates
      ? `${restaurant.coordinates.lat},${restaurant.coordinates.lon ?? restaurant.coordinates.lng}`
      : restaurant.address?.raw ?? restaurant.name;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  }, [restaurant]);

  if (!restaurant) return null;
  const image = imageFor(restaurant);

  return (
    <div className="detail-overlay" role="presentation" onMouseDown={onClose}>
      <aside
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="detail-hero">
          {image ? (
            // Image URLs come from the public NYC Tourism CDN.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" />
          ) : (
            <div className="detail-hero-placeholder" />
          )}
          <div className="detail-hero-shade" />
          <button type="button" className="detail-close" onClick={onClose} aria-label="Close details">
            <X size={20} />
          </button>
          <button
            type="button"
            className={`detail-save ${saved ? "is-saved" : ""}`}
            onClick={onToggleSaved}
            aria-label={saved ? "Remove saved restaurant" : "Save restaurant"}
          >
            <Heart size={19} fill={saved ? "currentColor" : "none"} />
          </button>
          <div className="detail-hero-copy">
            <p>
              {restaurant.neighborhood} · {restaurant.borough}
              {restaurant.distanceMiles !== undefined ? (
                <> · {formatDistance(restaurant.distanceMiles)}</>
              ) : null}
            </p>
            <h2 id="detail-title">{restaurant.name}</h2>
            <span>{restaurant.cuisines.join(" · ")}</span>
          </div>
        </div>

        <div className="detail-actions">
          {restaurant.menu?.url ? (
            <a href={restaurant.menu.url} target="_blank" rel="noreferrer" className="detail-primary-action">
              <FileText size={16} /> Menu PDF
            </a>
          ) : null}
          <a href={directionsUrl} target="_blank" rel="noreferrer">
            <Navigation size={16} /> Directions
          </a>
          {restaurant.website ? (
            <a href={restaurant.website} target="_blank" rel="noreferrer">
              Website <ArrowUpRight size={15} />
            </a>
          ) : null}
        </div>

        <div className="detail-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            className={tab === "overview" ? "is-active" : ""}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "menu"}
            className={tab === "menu" ? "is-active" : ""}
            onClick={() => setTab("menu")}
            disabled={!restaurant.menu}
          >
            Menu {restaurant.menu?.pages ? `(${restaurant.menu.pages}p)` : ""}
          </button>
        </div>

        <div className="detail-scroll">
          {tab === "overview" ? (
            <div className="detail-overview">
              {restaurant.detailSourceError ? (
                <div className="detail-source-note">
                  <CheckCircle2 size={16} />
                  NYC Tourism&apos;s detail page is temporarily unavailable; the map location was
                  supplemented from the restaurant&apos;s published address.
                </div>
              ) : null}

              {restaurant.description || restaurant.summary ? (
                <section className="detail-section detail-description">
                  <h3>About</h3>
                  <p>{restaurant.description || restaurant.summary}</p>
                </section>
              ) : null}

              {restaurant.healthInspection ? (
                <section className="detail-section health-inspection-section">
                  <div className="detail-section-heading">
                    <ShieldCheck size={18} />
                    <h3>NYC health inspection</h3>
                  </div>
                  <div className="health-inspection-summary">
                    <div>
                      <span>Current grade</span>
                      <strong className={`health-grade-tile ${healthGradeClass(restaurant.healthInspection.grade)}`}>
                        {displayHealthGrade(restaurant.healthInspection.grade)}
                      </strong>
                    </div>
                    <div>
                      <span>Latest score</span>
                      <strong>
                        {restaurant.healthInspection.score ?? "—"}
                        {restaurant.healthInspection.score !== null ? <small> points</small> : null}
                      </strong>
                    </div>
                    <div>
                      <span>Inspected</span>
                      <strong>{formatInspectionDate(restaurant.healthInspection.inspectionDate)}</strong>
                    </div>
                  </div>
                  <p className="health-score-note">
                    The score is violation points from the latest inspection; lower is better.
                    The grade is NYC Health&apos;s current posted grade.
                  </p>

                  {restaurant.healthInspection.inspectionHistory.length ? (
                    <div className="health-history" aria-label="Recent inspection history">
                      <div className="health-history-heading">
                        <strong>Recent inspections</strong>
                        <span>Score</span>
                      </div>
                      {restaurant.healthInspection.inspectionHistory.map((inspection) => (
                        <div key={`${inspection.date}-${inspection.score}-${inspection.result}`}>
                          <span>
                            {formatInspectionDate(inspection.date)}
                            <small>{inspection.result}</small>
                          </span>
                          <strong>{inspection.score ?? "—"}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {restaurant.healthInspection.violations.length ? (
                    <details className="health-violations">
                      <summary>
                        <span>
                          Latest violations ({restaurant.healthInspection.violationCount})
                        </span>
                        {restaurant.healthInspection.criticalViolationCount ? (
                          <strong>
                            {restaurant.healthInspection.criticalViolationCount} critical
                          </strong>
                        ) : null}
                      </summary>
                      <ul>
                        {restaurant.healthInspection.violations.map((violation, index) => (
                          <li key={`${index}-${violation.description}`}>
                            {violation.critical ? <strong>Critical</strong> : null}
                            <span>{violation.description}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <a
                    className="health-official-link"
                    href={restaurant.healthInspection.officialUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View the official ABC Eats record <ExternalLink size={14} />
                  </a>
                </section>
              ) : null}

              <section className="detail-section">
                <div className="detail-section-heading">
                  <Utensils size={17} />
                  <h3>Restaurant Week offers</h3>
                </div>
                <div className="offer-table">
                  {restaurant.mealTypes.map((meal) => {
                    const match = meal.match(/^\$(\d+)\s+(.+?)\s+Price$/);
                    return (
                      <div key={meal}>
                        <span>{match ? displayMealType(match[2]) : displayMealType(meal)}</span>
                        <strong>{match ? `$${match[1]}` : meal}</strong>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="detail-section">
                <div className="detail-section-heading">
                  <CalendarDays size={17} />
                  <h3>Participating weeks</h3>
                </div>
                <div className="week-list">
                  {restaurant.weeksParticipating.map((week) => (
                    <div key={week}>
                      <CheckCircle2 size={15} /> {week}
                    </div>
                  ))}
                </div>
              </section>

              {restaurant.collections.length ? (
                <section className="detail-section">
                  <h3>Featured in</h3>
                  <div className="detail-tags detail-tags-accent">
                    {restaurant.collections.map((collection) => (
                      <span key={collection}>{displayCollection(collection)}</span>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="detail-two-column">
                {restaurant.dietaryNeeds.length ? (
                  <section className="detail-section">
                    <h3>Dietary needs</h3>
                    <div className="detail-tags">
                      {restaurant.dietaryNeeds.map((value) => (
                        <span key={value}>{value}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
                {restaurant.accessibility.length ? (
                  <section className="detail-section">
                    <div className="detail-section-heading">
                      <Accessibility size={17} />
                      <h3>Accessibility</h3>
                    </div>
                    <div className="detail-tags">
                      {restaurant.accessibility.map((value) => (
                        <span key={value}>{value}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>

              {restaurant.amenities.length ? (
                <section className="detail-section">
                  <h3>Amenities</h3>
                  <div className="detail-tags">
                    {restaurant.amenities.map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="detail-section detail-contact">
                <h3>Location & contact</h3>
                {restaurant.address?.raw ? (
                  <a href={directionsUrl} target="_blank" rel="noreferrer">
                    <MapPin size={17} />
                    <span>{restaurant.address.raw}</span>
                    <ExternalLink size={14} />
                  </a>
                ) : null}
                {restaurant.phone ? (
                  <a href={`tel:${restaurant.phone}`}>
                    <Phone size={17} /> <span>{restaurant.phone}</span>
                  </a>
                ) : null}
                <a href={restaurant.officialDetailUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={17} />
                  <span>View official NYC Tourism listing</span>
                </a>
              </section>
            </div>
          ) : (
            <div className="detail-menu-view">
              <div className="detail-menu-header">
                <div>
                  <span>Extracted from the published menu</span>
                  <h3>{restaurant.name}</h3>
                </div>
                {restaurant.menu?.url ? (
                  <a href={restaurant.menu.url} target="_blank" rel="noreferrer">
                    Original PDF <ExternalLink size={14} />
                  </a>
                ) : null}
              </div>
              {restaurant.menu?.text ? (
                <pre>{restaurant.menu.text}</pre>
              ) : (
                <div className="detail-menu-empty">No menu text is available yet.</div>
              )}
              {restaurant.menu?.extractionMethod ? (
                <p className="detail-menu-source">
                  Text extracted with {restaurant.menu.extractionMethod}. Check the PDF for final
                  formatting and availability.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
