"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import { Copy, Crosshair, Expand, Heart, LocateFixed, MapPin, Menu, X } from "lucide-react";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import type { LocationPoint, Restaurant } from "@/lib/types";
import {
  displayHealthGrade,
  formatDistance,
  healthGradeClass,
  imageFor,
  longitudeOf,
  uniquePrices,
} from "@/lib/explorer";

type MapViewProps = {
  restaurants: Restaurant[];
  selected: Restaurant | null;
  userLocation: LocationPoint | null;
  maxDistance: number | null;
  saved: Set<string>;
  onSelect: (slug: string | null) => void;
  onOpenDetails: (restaurant: Restaurant) => void;
  onCopyName: (name: string) => void;
  onRequestLocation: () => void;
  onToggleSaved: (slug: string) => void;
  layoutKey: string;
};

type PointProperties = {
  slug: string;
  name: string;
  neighborhood: string;
};

const NYC_BOUNDS: [[number, number], [number, number]] = [
  [-74.27, 40.49],
  [-73.68, 40.93],
];

function toFeatureCollection(
  restaurants: Restaurant[],
): FeatureCollection<Point, PointProperties> {
  const features: Array<Feature<Point, PointProperties>> = [];
  for (const restaurant of restaurants) {
    const lon = longitudeOf(restaurant);
    if (!restaurant.coordinates || lon === null) continue;
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lon, restaurant.coordinates.lat],
      },
      properties: {
        slug: restaurant.slug,
        name: restaurant.name,
        neighborhood: restaurant.neighborhood,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function radiusPolygon(
  center: LocationPoint,
  radiusMiles: number,
): FeatureCollection<Polygon> {
  const points = 96;
  const earthRadiusMiles = 3958.8;
  const angularDistance = radiusMiles / earthRadiusMiles;
  const lat = (center.lat * Math.PI) / 180;
  const lon = (center.lon * Math.PI) / 180;
  const coordinates: number[][] = [];
  for (let index = 0; index <= points; index += 1) {
    const bearing = (index / points) * Math.PI * 2;
    const targetLat = Math.asin(
      Math.sin(lat) * Math.cos(angularDistance) +
        Math.cos(lat) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const targetLon =
      lon +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat),
        Math.cos(angularDistance) - Math.sin(lat) * Math.sin(targetLat),
      );
    coordinates.push([
      (targetLon * 180) / Math.PI,
      (targetLat * 180) / Math.PI,
    ]);
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [coordinates] },
      },
    ],
  };
}

function emptyPolygons(): FeatureCollection<Polygon> {
  return { type: "FeatureCollection", features: [] };
}

export default function MapView({
  restaurants,
  selected,
  userLocation,
  maxDistance,
  saved,
  onSelect,
  onOpenDetails,
  onCopyName,
  onRequestLocation,
  onToggleSaved,
  layoutKey,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const geojson = useMemo(() => toFeatureCollection(restaurants), [restaurants]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const fitResults = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = geojson.features;
    if (!points.length) return;
    if (points.length === 1) {
      const [longitude, latitude] = points[0].geometry.coordinates;
      map.flyTo({ center: [longitude, latitude], zoom: 14, essential: true });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    points.forEach((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      bounds.extend([longitude, latitude]);
    });
    map.fitBounds(bounds, {
      padding: { top: 86, right: 54, bottom: selected ? 250 : 70, left: 54 },
      maxZoom: 13.4,
      duration: 650,
    });
  }, [geojson, selected]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [-73.9776, 40.724],
      zoom: 10.4,
      minZoom: 9,
      maxZoom: 18,
      maxBounds: NYC_BOUNDS,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("restaurants", {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 44,
      });
      map.addSource("user-location", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("user-radius", {
        type: "geojson",
        data: emptyPolygons(),
      });

      map.addLayer({
        id: "user-radius-fill",
        type: "fill",
        source: "user-radius",
        paint: { "fill-color": "#246bfe", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "user-radius-line",
        type: "line",
        source: "user-radius",
        paint: {
          "line-color": "#246bfe",
          "line-width": 1.5,
          "line-dasharray": [3, 2],
          "line-opacity": 0.65,
        },
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "restaurants",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#e45b4f",
            25,
            "#d63a2f",
            80,
            "#a9231c",
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            18,
            25,
            22,
            80,
            28,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fffdf7",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "restaurants",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "selected-halo",
        type: "circle",
        source: "restaurants",
        filter: ["==", ["get", "slug"], ""],
        paint: {
          "circle-radius": 13,
          "circle-color": "rgba(214,58,47,0.18)",
          "circle-stroke-color": "#d63a2f",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "restaurant-points",
        type: "circle",
        source: "restaurants",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": 6.5,
          "circle-color": "#d63a2f",
          "circle-stroke-color": "#fffdf7",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "user-location-halo",
        type: "circle",
        source: "user-location",
        paint: { "circle-radius": 14, "circle-color": "rgba(36,107,254,0.16)" },
      });
      map.addLayer({
        id: "user-location-point",
        type: "circle",
        source: "user-location",
        paint: {
          "circle-radius": 6,
          "circle-color": "#246bfe",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });

      map.on("click", "clusters", async (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ["clusters"] })[0];
        const clusterId = feature?.properties?.cluster_id;
        const source = map.getSource("restaurants") as GeoJSONSource;
        if (clusterId === undefined) return;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coordinates = (feature.geometry as Point).coordinates as [number, number];
        map.easeTo({ center: coordinates, zoom });
      });
      map.on("click", "restaurant-points", (event) => {
        const slug = event.features?.[0]?.properties?.slug;
        if (slug) onSelectRef.current(slug);
      });
      for (const layer of ["clusters", "restaurant-points"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
      window.setTimeout(() => map.resize(), 0);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Map initialization intentionally happens only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    (map.getSource("restaurants") as GeoJSONSource | undefined)?.setData(geojson);
  }, [geojson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.setFilter("selected-halo", [
      "==",
      ["get", "slug"],
      selected?.slug ?? "",
    ]);
    const lon = selected ? longitudeOf(selected) : null;
    if (selected?.coordinates && lon !== null) {
      map.flyTo({
        center: [lon, selected.coordinates.lat],
        zoom: Math.max(map.getZoom(), 13.2),
        padding: { bottom: 180 },
        duration: 550,
        essential: true,
      });
    }
  }, [selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const locationData: FeatureCollection<Point> = userLocation
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Point",
                coordinates: [userLocation.lon, userLocation.lat],
              },
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };
    (map.getSource("user-location") as GeoJSONSource | undefined)?.setData(locationData);
    (map.getSource("user-radius") as GeoJSONSource | undefined)?.setData(
      userLocation && maxDistance
        ? radiusPolygon(userLocation, maxDistance)
        : emptyPolygons(),
    );
  }, [userLocation, maxDistance]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const frame = window.requestAnimationFrame(() => map.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey]);

  const selectedImage = selected ? imageFor(selected) : null;
  const selectedPrices = selected ? uniquePrices(selected) : [];

  return (
    <section className="map-shell" aria-label="Restaurant map">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-topbar">
        <div className="map-result-count">
          <MapPin size={15} aria-hidden="true" />
          <strong>{restaurants.length}</strong> on map
        </div>
        <div className="map-actions">
          <button type="button" onClick={onRequestLocation} className="map-action-button">
            {userLocation ? <LocateFixed size={16} /> : <Crosshair size={16} />}
            <span>{userLocation ? "Located" : "Near me"}</span>
          </button>
          <button type="button" onClick={fitResults} className="map-action-button">
            <Expand size={16} />
            <span>Fit results</span>
          </button>
        </div>
      </div>

      {selected ? (
        <article className="map-peek-card">
          <button
            type="button"
            className="map-peek-close"
            onClick={() => onSelect(null)}
            aria-label="Close map preview"
          >
            <X size={17} />
          </button>
          {selectedImage ? (
            // The source images are delivered by NYC Tourism's public CDN.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selectedImage} alt="" className="map-peek-image" />
          ) : (
            <div className="map-peek-image map-peek-placeholder" />
          )}
          <div className="map-peek-body">
            <div className="map-peek-kicker">
              {selected.neighborhood}
              {selected.distanceMiles !== undefined ? (
                <span> · {formatDistance(selected.distanceMiles)}</span>
              ) : null}
            </div>
            <div className="map-peek-title-row">
              <h3>{selected.name}</h3>
              <button
                type="button"
                onClick={() => onCopyName(selected.name)}
                aria-label={`Copy ${selected.name}`}
                title="Copy restaurant name"
              >
                <Copy size={14} />
              </button>
            </div>
            <div className="map-peek-meta">
              {selected.cuisines.slice(0, 2).join(" · ")}
              {selectedPrices.length ? (
                <span>{selectedPrices.map((price) => `$${price}`).join(" / ")}</span>
              ) : null}
            </div>
            {selected.healthInspection ? (
              <div className={`map-health-badge ${healthGradeClass(selected.healthInspection.grade)}`}>
                {displayHealthGrade(selected.healthInspection.grade)}
                {selected.healthInspection.score !== null
                  ? ` · ${selected.healthInspection.score} pts`
                  : ""}
              </div>
            ) : null}
            <div className="map-peek-buttons">
              <button type="button" onClick={() => onOpenDetails(selected)}>
                <Menu size={15} /> Details
              </button>
              <button
                type="button"
                className={saved.has(selected.slug) ? "is-saved" : ""}
                onClick={() => onToggleSaved(selected.slug)}
                aria-label={saved.has(selected.slug) ? "Remove saved restaurant" : "Save restaurant"}
              >
                <Heart size={15} fill={saved.has(selected.slug) ? "currentColor" : "none"} />
              </button>
            </div>
          </div>
        </article>
      ) : null}
    </section>
  );
}
