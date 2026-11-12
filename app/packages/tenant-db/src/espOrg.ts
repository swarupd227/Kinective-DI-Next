// ESP alignment, step 3: the branch and org hierarchy as a parent/child tree (ESP's esp_empsortdata,
// referenced by nearly every table). Built from the branches and their regions, so the tree and the
// flat region column always agree: institution, then each region, then its branches.
export const ESP_ORG_DDL = [
  `CREATE TABLE cdm_org_unit (unit_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, level VARCHAR(20) NOT NULL, parent_id INT NULL, branch_id INT NULL, KEY ix_org_parent (parent_id), UNIQUE KEY ux_org_branch (branch_id))`,
];

/** locations: cdm_location rows [int_id, name, region, opened]. */
export function generateOrg(institution: string, locations: unknown[][]) {
  const units: unknown[][] = [[1, institution, 'Institution', null, null]];
  const regions = [...new Set(locations.map((l) => String(l[2])))].sort();
  regions.forEach((r, i) => units.push([100 + i, r, 'Region', 1, null]));
  for (const l of locations) units.push([1000 + Number(l[0]), String(l[1]), 'Branch', 100 + regions.indexOf(String(l[2])), Number(l[0])]);
  return units;
}
