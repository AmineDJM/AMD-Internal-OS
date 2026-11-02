/**
 * REFONTE R3 — INVENTAIRE DES LIEUX SAISIS À LA MAIN, en lecture seule.
 *
 * Pour chaque colonne libre qui porte un lieu (`wilaya`, `city`, `region`, `ville`…), la distribution des valeurs
 * et le taux de reconnaissance par `src/modules/lieux/domaine/normaliser.ts` : ce qu'on rattacherait d'office à une wilaya, ce
 * qui resterait à trancher, et pourquoi. Rien n'est écrit — on mesure avant de migrer.
 *
 *   DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_internal_os npx tsx scripts/refonte/inventaire-lieux.ts [--json] [--top 15]
 */
import { prisma } from "../../src/lib/prisma";
import { normaliserWilaya, type RaisonRejet } from "../../src/modules/lieux/partage";

/** Les colonnes inventoriées — identifiants constants (jamais une saisie), seuls interpolés dans le SQL. */
const COLONNES: { table: string; colonne: string; tableau?: true }[] = [
  { table: "MedicalDoctor", colonne: "wilaya" },
  { table: "MedicalDoctor", colonne: "city" },
  { table: "MedicalDoctor", colonne: "region" },
  { table: "MedicalInstitution", colonne: "wilaya" },
  { table: "MedicalInstitution", colonne: "city" },
  { table: "MedicalInstitution", colonne: "region" },
  { table: "CompanyContact", colonne: "wilaya" },
  { table: "CompanyContact", colonne: "city" },
  { table: "Supplier", colonne: "city" },
  { table: "SponsoringRequest", colonne: "city" },
  { table: "StockCountRequestHospital", colonne: "wilaya" },
  { table: "SalesSector", colonne: "city" },
  { table: "SalesSector", colonne: "wilayaPivot" },
  { table: "CareCell", colonne: "city" },
  { table: "Event", colonne: "city" },
  { table: "EventRegistration", colonne: "city" },
  { table: "CongressNational", colonne: "city" },
  { table: "MedicalVisit", colonne: "region" },
  { table: "MedicalDelegatePlan", colonne: "region" },
  { table: "SalesRepProfile", colonne: "region" },
  { table: "User", colonne: "region" },
  { table: "AdProHebergement", colonne: "ville" },
  { table: "MissionAssignment", colonne: "ville" },
  { table: "PchDirectionRegionale", colonne: "wilayas", tableau: true },
];

interface Ligne {
  table: string;
  colonne: string;
  lignes: number;
  distinctes: number;
  reconnues: number;
  taux: number | null;
  raisons: Partial<Record<RaisonRejet, number>>;
  top: { valeur: string; n: number; code: string | null; raison?: RaisonRejet }[];
  nonReconnues: { valeur: string; n: number; raison: RaisonRejet }[];
  erreur?: string;
}

function argument(nom: string): string | undefined {
  const i = process.argv.indexOf(nom);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function inventorier(table: string, colonne: string, tableau: boolean, top: number): Promise<Ligne> {
  const ligne: Ligne = { table, colonne, lignes: 0, distinctes: 0, reconnues: 0, taux: null, raisons: {}, top: [], nonReconnues: [] };
  const valeur = tableau ? `unnest("${colonne}")` : `"${colonne}"`;
  let rangs: { v: string; n: number }[];
  try {
    rangs = await prisma.$queryRawUnsafe<{ v: string; n: number }[]>(
      `SELECT v, count(*)::int AS n FROM (SELECT ${valeur} AS v FROM "${table}") s
       WHERE v IS NOT NULL AND btrim(v) <> '' GROUP BY v ORDER BY n DESC, v`,
    );
  } catch (e) {
    ligne.erreur = e instanceof Error ? e.message.split("\n").pop() : String(e);
    return ligne;
  }
  for (const { v, n } of rangs) {
    const r = normaliserWilaya(v);
    ligne.lignes += n;
    ligne.distinctes += 1;
    if (r.code !== null) ligne.reconnues += n;
    else {
      ligne.raisons[r.raison] = (ligne.raisons[r.raison] ?? 0) + n;
      if (ligne.nonReconnues.length < top) ligne.nonReconnues.push({ valeur: v, n, raison: r.raison });
    }
    if (ligne.top.length < top) ligne.top.push({ valeur: v, n, code: r.code, ...(r.code === null ? { raison: r.raison } : {}) });
  }
  ligne.taux = ligne.lignes ? Math.round((ligne.reconnues / ligne.lignes) * 1000) / 10 : null;
  return ligne;
}

async function main() {
  const top = Number(argument("--top") ?? 15);
  const resultats: Ligne[] = [];
  for (const c of COLONNES) resultats.push(await inventorier(c.table, c.colonne, c.tableau === true, top));

  const wilayas = await prisma.$queryRawUnsafe<{ n: number; actives: number }[]>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE active)::int AS actives FROM "Wilaya"`,
  ).catch(() => null);

  if (process.argv.includes("--json")) {
    console.info(JSON.stringify({ referentiel: wilayas?.[0] ?? null, colonnes: resultats }, null, 2));
    return;
  }

  console.info(`[LIEUX] Référentiel : ${wilayas ? `${wilayas[0].n} wilayas (${wilayas[0].actives} en fonction)` : "table Wilaya absente"}`);
  let total = 0;
  let reconnues = 0;
  for (const l of resultats) {
    const tete = `${l.table}.${l.colonne}`.padEnd(38);
    if (l.erreur) { console.info(`${tete} ERREUR ${l.erreur}`); continue; }
    total += l.lignes;
    reconnues += l.reconnues;
    const raisons = Object.entries(l.raisons).map(([r, n]) => `${r}=${n}`).join(" ");
    console.info(`${tete} ${String(l.lignes).padStart(7)} lignes  ${String(l.distinctes).padStart(5)} valeurs  ${l.taux === null ? "   —  " : `${l.taux.toFixed(1).padStart(5)} %`}  ${raisons}`);
    for (const t of l.nonReconnues) console.info(`    ✗ ${JSON.stringify(t.valeur)} ×${t.n} (${t.raison})`);
  }
  console.info(`[LIEUX] Total : ${total} valeurs renseignées, ${reconnues} reconnues${total ? ` (${((reconnues / total) * 100).toFixed(1)} %)` : ""}.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
