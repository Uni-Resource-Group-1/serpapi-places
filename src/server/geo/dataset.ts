import { readFileSync } from "node:fs";
import type { Coordinates } from "../../shared/types.js";

export interface GeoCountry {
  code: string;
  name: string;
}

export interface GeoRegion {
  code: string;
  name: string;
  countryCode: string;
  center: Coordinates | null;
}

export interface GeoCounty {
  code: string;
  name: string;
  regionCode: string;
  countryCode: string;
  center: Coordinates | null;
}

export interface GeoCity {
  id: number;
  name: string;
  regionCode: string;
  countyCode: string | null;
  countryCode: string;
  center: Coordinates;
  population: number;
}

type RawCountry = { code: string; name: string };
type RawRegion = [name: string, lat: number | null, lon: number | null];
type RawCounty = [name: string, regionCode: string, lat: number | null, lon: number | null];
type RawCity = { id: number; name: string; lat: number; lon: number; population: number };

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8")) as T;
}

function center(lat: number | null | undefined, lon: number | null | undefined): Coordinates | null {
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
}

const rawCountries = loadJson<RawCountry[]>("countries.json");
const rawRegions = loadJson<Record<string, RawRegion>>("regions.json");
const rawCounties = loadJson<Record<string, RawCounty>>("counties.json");
const rawCities = loadJson<Record<string, RawCity[]>>("cities.json");
export const COUNTRIES: GeoCountry[] = rawCountries.map(({ code, name }) => ({ code, name }));

export const REGIONS: GeoRegion[] = Object.entries(rawRegions).map(([code, [name, lat, lon]]) => ({
  code,
  name,
  countryCode: code.split(".")[0] ?? "",
  center: center(lat, lon),
}));

export const COUNTIES: GeoCounty[] = Object.entries(rawCounties).map(([code, [name, regionCode, lat, lon]]) => ({
  code,
  name,
  regionCode,
  countryCode: regionCode.split(".")[0] ?? "",
  center: center(lat, lon),
}));

const regionIndex = new Map(REGIONS.map((region) => [region.code, region]));
const countyIndex = new Map(COUNTIES.map((county) => [county.code, county]));

const regionsByCountry = new Map<string, GeoRegion[]>();
for (const region of REGIONS) {
  const list = regionsByCountry.get(region.countryCode) ?? [];
  list.push(region);
  regionsByCountry.set(region.countryCode, list);
}

const countiesByRegion = new Map<string, GeoCounty[]>();
for (const county of COUNTIES) {
  const list = countiesByRegion.get(county.regionCode) ?? [];
  list.push(county);
  countiesByRegion.set(county.regionCode, list);
}

const citiesByCounty = new Map<string, GeoCity[]>();
const citiesByRegion = new Map<string, GeoCity[]>();
const cityById = new Map<number, GeoCity>();
const countryCenterCandidates = new Map<string, GeoCity>();

for (const [key, rows] of Object.entries(rawCities)) {
  for (const { id, name, lat, lon, population } of rows) {
    const isCountyKey = !key.startsWith("r:");
    const regionCode = isCountyKey ? (countyIndex.get(key)?.regionCode ?? key.split(".").slice(0, 2).join(".")) : key.slice(2);
    const city: GeoCity = {
      id,
      name,
      regionCode,
      countyCode: isCountyKey ? key : null,
      countryCode: regionCode.split(".")[0] ?? "",
      center: { lat, lon },
      population,
    };
    cityById.set(id, city);
    const countryCenterCandidate = countryCenterCandidates.get(city.countryCode);
    if (!countryCenterCandidate || city.population > countryCenterCandidate.population) {
      countryCenterCandidates.set(city.countryCode, city);
    }
    if (city.countyCode) {
      const countyList = citiesByCounty.get(city.countyCode) ?? [];
      countyList.push(city);
      citiesByCounty.set(city.countyCode, countyList);
    }
    const regionList = citiesByRegion.get(city.regionCode) ?? [];
    regionList.push(city);
    citiesByRegion.set(city.regionCode, regionList);
  }
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function countries(): GeoCountry[] {
  return COUNTRIES;
}

export function countryCenterFor(code: string): Coordinates | null {
  return countryCenterCandidates.get(code.toUpperCase())?.center ?? null;
}

export function regionsForCountry(countryCode: string): GeoRegion[] {
  return sortByName([...(regionsByCountry.get(countryCode.toUpperCase()) ?? [])]);
}

export function countiesForRegion(regionCode: string): GeoCounty[] {
  return sortByName([...(countiesByRegion.get(regionCode) ?? [])]);
}

export function citiesForCounty(countyCode: string): GeoCity[] {
  return [...(citiesByCounty.get(countyCode) ?? [])];
}

export function citiesForRegion(regionCode: string): GeoCity[] {
  return [...(citiesByRegion.get(regionCode) ?? [])];
}

export function regionByCode(code: string): GeoRegion | undefined {
  return regionIndex.get(code);
}

export function countyByCodeLookup(code: string): GeoCounty | undefined {
  return countyIndex.get(code);
}

export function cityByIdLookup(id: number): GeoCity | undefined {
  return cityById.get(id);
}

export const DATASET_ATTRIBUTION =
  "Place names and coordinates derived from GeoNames (https://www.geonames.org/), licensed CC BY 4.0.";
