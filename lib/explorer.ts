import type { LocationPoint, Restaurant } from "./types";

export const COLLECTION_LABELS: Record<string, string> = {
  "around-the-boroughs": "Around the boroughs",
  "celebrity-chefs": "Celebrity chefs",
  "classic-restaurants": "NYC classics",
  "date-night": "Date night",
  "dress-for-the-occasion": "Dress up",
  "for-the-foodies": "For foodies",
  "hidden-gems": "Hidden gems",
  "summer-vibes": "Summer vibes",
};

export const BOROUGH_ORDER = [
  "Manhattan",
  "Brooklyn",
  "Queens",
  "The Bronx",
  "Staten Island",
];

export function longitudeOf(restaurant: Restaurant): number | null {
  if (!restaurant.coordinates) return null;
  return restaurant.coordinates.lon ?? restaurant.coordinates.lng ?? null;
}

export function haversineMiles(
  first: LocationPoint,
  second: LocationPoint,
): number {
  const radiusMiles = 3958.8;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = radians(second.lat - first.lat);
  const deltaLon = radians(second.lon - first.lon);
  const lat1 = radians(first.lat);
  const lat2 = radians(second.lat);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusMiles * Math.asin(Math.sqrt(a));
}

export function restaurantDistance(
  restaurant: Restaurant,
  origin: LocationPoint | null,
): number | null {
  const lon = longitudeOf(restaurant);
  if (!origin || !restaurant.coordinates || lon === null) return null;
  return haversineMiles(origin, {
    lat: restaurant.coordinates.lat,
    lon,
  });
}

export function minimumPrice(restaurant: Restaurant): number | null {
  const prices = Object.values(restaurant.mealPrices).flat();
  return prices.length ? Math.min(...prices) : null;
}

export function uniquePrices(restaurant: Restaurant): number[] {
  return [...new Set(Object.values(restaurant.mealPrices).flat())].sort(
    (a, b) => a - b,
  );
}

export function displayMealType(value: string): string {
  return value.replace(/ Price$/, "");
}

export function displayWeek(value: string): string {
  return value.replace(/^Week (\d+) /, "W$1 ");
}

export function displayCollection(value: string): string {
  return COLLECTION_LABELS[value] ?? value.replaceAll("-", " ");
}

export function imageFor(restaurant: Restaurant): string | null {
  return restaurant.images[0]?.url ?? restaurant.gridImage?.url ?? null;
}

export function mealPeriodMatches(
  restaurant: Restaurant,
  period: string,
): boolean {
  const values = restaurant.mealTypes;
  if (period === "weekday-lunch") {
    return values.some((value) => value.includes("Lunch Price"));
  }
  if (period === "weekday-dinner") {
    return values.some(
      (value) => value.includes("Dinner Price") && !value.includes("Sunday"),
    );
  }
  if (period === "sunday-lunch") {
    return values.some((value) => value.includes("Sunday Lunch/Brunch"));
  }
  if (period === "sunday-dinner") {
    return values.some((value) => value.includes("Sunday Dinner"));
  }
  return false;
}

export function searchScore(restaurant: Restaurant, rawQuery: string): number {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return 0;
  const name = restaurant.name.toLocaleLowerCase();
  const neighborhood = restaurant.neighborhood.toLocaleLowerCase();
  const borough = restaurant.borough.toLocaleLowerCase();
  const cuisines = restaurant.cuisines.join(" ").toLocaleLowerCase();
  const summary = `${restaurant.summary ?? ""} ${restaurant.description ?? ""}`.toLocaleLowerCase();
  const menu = restaurant.menu?.text?.toLocaleLowerCase() ?? "";
  let score = 0;
  if (name === query) score += 160;
  if (name.startsWith(query)) score += 100;
  if (name.includes(query)) score += 70;
  if (neighborhood.includes(query)) score += 40;
  if (borough.includes(query)) score += 25;
  if (cuisines.includes(query)) score += 35;
  if (summary.includes(query)) score += 12;
  if (menu.includes(query)) score += 5;
  return score;
}

export function restaurantMatchesSearch(
  restaurant: Restaurant,
  rawQuery: string,
): boolean {
  if (!rawQuery.trim()) return true;
  return searchScore(restaurant, rawQuery) > 0;
}

export function formatDistance(distance: number | null | undefined): string {
  if (distance === null || distance === undefined) return "";
  if (distance < 0.1) return `${Math.round(distance * 5280)} ft`;
  return `${distance.toFixed(distance < 10 ? 1 : 0)} mi`;
}
