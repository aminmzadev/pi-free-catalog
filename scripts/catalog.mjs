import { Catalog, atomicJSON } from "../src/catalog.js";
import { report } from "../src/models.js";
const catalog = new Catalog();
await catalog.refresh();
const target = process.argv[2];
if (target) {
  await atomicJSON(target, catalog.state);
  console.log(`Full evidence saved to ${target}`);
}
console.log(report(catalog.state));
if (Object.values(catalog.state.sources).some((s) => !s.fresh))
  process.exitCode = 1;
