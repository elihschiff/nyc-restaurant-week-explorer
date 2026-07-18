export type Coordinates = {
  lat: number;
  lon?: number;
  lng?: number;
};

export type HealthInspectionSummary = {
  date: string | null;
  result: string | null;
  score: number | null;
  violationCount: number;
  criticalViolationCount: number;
};

export type HealthInspection = {
  camis: string;
  grade: string;
  score: number | null;
  inspectionDate: string | null;
  inspectionResult: string | null;
  violationCount: number;
  criticalViolationCount: number;
  violations: Array<{
    description: string;
    critical: boolean;
  }>;
  inspectionHistory: HealthInspectionSummary[];
  officialUrl: string;
  matchedName: string;
  matchedAddress: string;
  matchedAt: string;
};

export type Restaurant = {
  name: string;
  slug: string;
  officialDetailUrl: string;
  borough: string;
  neighborhood: string;
  summary: string | null;
  description: string | null;
  website: string | null;
  phone: string | null;
  address: {
    raw: string;
    street?: string;
    locality?: string;
    state?: string;
    postal_code?: string;
  } | null;
  coordinates: Coordinates | null;
  cuisines: string[];
  accessibility: string[];
  dietaryNeeds: string[];
  amenities: string[];
  costCategories: string[];
  mealTypes: string[];
  mealPrices: Record<string, number[]>;
  weeksParticipating: string[];
  collections: string[];
  menu: {
    url: string | null;
    text: string | null;
    pages: number | null;
    extractionMethod: string | null;
  } | null;
  reservation: {
    partner: string | null;
    partner_id: string | null;
  } | null;
  gridImage: {
    url: string | null;
    alt: string | null;
  } | null;
  images: Array<{
    url: string;
    alt: string | null;
    credit: string | null;
  }>;
  social: Record<string, string>;
  detailSourceError: boolean;
  healthInspection?: HealthInspection;
  distanceMiles?: number;
};

export type RestaurantDataset = {
  generatedAt: string;
  event: {
    name: string;
    official_program_start: string;
    official_program_end: string;
    official_landing_page: string;
  };
  stats: {
    restaurants: number;
    mappedRestaurants: number;
    restaurantsWithMenus: number;
    boroughs: Record<string, number>;
    healthInspectionsMatched?: number;
    healthGrades?: Record<string, number>;
  };
  healthInspectionsUpdatedAt?: string;
  restaurants: Restaurant[];
};

export type LocationPoint = {
  lat: number;
  lon: number;
};

export type ViewMode = "split" | "list" | "map";

export type SortMode =
  | "best-match"
  | "name"
  | "distance"
  | "price"
  | "offers"
  | "weeks"
  | "neighborhood"
  | "health-grade"
  | "health-score";

export type FilterState = {
  boroughs: string[];
  neighborhoods: string[];
  cuisines: string[];
  prices: string[];
  mealPeriods: string[];
  weeks: string[];
  collections: string[];
  accessibility: string[];
  dietaryNeeds: string[];
  amenities: string[];
  healthGrades: string[];
  hasMenu: boolean;
  hasReservation: boolean;
  savedOnly: boolean;
  maxDistance: number | null;
};

export const EMPTY_FILTERS: FilterState = {
  boroughs: [],
  neighborhoods: [],
  cuisines: [],
  prices: [],
  mealPeriods: [],
  weeks: [],
  collections: [],
  accessibility: [],
  dietaryNeeds: [],
  amenities: [],
  healthGrades: [],
  hasMenu: false,
  hasReservation: false,
  savedOnly: false,
  maxDistance: null,
};
