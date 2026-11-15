import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { AppError } from "../errors.js";
import {
  DATASET_ATTRIBUTION,
  citiesForCounty,
  citiesForRegion,
  countries,
  countryCenterFor,
  countiesForRegion,
  countyByCodeLookup,
  regionByCode,
  regionsForCountry,
} from "../geo/dataset.js";

const countryQuery = z.object({ country: z.string().trim().length(2) });
const regionQuery = z.object({ region: z.string().trim().min(3).max(20) });
const countyQuery = z.object({ county: z.string().trim().min(5).max(30) });

function parseQuery<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, "invalid_query", "Invalid geography request.");
  return parsed.data;
}

export async function registerGeoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/geo/countries", { preHandler: authenticate }, async () => ({
    countries: countries().map((country) => ({
      code: country.code,
      name: country.name,
      center: countryCenterFor(country.code),
    })),
    attribution: DATASET_ATTRIBUTION,
  }));

  app.get("/api/geo/regions", { preHandler: authenticate }, async (request) => {
    const { country } = parseQuery(countryQuery, request.query);
    return {
      regions: regionsForCountry(country).map((region) => ({
        code: region.code,
        name: region.name,
        countryCode: region.countryCode,
        center: region.center,
      })),
      attribution: DATASET_ATTRIBUTION,
    };
  });

  app.get("/api/geo/counties", { preHandler: authenticate }, async (request) => {
    const { region } = parseQuery(regionQuery, request.query);
    const parent = regionByCode(region);
    if (!parent) throw new AppError(404, "not_found", "Unknown region.");
    return {
      counties: countiesForRegion(region).map((county) => ({
        code: county.code,
        name: county.name,
        regionCode: county.regionCode,
        countryCode: county.countryCode,
        center: county.center,
      })),
      attribution: DATASET_ATTRIBUTION,
    };
  });

  app.get("/api/geo/cities", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    let list;
    let parentCode: string;
    if (typeof query.county === "string") {
      const { county } = parseQuery(countyQuery, request.query);
      const parent = countyByCodeLookup(county);
      if (!parent) throw new AppError(404, "not_found", "Unknown county.");
      parentCode = county;
      list = citiesForCounty(county);
    } else {
      const { region } = parseQuery(regionQuery, request.query);
      const parent = regionByCode(region);
      if (!parent) throw new AppError(404, "not_found", "Unknown region.");
      parentCode = region;
      list = citiesForRegion(region);
    }
    return {
      parent: parentCode,
      cities: list.map((city) => ({
        id: city.id,
        name: city.name,
        countyCode: city.countyCode,
        regionCode: city.regionCode,
        center: city.center,
        population: city.population,
      })),
      attribution: DATASET_ATTRIBUTION,
    };
  });
}
