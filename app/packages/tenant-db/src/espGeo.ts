// ESP alignment, phase 8 (census): the census geography each address sits in, for CRA and fair-lending
// work, and a latitude and longitude for each person.
// - cen_vintage, cen_geography_type, cen_state, cen_county, cen_tract, cen_block_group, cen_block,
//   cen_zcta: the 2020 census geography over the demo's market. The demo's towns are fictional, so are its
//   counties, tracts and blocks; the state codes are the real FIPS codes. Each tract carries the FFIEC
//   income level CRA uses (its median family income against the area's), its minority share, population
//   and households.
// - cen_address_map: where each person's address geocodes to: tract, block group, block, ZCTA, latitude and
//   longitude. A few match only to their ZIP's centre, and a few don't match.
import { unit } from './generate.ts';

export const ESP_GEO_DDL = [
  `CREATE TABLE cen_vintage (vintage_id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, year SMALLINT NOT NULL, is_newest TINYINT NOT NULL)`,
  `CREATE TABLE cen_geography_type (type_id INT PRIMARY KEY, code VARCHAR(12) NOT NULL, name VARCHAR(40) NOT NULL, geoid_length TINYINT NOT NULL)`,
  `CREATE TABLE cen_state (geoid CHAR(2) PRIMARY KEY, name VARCHAR(40) NOT NULL, code CHAR(2) NOT NULL, vintage_id INT NOT NULL)`,
  `CREATE TABLE cen_county (geoid CHAR(5) PRIMARY KEY, state CHAR(2) NOT NULL, name VARCHAR(60) NOT NULL, vintage_id INT NOT NULL, msa_median_family_income DECIMAL(10,0) NOT NULL)`,
  `CREATE TABLE cen_tract (
     geoid CHAR(11) PRIMARY KEY,
     county CHAR(5) NOT NULL,
     tract CHAR(6) NOT NULL,
     name VARCHAR(40) NOT NULL,
     vintage_id INT NOT NULL,
     income_level VARCHAR(10) NOT NULL,
     median_family_income_pct DECIMAL(6,1) NOT NULL,
     minority_pct DECIMAL(5,1) NOT NULL,
     population INT NOT NULL,
     households INT NOT NULL,
     owner_occupied_units INT NOT NULL,
     centroid_latitude DECIMAL(9,6) NOT NULL,
     centroid_longitude DECIMAL(10,6) NOT NULL,
     KEY ix_tract_level (income_level)
   )`,
  `CREATE TABLE cen_block_group (geoid CHAR(12) PRIMARY KEY, tract CHAR(11) NOT NULL, block_group CHAR(1) NOT NULL, vintage_id INT NOT NULL, population INT NOT NULL, centroid_latitude DECIMAL(9,6) NOT NULL, centroid_longitude DECIMAL(10,6) NOT NULL)`,
  `CREATE TABLE cen_block (geoid CHAR(15) PRIMARY KEY, block_group CHAR(12) NOT NULL, block CHAR(4) NOT NULL, vintage_id INT NOT NULL)`,
  `CREATE TABLE cen_zcta (zcta CHAR(5) PRIMARY KEY, name VARCHAR(40) NOT NULL, vintage_id INT NOT NULL, centroid_latitude DECIMAL(9,6) NOT NULL, centroid_longitude DECIMAL(10,6) NOT NULL)`,
  `CREATE TABLE cen_address_map (
     party_id INT PRIMARY KEY,
     status VARCHAR(16) NOT NULL,
     vintage_id INT NOT NULL,
     state CHAR(2) NULL,
     county CHAR(5) NULL,
     tract CHAR(11) NULL,
     block_group CHAR(12) NULL,
     block CHAR(15) NULL,
     zcta CHAR(5) NULL,
     latitude DECIMAL(9,6) NULL,
     longitude DECIMAL(10,6) NULL,
     KEY ix_addr_tract (tract)
   )`,
];

export const ESP_GEO_COLUMNS = {
  cen_vintage: ['vintage_id', 'name', 'year', 'is_newest'],
  cen_geography_type: ['type_id', 'code', 'name', 'geoid_length'],
  cen_state: ['geoid', 'name', 'code', 'vintage_id'],
  cen_county: ['geoid', 'state', 'name', 'vintage_id', 'msa_median_family_income'],
  cen_tract: ['geoid', 'county', 'tract', 'name', 'vintage_id', 'income_level', 'median_family_income_pct', 'minority_pct', 'population', 'households', 'owner_occupied_units', 'centroid_latitude', 'centroid_longitude'],
  cen_block_group: ['geoid', 'tract', 'block_group', 'vintage_id', 'population', 'centroid_latitude', 'centroid_longitude'],
  cen_block: ['geoid', 'block_group', 'block', 'vintage_id'],
  cen_zcta: ['zcta', 'name', 'vintage_id', 'centroid_latitude', 'centroid_longitude'],
  cen_address_map: ['party_id', 'status', 'vintage_id', 'state', 'county', 'tract', 'block_group', 'block', 'zcta', 'latitude', 'longitude'],
} as const;

const STATES: Record<string, { fips: string; name: string; lat: number; lng: number }> = {
  OR: { fips: '41', name: 'Oregon', lat: 44.94, lng: -123.03 },
  WA: { fips: '53', name: 'Washington', lat: 47.04, lng: -122.9 },
  NY: { fips: '36', name: 'New York', lat: 42.65, lng: -73.75 },
};
/** FFIEC income levels: a tract's median family income against its area's. */
export const incomeLevel = (pct: number) => (pct < 50 ? 'Low' : pct < 80 ? 'Moderate' : pct < 120 ? 'Middle' : 'Upper');
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The geography over the demo's market, from the people's addresses: two or three counties of the towns,
 * tracts in each ZIP sized to the people there, and each address geocoded.
 */
export function generateGeography(addresses: unknown[][]) {
  const state = String(addresses[0]?.[4] ?? 'OR');
  const st = STATES[state] ?? STATES.OR!;
  const byZip = new Map<string, { city: string; people: number[] }>();
  for (const a of addresses) {
    const zip = String(a[5]);
    const z = byZip.get(zip) ?? byZip.set(zip, { city: String(a[3]), people: [] }).get(zip)!;
    z.people.push(Number(a[0]));
  }
  const zips = [...byZip.keys()].sort();
  const cities = [...new Set(zips.map((z) => byZip.get(z)!.city))].sort();
  // Two or three counties, each named for its largest town.
  const countyCount = cities.length >= 8 ? 3 : 2;
  const countyOfCity = new Map(cities.map((c, i) => [c, i % countyCount]));
  const counties = Array.from({ length: countyCount }, (_, i) => {
    const town = cities.filter((c) => countyOfCity.get(c) === i)[0]!;
    return [`${st.fips}${String(1 + i * 2).padStart(3, '0')}`, st.fips, `${town.split(' ')[0]} County`, 1, 82_000 + i * 4_000];
  });
  const tracts: unknown[][] = [];
  const blockGroups: unknown[][] = [];
  const blocks: unknown[][] = [];
  const zctas: unknown[][] = [];
  const map: unknown[][] = [];
  zips.forEach((zip, zi) => {
    const z = byZip.get(zip)!;
    const county = counties[countyOfCity.get(z.city)!]![0] as string;
    const lat = st.lat + (unit(zi, 9001) - 0.5) * 0.5;
    const lng = st.lng + (unit(zi, 9002) - 0.5) * 0.6;
    zctas.push([zip, `ZCTA5 ${zip}`, 1, r6(lat), r6(lng)]);
    // A tract for about every 900 people on file; real tracts hold about 4,000 residents.
    const n = Math.max(2, Math.round(z.people.length / 900));
    const ids: string[] = [];
    for (let t = 0; t < n; t++) {
      const code = String(100 + zi * 100 + t * 2).padStart(4, '0') + '00';
      const geoid = `${county}${code}`;
      ids.push(geoid);
      // Income: most tracts middle; about a quarter low or moderate, the older town centres more so.
      const u = unit(zi * 50 + t, 9003);
      const pct = Math.round((u < 0.07 ? 38 + u * 150 : u < 0.27 ? 55 + (u - 0.07) * 120 : u < 0.75 ? 82 + (u - 0.27) * 75 : 121 + (u - 0.75) * 160) * 10) / 10;
      const tl = lat + (unit(zi * 50 + t, 9004) - 0.5) * 0.06;
      const tg = lng + (unit(zi * 50 + t, 9005) - 0.5) * 0.08;
      const pop = 2600 + Math.floor(unit(zi * 50 + t, 9006) * 3800);
      const hh = Math.round(pop / (2.2 + unit(zi * 50 + t, 9007) * 0.7));
      const owner = Math.round(hh * (pct < 80 ? 0.35 + unit(zi * 50 + t, 9008) * 0.2 : 0.55 + unit(zi * 50 + t, 9008) * 0.25));
      const minority = Math.round((pct < 80 ? 30 + unit(zi * 50 + t, 9009) * 35 : 8 + unit(zi * 50 + t, 9009) * 25) * 10) / 10;
      tracts.push([geoid, county, code, `Census Tract ${Number(code) / 100}`, 1, incomeLevel(pct), pct, minority, pop, hh, owner, r6(tl), r6(tg)]);
      for (let g = 1; g <= 3; g++) {
        const bg = `${geoid}${g}`;
        blockGroups.push([bg, geoid, String(g), 1, Math.round(pop / 3), r6(tl + (g - 2) * 0.004), r6(tg + (g - 2) * 0.005)]);
        for (let b = 0; b < 4; b++) blocks.push([`${bg}${String(g * 1000 + b + 1).slice(-3).padStart(3, '0')}`, bg, `${g}${String(b + 1).padStart(3, '0')}`, 1]);
      }
    }
    // Each address: a tract in its ZIP, a block group and block in it, and a point near the tract's centre.
    for (const id of z.people) {
      const u = unit(id, 9010);
      if (u < 0.005) {
        map.push([id, 'No match', 1, null, null, null, null, null, zip, null, null]);
        continue;
      }
      if (u < 0.03) {
        map.push([id, 'ZIP only', 1, st.fips, county, null, null, null, zip, r6(lat), r6(lng)]);
        continue;
      }
      const tract = ids[Math.floor(unit(id, 9011) * ids.length)]!;
      const t = tracts.find((x) => x[0] === tract)!;
      const g = 1 + Math.floor(unit(id, 9012) * 3);
      const b = Math.floor(unit(id, 9013) * 4);
      const bg = `${tract}${g}`;
      map.push([id, 'Matched', 1, st.fips, county, tract, bg, `${bg}${String(g * 1000 + b + 1).slice(-3).padStart(3, '0')}`, zip, r6(Number(t[11]) + (unit(id, 9014) - 0.5) * 0.02), r6(Number(t[12]) + (unit(id, 9015) - 0.5) * 0.025)]);
    }
  });
  return {
    vintages: [[1, '2020 Census', 2020, 1]],
    types: [
      [1, 'state', 'State', 2],
      [2, 'county', 'County', 5],
      [3, 'tract', 'Census tract', 11],
      [4, 'block_group', 'Block group', 12],
      [5, 'block', 'Block', 15],
      [6, 'zcta', 'ZIP Code Tabulation Area', 5],
    ],
    states: [[st.fips, st.name, state, 1]],
    counties,
    tracts,
    blockGroups,
    blocks,
    zctas,
    map,
  };
}
