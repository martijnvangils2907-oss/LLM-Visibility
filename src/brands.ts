import type { Brand, BrandRow } from "./types.ts";

export function parseBrand(row: BrandRow): Brand {
  return {
    id: row.id,
    label: row.label,
    isSelf: row.is_self === 1,
    color: row.color,
    sortOrder: row.sort_order,
    aliases: JSON.parse(row.aliases),
  };
}

export async function loadBrands(db: D1Database): Promise<Brand[]> {
  const { results } = await db
    .prepare("SELECT id,label,is_self,aliases,color,sort_order FROM brands WHERE active = 1 ORDER BY sort_order")
    .all<BrandRow>();
  return results.map(parseBrand);
}

export interface BrandHit {
  brandId: string;
  firstIndex: number;
  hits: number;
  rank: number;
}

/**
 * Locate every tracked brand in an answer.
 *
 * Aliases are matched on word boundaries so "SAP" does not fire inside
 * "SAP-like" prose fragments such as "disappear", and case-sensitive aliases
 * (the bare acronyms SAP and OMP) avoid matching lowercase English words.
 * Rank is the order in which brands are first named, which is what actually
 * moves a buyer: being named third in a list is measurably weaker than first.
 */
export function detectBrands(answer: string, brands: Brand[]): BrandHit[] {
  const found: Omit<BrandHit, "rank">[] = [];

  for (const brand of brands) {
    let firstIndex = Infinity;
    let hits = 0;

    for (const alias of brand.aliases) {
      const flags = alias.caseSensitive ? "g" : "gi";
      let re: RegExp;
      try {
        re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alias.pattern})(?![\\p{L}\\p{N}])`, flags + "u");
      } catch {
        continue; // a malformed alias must not take down the whole sweep
      }
      for (const m of answer.matchAll(re)) {
        hits++;
        if (m.index !== undefined && m.index < firstIndex) firstIndex = m.index;
      }
    }

    if (hits > 0) found.push({ brandId: brand.id, firstIndex, hits });
  }

  found.sort((a, b) => a.firstIndex - b.firstIndex);
  return found.map((f, i) => ({ ...f, rank: i + 1 }));
}
