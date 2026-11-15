#!/usr/bin/env node
/**
 * Builds the bundled global geography dataset from GeoNames public data.
 *
 * Inputs (downloaded on demand into .cache/geonames):
 *   countryInfo.txt, admin1CodesASCII.txt, admin2Codes.txt, cities1000.zip
 *
 * Outputs (src/server/geo/data):
 *   countries.json  [code, name][]
 *   regions.json    { "BD.81": [name, lat, lon] }
 *   counties.json   { "BD.81.3039": [name, regionCode, lat, lon] }
 *   cities.json     { "BD.81.3039": [[geonameid, name, lat, lon, population]], "r:BD.81": [...] }
 *
 * GeoNames data is licensed CC BY 4.0 (https://www.geonames.org/).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache", "geonames");
const outDir = join(root, "src", "server", "geo", "data");
const base = "https://download.geonames.org/export/dump";

mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

async function download(name) {
  const target = join(cacheDir, name);
  if (existsSync(target) && statSync(target).size > 0) return target;
  const response = await fetch(`${base}/${name}`);
  if (!response.ok || !response.body) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
  return target;
}

function readLines(path) {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

console.log("Downloading GeoNames inputs…");
await download("countryInfo.txt");
await download("admin1CodesASCII.txt");
await download("admin2Codes.txt");
const citiesZip = await download("cities1000.zip");
execFileSync("unzip", ["-oq", citiesZip, "-d", cacheDir]);
console.log("Reading inputs…");

const countryRows = readLines(join(cacheDir, "countryInfo.txt")).filter((line) => !line.startsWith("#"));
const countries = countryRows
  .map((line) => {
    const fields = line.split("\t");
    return { code: fields[0], name: fields[4] };
  })
  .filter((row) => row.code && row.name)
  .sort((a, b) => a.name.localeCompare(b.name));

const regions = readLines(join(cacheDir, "admin1CodesASCII.txt")).map((line) => {
  const f = line.split("\t");
  return { code: f[0], name: f[1], geonameId: f[3], countryCode: f[0].split(".")[0] };
});

const counties = readLines(join(cacheDir, "admin2Codes.txt")).map((line) => {
  const f = line.split("\t");
  const parts = f[0].split(".");
  return { code: f[0], name: f[1], geonameId: f[3], regionCode: `${parts[0]}.${parts[1]}` };
});

// City fields: 0 id, 1 name, 4 lat, 5 lon, 8 country, 10 admin1, 11 admin2, 14 population.
const cityRows = readLines(join(cacheDir, "cities1000.txt")).map((line) => {
  const f = line.split("\t");
  const countyCode = f[11] ? `${f[8]}.${f[10]}.${f[11]}` : null;
  return {
    id: Number(f[0]),
    name: f[1],
    lat: Number(f[4]),
    lon: Number(f[5]),
    population: Number(f[14]) || 0,
    countryCode: f[8],
    regionCode: `${f[8]}.${f[10]}`,
    countyCode,
  };
});

const countyCodes = new Set(counties.map((county) => county.code));
const regionCodes = new Set(regions.map((region) => region.code));

const largestCity = new Map();
for (const city of cityRows) {
  for (const key of [city.countyCode, city.regionCode, city.countryCode]) {
    if (!key) continue;
    const current = largestCity.get(key);
    if (!current || city.population > current.population) largestCity.set(key, city);
  }
}

const regionOut = {};
for (const region of regions) {
  const city = largestCity.get(region.code);
  regionOut[region.code] = [region.name, round(city?.lat), round(city?.lon)];
}

const countyOut = {};
for (const county of counties) {
  const city = largestCity.get(county.code) ?? largestCity.get(county.regionCode);
  countyOut[county.code] = [county.name, county.regionCode, round(city?.lat), round(city?.lon)];
}

const cityOut = {};
for (const city of cityRows) {
  const key = city.countyCode && countyCodes.has(city.countyCode) ? city.countyCode : `r:${city.regionCode}`;
  delete city.countyCode;
  delete city.countryCode;
  delete city.regionCode;
  (cityOut[key] ??= []).push(city);
}
for (const list of Object.values(cityOut)) {
  list.sort((a, b) => b.population - a.population);
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : null;
}

function write(name, value) {
  const path = join(outDir, name);
  const json = JSON.stringify(value);
  writeFileSync(path, json);
  const kb = (Buffer.byteLength(json) / 1024).toFixed(0);
  console.log(`  ${name}: ${kb} KB`);
}

console.log("Writing dataset…");
write("countries.json", countries);
write("regions.json", regionOut);
write("counties.json", countyOut);
write("cities.json", cityOut);

const unmatchedRegions = [...regionCodes].filter((code) => !largestCity.has(code)).length;
console.log(
  `Done: ${countries.length} countries, ${regions.length} regions, ${counties.length} counties, ${cityRows.length} cities (${unmatchedRegions} regions without a listed city).`,
);
