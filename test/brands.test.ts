import { detectBrands } from "../src/brands.ts";
import type { Brand } from "../src/types.ts";

const brands: Brand[] = [
  { id: "icron", label: "ICRON", isSelf: true, color: "", sortOrder: 0,
    aliases: [{ pattern: "ICRON" }, { pattern: "icrontech" }] },
  { id: "kinaxis", label: "Kinaxis", isSelf: false, color: "", sortOrder: 10,
    aliases: [{ pattern: "Kinaxis" }, { pattern: "RapidResponse" }, { pattern: "Rapid Response" }] },
  { id: "blueyonder", label: "Blue Yonder", isSelf: false, color: "", sortOrder: 20,
    aliases: [{ pattern: "Blue ?Yonder" }, { pattern: "JDA Software" }, { pattern: "Luminate" }] },
  { id: "omp", label: "OMP", isSelf: false, color: "", sortOrder: 30,
    aliases: [{ pattern: "OMP", caseSensitive: true }, { pattern: "Unison Planning" }] },
  { id: "sap", label: "SAP", isSelf: false, color: "", sortOrder: 40,
    aliases: [{ pattern: "SAP", caseSensitive: true }] },
];

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`); failed++; }
  else console.log(`  ok   ${name}`);
};
const ranks = (text: string) =>
  Object.fromEntries(detectBrands(text, brands).map((h) => [h.brandId, h.rank]));

console.log("Ranking by first appearance");
check("orders by first mention",
  ranks("For this, Kinaxis and Blue Yonder lead, though SAP IBP is common. ICRON is a niche option."),
  { kinaxis: 1, blueyonder: 2, sap: 3, icron: 4 });

check("later repeat does not change rank",
  ranks("ICRON is strong here. Kinaxis and ICRON both handle it. ICRON again."),
  { icron: 1, kinaxis: 2 });

console.log("\nWord boundaries -- the false-positive traps");
check("'SAP' does not fire inside 'disappear'", ranks("Constraints disappear once modelled."), {});
check("lowercase 'sap' (Dutch/German prose) does not fire", ranks("De sap-productie in de fabriek."), {});
check("'omp' inside 'competitors' does not fire", ranks("Compare the competitors and complete the list."), {});
check("'SAP APO' counts as SAP", ranks("Migrating from SAP APO to a modern platform."), { sap: 1 });
check("'SAP-Systeme' (German hyphenation) still counts", ranks("Die SAP-Systeme sind verbreitet."), { sap: 1 });

console.log("\nAliases");
check("RapidResponse maps to Kinaxis", ranks("Kinaxis RapidResponse is the platform."), { kinaxis: 1 });
check("'Blue Yonder' and 'BlueYonder' both map", ranks("BlueYonder, formerly JDA Software."), { blueyonder: 1 });
check("Luminate maps to Blue Yonder", ranks("The Luminate platform covers this."), { blueyonder: 1 });
check("icrontech.com maps to ICRON", ranks("See icrontech.com for details."), { icron: 1 });
check("lowercase 'icron' still matches", ranks("The vendor icron is Dutch."), { icron: 1 });

console.log("\nHit counting");
const hits = detectBrands("ICRON and ICRON and Kinaxis.", brands);
check("counts repeats", hits.find((h) => h.brandId === "icron")?.hits, 2);

console.log("\nRobustness");
check("empty answer yields nothing", ranks(""), {});
const bad: Brand[] = [{ id: "bad", label: "Bad", isSelf: false, color: "", sortOrder: 0,
  aliases: [{ pattern: "([unclosed" }] }];
check("malformed alias is skipped, not thrown", detectBrands("anything", bad).length, 0);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
