export interface CategoryDefinition {
  id: string;
  label: string;
  serpQuery: string;
  osm: Array<{ key: string; value: string }>;
}

export const CATEGORIES: CategoryDefinition[] = [
  {
    id: "restaurant",
    label: "Restaurants",
    serpQuery: "restaurants",
    osm: [{ key: "amenity", value: "restaurant" }],
  },
  {
    id: "cafe",
    label: "Cafés",
    serpQuery: "cafes",
    osm: [{ key: "amenity", value: "cafe" }],
  },
  {
    id: "bar",
    label: "Bars & pubs",
    serpQuery: "bars and pubs",
    osm: [
      { key: "amenity", value: "bar" },
      { key: "amenity", value: "pub" },
    ],
  },
  {
    id: "bakery",
    label: "Bakeries",
    serpQuery: "bakeries",
    osm: [
      { key: "shop", value: "bakery" },
      { key: "shop", value: "pastry" },
    ],
  },
  {
    id: "fast_food",
    label: "Fast food",
    serpQuery: "fast food",
    osm: [{ key: "amenity", value: "fast_food" }],
  },
  {
    id: "hotel",
    label: "Hotels",
    serpQuery: "hotels",
    osm: [
      { key: "tourism", value: "hotel" },
      { key: "tourism", value: "guest_house" },
    ],
  },
  {
    id: "pharmacy",
    label: "Pharmacies",
    serpQuery: "pharmacies",
    osm: [{ key: "amenity", value: "pharmacy" }],
  },
  {
    id: "hospital",
    label: "Hospitals & clinics",
    serpQuery: "hospitals and clinics",
    osm: [
      { key: "amenity", value: "hospital" },
      { key: "amenity", value: "clinic" },
      { key: "healthcare", value: "clinic" },
    ],
  },
  {
    id: "dentist",
    label: "Dentists",
    serpQuery: "dentists",
    osm: [
      { key: "amenity", value: "dentist" },
      { key: "healthcare", value: "dentist" },
    ],
  },
  {
    id: "school",
    label: "Schools",
    serpQuery: "schools",
    osm: [{ key: "amenity", value: "school" }],
  },
  {
    id: "university",
    label: "Universities",
    serpQuery: "universities",
    osm: [{ key: "amenity", value: "university" }],
  },
  {
    id: "bank",
    label: "Banks & ATMs",
    serpQuery: "banks",
    osm: [
      { key: "amenity", value: "bank" },
      { key: "amenity", value: "atm" },
    ],
  },
  {
    id: "supermarket",
    label: "Supermarkets",
    serpQuery: "supermarkets",
    osm: [
      { key: "shop", value: "supermarket" },
      { key: "shop", value: "convenience" },
    ],
  },
  {
    id: "fuel",
    label: "Fuel stations",
    serpQuery: "fuel stations",
    osm: [{ key: "amenity", value: "fuel" }],
  },
  {
    id: "park",
    label: "Parks",
    serpQuery: "parks",
    osm: [
      { key: "leisure", value: "park" },
      { key: "leisure", value: "garden" },
    ],
  },
  {
    id: "gym",
    label: "Gyms",
    serpQuery: "gyms",
    osm: [{ key: "leisure", value: "fitness_centre" }],
  },
  {
    id: "mosque",
    label: "Mosques",
    serpQuery: "mosques",
    osm: [{ key: "amenity", value: "place_of_worship" }],
  },
  {
    id: "museum",
    label: "Museums",
    serpQuery: "museums",
    osm: [{ key: "tourism", value: "museum" }],
  },
  {
    id: "attraction",
    label: "Attractions",
    serpQuery: "tourist attractions",
    osm: [
      { key: "tourism", value: "attraction" },
      { key: "tourism", value: "viewpoint" },
    ],
  },
  {
    id: "government",
    label: "Government offices",
    serpQuery: "government offices",
    osm: [{ key: "office", value: "government" }],
  },
  {
    id: "post_office",
    label: "Post offices",
    serpQuery: "post offices",
    osm: [{ key: "amenity", value: "post_office" }],
  },
];

export const CATEGORY_ANY = "any";

export function getCategory(id: string): CategoryDefinition | undefined {
  return CATEGORIES.find((category) => category.id === id);
}

export function categoryLabel(id: string): string {
  if (id === CATEGORY_ANY) return "Any category";
  return getCategory(id)?.label ?? id;
}

export function categorySerpQuery(id: string): string {
  return getCategory(id)?.serpQuery ?? id.replaceAll("_", " ");
}
