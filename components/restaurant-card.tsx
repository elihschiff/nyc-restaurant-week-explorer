"use client";

import { ArrowUpRight, CalendarDays, Copy, FileText, Heart, MapPin } from "lucide-react";
import type { Restaurant } from "@/lib/types";
import {
  displayHealthGrade,
  displayWeek,
  formatDistance,
  healthGradeClass,
  imageFor,
  uniquePrices,
} from "@/lib/explorer";

type RestaurantCardProps = {
  restaurant: Restaurant;
  saved: boolean;
  selected?: boolean;
  compact?: boolean;
  onOpen: () => void;
  onCopyName: () => void;
  onSelect: () => void;
  onToggleSaved: () => void;
};

export default function RestaurantCard({
  restaurant,
  saved,
  selected = false,
  compact = false,
  onOpen,
  onCopyName,
  onSelect,
  onToggleSaved,
}: RestaurantCardProps) {
  const image = imageFor(restaurant);
  const prices = uniquePrices(restaurant);
  const extended = restaurant.weeksParticipating.some((week) =>
    /Week [5-7]/.test(week),
  );

  return (
    <article
      className={`restaurant-card ${compact ? "restaurant-card-compact" : ""} ${
        selected ? "is-selected" : ""
      }`}
      onMouseEnter={onSelect}
      onFocus={onSelect}
    >
      <button
        type="button"
        className="restaurant-card-open-button"
        onClick={onOpen}
        aria-label={`View details for ${restaurant.name}`}
      />
      <div className="restaurant-card-main">
        <div className="restaurant-card-image-wrap">
          {image ? (
            // Image URLs come from the public NYC Tourism CDN.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={restaurant.gridImage?.alt || restaurant.images[0]?.alt || ""}
              className="restaurant-card-image"
              loading="lazy"
            />
          ) : (
            <div className="restaurant-card-placeholder" aria-hidden="true">
              <span>{restaurant.name.slice(0, 1)}</span>
            </div>
          )}
          <div className="restaurant-card-price">
            {prices.length
              ? prices.map((price) => `$${price}`).join(" · ")
              : "Prix fixe"}
          </div>
          {restaurant.menu ? (
            <div className="restaurant-card-menu-badge">
              <FileText size={12} /> Menu
            </div>
          ) : null}
          {restaurant.healthInspection ? (
            <div className={`restaurant-card-health ${healthGradeClass(restaurant.healthInspection.grade)}`}>
              <strong>{displayHealthGrade(restaurant.healthInspection.grade)}</strong>
              {restaurant.healthInspection.score !== null ? (
                <span>{restaurant.healthInspection.score} pts</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="restaurant-card-content">
          <div className="restaurant-card-location">
            <MapPin size={13} aria-hidden="true" />
            <span>{restaurant.neighborhood}</span>
            {restaurant.distanceMiles !== undefined ? (
              <span className="restaurant-card-distance">
                {formatDistance(restaurant.distanceMiles)}
              </span>
            ) : null}
          </div>
          <div className="restaurant-card-title-row">
            <h3>{restaurant.name}</h3>
            <button
              type="button"
              className="restaurant-name-copy"
              onClick={onCopyName}
              aria-label={`Copy ${restaurant.name}`}
              title="Copy restaurant name"
            >
              <Copy size={13} />
            </button>
          </div>
          <p className="restaurant-card-cuisine">
            {restaurant.cuisines.slice(0, 3).join(" · ") || restaurant.borough}
          </p>
          {!compact && restaurant.summary ? (
            <p className="restaurant-card-summary">{restaurant.summary}</p>
          ) : null}
          <div className="restaurant-card-footer">
            <span>
              <CalendarDays size={13} />
              {restaurant.weeksParticipating.length} week
              {restaurant.weeksParticipating.length === 1 ? "" : "s"}
            </span>
            {extended ? <span className="extended-label">Extended</span> : null}
            <span className="card-view-link">
              Explore <ArrowUpRight size={13} />
            </span>
          </div>
          {compact ? (
            <div className="restaurant-card-weekline">
              {restaurant.weeksParticipating.slice(0, 3).map(displayWeek).join(" · ")}
              {restaurant.weeksParticipating.length > 3 ? " · …" : ""}
            </div>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className={`restaurant-save-button ${saved ? "is-saved" : ""}`}
        onClick={onToggleSaved}
        aria-label={saved ? `Remove ${restaurant.name} from saved` : `Save ${restaurant.name}`}
      >
        <Heart size={17} fill={saved ? "currentColor" : "none"} />
      </button>
    </article>
  );
}
