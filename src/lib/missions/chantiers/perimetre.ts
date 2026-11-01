/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PÉRIMÈTRE D'UN CHANTIER (lot C1, décision 0042) — pur, zéro import.
 *
 * Deux chantiers dont les globs SE RECOUVRENT ne tournent jamais ensemble : le second attend la libération du
 * premier (sérialisation). Le recouvrement se juge de façon CONSERVATRICE : dans le doute, ils se recouvrent —
 * attendre coûte une file, un conflit fonctionnel coûte une production.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe littéral d'un glob, jusqu'au premier joker : « src/lib/missions/** » → « src/lib/missions/ ». */
export function prefixeLitteral(glob: string): string {
  const g = glob.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  const i = g.search(/[*?[{]/);
  return i < 0 ? g : g.slice(0, i);
}

/** Un fichier est-il dans le glob ? `**` traverse les dossiers, `*` non, `?` un caractère. */
export function correspond(glob: string, fichier: string): boolean {
  const g = glob.trim().replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; continue; }
    if (c === "*") { re += "[^/]*"; continue; }
    if (c === "?") { re += "[^/]"; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Un dossier nu (« src/lib/missions » ou « …/ ») couvre tout ce qu'il contient.
  const dossier = !/[*?]/.test(g);
  return new RegExp(`^${re}${dossier ? "(/.*)?" : ""}$`).test(fichier.replace(/^\.\//, "")) || (dossier && g.endsWith("/") && fichier.startsWith(g));
}

/**
 * DEUX GLOBS SE RECOUVRENT-ILS ? Oui si l'un des préfixes littéraux contient l'autre (« src/lib/** » et
 * « src/lib/missions/x.ts »), ou s'ils sont égaux. Deux préfixes disjoints (« src/app/ » et « prisma/ ») : non.
 */
export function globsSeRecouvrent(a: string, b: string): boolean {
  const pa = prefixeLitteral(a);
  const pb = prefixeLitteral(b);
  if (pa === "" || pb === "") return true;
  const contient = (x: string, y: string) => y.startsWith(x) && (x.endsWith("/") || y.length === x.length || y[x.length] === "/" || /[*?]/.test(a + b));
  return contient(pa, pb) || contient(pb, pa);
}

export function perimetresSeRecouvrent(a: readonly string[], b: readonly string[]): { a: string; b: string } | null {
  for (const x of a) for (const y of b) if (globsSeRecouvrent(x, y)) return { a: x, b: y };
  return null;
}

/** Les fichiers touchés HORS du périmètre réservé — un chantier qui déborde ne se déploie pas. */
export function horsPerimetre(fichiers: readonly string[], perimetre: readonly string[]): string[] {
  return fichiers.filter((f) => !perimetre.some((g) => correspond(g, f)));
}
