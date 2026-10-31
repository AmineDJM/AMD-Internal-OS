/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE L'ANALYSE DE DONNÉES (lot K1, décision 0031) — de vraies demandes, le vrai modèle, des chiffres VÉRIFIÉS.
 *
 * Seize demandes d'analyse par le chemin du produit (`jouerTour`), sous le Super Admin du banc (vue globale) : ventes,
 * budgets, demandes Ad & Pro, RH non confidentielle, un Excel joint, un calcul de projection. Pour chacune, les chiffres
 * ATTENDUS sont recalculés ICI, indépendamment (SQL brut sur la base, ou TypeScript sur les lignes semées) ; le banc
 * vérifie que chacun se retrouve dans les blocs « analyse » calculés par le code, et que le MESSAGE du modèle ne porte
 * aucun chiffre que rien ne prouve (la note « À vérifier » du tour). Coût mesuré au journal des appels de modèle.
 *
 * Base LOCALE seulement (`BENCH_DATABASE_URL`, défaut amd_bench) ; les lignes semées portent la marque du banc et sont
 * retirées à la fin. Plafond de coût : 3 $ (arrêt au-delà).
 *
 *   npm run bench:live -- scripts/bench/analyse-k1.ts            # tout
 *   npm run bench:live -- scripts/bench/analyse-k1.ts 3 12        # quelques cas
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { jouerTour } from "@/modules/assistant-ia/api";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

const TAG = "K1BANC";
const PLAFOND_USD = 3;
const SORTIE = path.join(process.cwd(), "bench-out", "k1-analyse.json");

type Bloc = Extract<WorkspaceBlock, { kind: "analyse" }>;
interface Cas { id: number; theme: string; texte: string; attendus: () => Promise<number[]>; tolerance?: number; piece?: boolean }

const n = (v: unknown): number => Number(v);
const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const arrondi = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ───────────────────────────── Le jeu semé (vérité terrain) ─────────────────────────────
const CLIENTS = ["CHU Mustapha", "Clinique El Azhar", "Pharmacie Centrale", "EHS Ben Aknoun"];
const PRODUITS = ["Nivolumab 100 mg", "Augmentin 1 g", "Doliprane 1000"];
const VENTES = Array.from({ length: 36 }, (_, i) => {
  const mois = 1 + (i % 9);
  const quantite = 5 + ((i * 7) % 23);
  const prix = [185_000, 1_250, 320][i % 3];
  return {
    product: PRODUITS[i % 3], client: CLIENTS[(i * 5) % 4], date: new Date(Date.UTC(2026, mois - 1, 3 + (i % 20))),
    quantity: quantite, unitPrice: prix, revenue: quantite * prix, paymentStatus: (["PAID", "UNPAID", "PAID", "PARTIAL"] as const)[i % 4],
  };
});
const POSTES = [["Congrès", 4_800_000], ["Sponsoring", 2_350_000], ["Matériel promotionnel", 1_125_500], ["Événements", 900_000]] as const;
const ADPRO = [
  ["AWAITING_DECISION", 450_000], ["AWAITING_DECISION", 125_000], ["APPROVED", 980_000], ["APPROVED", 60_500], ["REFUSED", 300_000], ["DONE", 1_200_000], ["DONE", 75_000],
] as const;
const EXCEL = Array.from({ length: 24 }, (_, i) => ({
  delegue: ["Fatma Bensaid", "Karim Ait", "Nadia Rahmani", "Walid Ferhat"][i % 4], region: ["Centre", "Est", "Ouest"][i % 3],
  mois: ["Juillet", "Août", "Septembre"][Math.floor(i / 8)], produit: PRODUITS[i % 3], quantite: 3 + ((i * 5) % 17), prix: [9_800, 1_250, 320][i % 3],
}));

async function semer(admin: CurrentUser): Promise<{ pieceId: string; envMarketing: string }> {
  await nettoyer();
  const company = await prisma.company.findFirst({ select: { id: true } });
  for (const v of VENTES) await prisma.sale.create({ data: { ...v, companyId: company?.id ?? null, comment: TAG } });
  const env = await prisma.budgetEnvelope.create({
    data: { name: `Marketing 2026 ${TAG}`, periodStart: new Date(Date.UTC(2026, 0, 1)), periodEnd: new Date(Date.UTC(2026, 11, 31)), totalAmount: 10_000_000, notes: TAG, companyId: company?.id ?? null, categories: { create: POSTES.map(([name, allocated]) => ({ name, allocated })) } },
  });
  await prisma.budgetEnvelope.create({ data: { name: `Médical 2026 ${TAG}`, periodStart: new Date(Date.UTC(2026, 0, 1)), periodEnd: new Date(Date.UTC(2026, 11, 31)), totalAmount: 6_500_000, notes: TAG, companyId: company?.id ?? null } });
  for (const [i, [status, amount]] of ADPRO.entries()) {
    await prisma.adProOtherRequest.create({ data: { reference: `AUT-${TAG}-${i + 1}`, title: `Demande ${TAG} ${i + 1}`, amount, status, companyId: company?.id ?? null, requesterId: admin.id } });
  }
  // L'EXCEL JOINT : un titre au-dessus du tableau, une colonne Montant en FORMULE (valeur enregistrée).
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ventes T3");
  ws.addRow(["Ventes terrain — 3e trimestre 2026"]);
  ws.addRow(["Délégué", "Région", "Mois", "Produit", "Quantité", "Prix unitaire", "Montant"]);
  EXCEL.forEach((e, i) => ws.addRow([e.delegue, e.region, e.mois, e.produit, e.quantite, e.prix, { formula: `E${i + 3}*F${i + 3}`, result: e.quantite * e.prix }]));
  const piece = await portsArtefact.documents.creerFichier(admin.id, { nom: `Ventes terrain T3 2026 ${TAG}.xlsx`, octets: Buffer.from(await wb.xlsx.writeBuffer()), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { pieceId: piece.nodeId, envMarketing: env.id };
}

async function nettoyer(): Promise<void> {
  await prisma.sale.deleteMany({ where: { comment: TAG } });
  await prisma.budgetEnvelope.deleteMany({ where: { notes: TAG } });
  await prisma.adProOtherRequest.deleteMany({ where: { reference: { startsWith: `AUT-${TAG}-` } } });
  const noeuds = await prisma.driveNode.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
  if (noeuds.length) await prisma.driveNode.updateMany({ where: { id: { in: noeuds.map((x) => x.id) } }, data: { isTrashed: true } });
}

// ───────────────────────────── Les cas, et leurs attendus INDÉPENDANTS ─────────────────────────────
const sql = <T>(q: string) => prisma.$queryRawUnsafe<T[]>(q);
const ventesSql = `FROM "Sale" WHERE comment = '${TAG}'`;
const ETAT_ADPRO = `CASE WHEN status IN ('REFUSED', 'CANCELLED') THEN 'REFUSE' ELSE status::text END`;
const parExcel = (cle: "delegue" | "region") => [...new Set(EXCEL.map((e) => e[cle]))].map((k) => somme(EXCEL.filter((e) => e[cle] === k).map((e) => e.quantite * e.prix)));

const CAS: Cas[] = [
  { id: 1, theme: "ventes", texte: "Quel est le chiffre d'affaires total des ventes par client ? Classe-les du plus grand au plus petit.",
    attendus: async () => { const r = await sql<{ s: unknown }>(`SELECT SUM(revenue) s ${ventesSql} GROUP BY client`); return [...r.map((x) => n(x.s)), somme(VENTES.map((v) => v.revenue))]; } },
  { id: 2, theme: "ventes", texte: "Montre l'évolution mensuelle du chiffre d'affaires des ventes en 2026, avec la croissance d'un mois sur l'autre.",
    attendus: async () => (await sql<{ s: unknown }>(`SELECT SUM(revenue) s ${ventesSql} GROUP BY date_trunc('month', date) ORDER BY 1`)).map((x) => n(x.s)) },
  { id: 3, theme: "ventes", texte: "Quels sont les 3 produits les plus vendus en quantité ?",
    attendus: async () => (await sql<{ q: unknown }>(`SELECT SUM(quantity) q ${ventesSql} GROUP BY product ORDER BY 1 DESC LIMIT 3`)).map((x) => n(x.q)) },
  { id: 4, theme: "ventes", texte: "Quelle est la part de chaque client dans le chiffre d'affaires, en pourcentage ?", tolerance: 0.051,
    attendus: async () => { const r = await sql<{ s: unknown }>(`SELECT SUM(revenue) s ${ventesSql} GROUP BY client`); const t = somme(r.map((x) => n(x.s))); return r.map((x) => arrondi((n(x.s) / t) * 100, 1)); } },
  { id: 5, theme: "ventes", texte: "Quel est le montant moyen d'une vente, et la médiane ?", tolerance: 0.01,
    attendus: async () => { const r = await sql<{ a: unknown; m: unknown }>(`SELECT AVG(revenue) a, percentile_cont(0.5) WITHIN GROUP (ORDER BY revenue) m ${ventesSql}`); return [arrondi(n(r[0].a)), n(r[0].m)]; } },
  { id: 6, theme: "ventes", texte: "Combien reste impayé (statut non payé) par client sur les ventes ?",
    attendus: async () => (await sql<{ s: unknown }>(`SELECT SUM(revenue) s ${ventesSql} AND "paymentStatus" = 'UNPAID' GROUP BY client`)).map((x) => n(x.s)) },
  { id: 7, theme: "budget", texte: `Dans l'enveloppe « Marketing 2026 ${TAG} », combien est alloué à chaque poste, et au total ?`,
    attendus: async () => [...POSTES.map(([, a]) => a), somme(POSTES.map(([, a]) => a))] },
  { id: 8, theme: "budget", texte: `Compare le montant total de mes enveloppes budgétaires ${TAG} : Marketing contre Médical, et l'écart entre les deux.`,
    attendus: async () => { const r = await sql<{ t: unknown }>(`SELECT "totalAmount" t FROM "BudgetEnvelope" WHERE notes = '${TAG}' ORDER BY "totalAmount" DESC`); return [...r.map((x) => n(x.t)), n(r[0].t) - n(r[1].t)]; } },
  // Les demandes « autres » VISIBLES : celles du banc ET celles des semis précédents (l'assistant voit tout ce que la personne voit) ;
  // les états de l'écran regroupent REFUSED et CANCELLED (« Refusée / annulée »).
  { id: 9, theme: "adpro", texte: `Pour les demandes Ad & Pro de nature « autre », quel est le montant total par état ?`,
    attendus: async () => (await sql<{ s: unknown }>(`SELECT SUM(amount) s FROM "AdProOtherRequest" GROUP BY ${ETAT_ADPRO}`)).map((x) => n(x.s)) },
  { id: 10, theme: "adpro", texte: `Combien de demandes Ad & Pro « autres » y a-t-il par état, et quel montant moyen par état ?`, tolerance: 0.01,
    attendus: async () => (await sql<{ a: unknown; c: unknown }>(`SELECT AVG(amount) a, COUNT(*) c FROM "AdProOtherRequest" GROUP BY ${ETAT_ADPRO}`)).flatMap((x) => [arrondi(n(x.a)), n(x.c)]).filter((v) => v > 12) },
  { id: 11, theme: "rh", texte: "Quel est l'effectif par département ? Fais-en un graphique.",
    attendus: async () => (await sql<{ c: unknown }>(`SELECT COUNT(e.id) c FROM "Department" d JOIN "Employee" e ON e."departmentId" = d.id GROUP BY d.name`)).map((x) => n(x.c)).filter((c) => c > 2) },
  { id: 12, theme: "excel", piece: true, texte: "Analyse ce fichier : total des ventes (montant) par délégué.", attendus: async () => [...parExcel("delegue"), somme(EXCEL.map((e) => e.quantite * e.prix))] },
  { id: 13, theme: "excel", piece: true, texte: "Dans ce fichier, fais un tableau croisé du montant par région et par mois.",
    attendus: async () => ["Centre", "Est", "Ouest"].flatMap((r) => ["Juillet", "Septembre"].map((m) => somme(EXCEL.filter((e) => e.region === r && e.mois === m).map((e) => e.quantite * e.prix)))) },
  { id: 14, theme: "excel", piece: true, texte: "Dans ce classeur, donne le total, la moyenne et le maximum de la colonne Montant.", tolerance: 0.01,
    attendus: async () => { const m = EXCEL.map((e) => e.quantite * e.prix); return [somme(m), arrondi(somme(m) / m.length), Math.max(...m)]; } },
  { id: 15, theme: "calcul", texte: "Si un chiffre d'affaires de 12 500 000 DZD augmente de 8 % par an pendant 3 ans, combien atteindra-t-il au bout des 3 ans ?", tolerance: 0.5,
    attendus: async () => [12_500_000 * 1.08 ** 3] },
  { id: 16, theme: "pilotage", texte: "Combien de tâches y a-t-il par statut dans toute l'entreprise ?",
    attendus: async () => (await sql<{ c: unknown }>(`SELECT COUNT(*) c FROM "Task" GROUP BY status`)).map((x) => n(x.c)).filter((c) => c > 2) },
];

/** Les nombres d'un bloc d'analyse : cellules et totaux. */
const nombresDuBloc = (b: Bloc): number[] => [...b.lignes.flat(), ...(b.totaux ?? [])].filter((v): v is number => typeof v === "number");

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const u = await prisma.user.findUnique({ where: { email: "super@adventum-bench.dz" } });
  if (!u) throw new Error("Super Admin du banc absent : BENCH_SEED_ALLOW=1 npm run adam:bench:seed");
  const access = await getAccess(u.id, u.role);
  const user = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  const choisis = process.argv.slice(2).map(Number).filter(Boolean);
  const { pieceId } = await semer(user);
  const debut = new Date();
  const resultats: Record<string, unknown>[] = [];
  try {
    for (const cas of CAS.filter((c) => !choisis.length || choisis.includes(c.id))) {
      const cout = await prisma.modelCallLog.aggregate({ where: { userId: u.id, at: { gte: debut } }, _sum: { costUsd: true } });
      if (Number(cout._sum.costUsd ?? 0) > PLAFOND_USD) { console.warn(`Plafond de ${PLAFOND_USD} $ atteint : arrêt.`); break; }
      const t0 = Date.now();
      const r = await jouerTour(user, { texte: cas.texte, pieces: cas.piece ? [{ id: pieceId }] : [], historique: [], delaiMs: 150_000 });
      const ms = Date.now() - t0;
      const blocs = r.ok ? (r.blocs.filter((b) => b.kind === "analyse") as Bloc[]) : [];
      const calcules = blocs.flatMap(nombresDuBloc);
      const attendus = await cas.attendus();
      const tol = cas.tolerance ?? 0.005;
      const manquants = attendus.filter((a) => !calcules.some((c) => Math.abs(c - a) <= tol));
      const inventes = r.ok && /_À vérifier :/.test(r.content);
      const ligne = {
        id: cas.id, theme: cas.theme, demande: cas.texte, ok: r.ok, ms,
        outils: r.ok ? r.outilsAppeles : [], blocsAnalyse: blocs.length, graphiques: blocs.flatMap((b) => b.graphiques.map((g) => g.type)),
        attendus, manquants, juste: r.ok && blocs.length > 0 && manquants.length === 0, chiffresInventes: inventes,
        reponse: r.ok ? r.content.slice(0, 600) : r.error,
      };
      resultats.push(ligne);
      console.info(`#${cas.id} ${ligne.juste ? "JUSTE" : "ÉCART"}${inventes ? " · chiffre non sourcé" : ""} · ${ms} ms · ${ligne.outils.join(", ")}${manquants.length ? ` · manquants ${manquants.join(", ")}` : ""}`);
    }
  } finally {
    const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id, at: { gte: debut } }, select: { inputTokens: true, outputTokens: true, costUsd: true, model: true } });
    const bilan = {
      date: new Date().toISOString(), cas: resultats.length, justes: resultats.filter((x) => x.juste).length,
      chiffresInventes: resultats.filter((x) => x.chiffresInventes).length,
      appelsModele: appels.length, jetonsEntree: somme(appels.map((a) => a.inputTokens ?? 0)), jetonsSortie: somme(appels.map((a) => a.outputTokens ?? 0)),
      coutUsd: arrondi(somme(appels.map((a) => Number(a.costUsd ?? 0))), 4), modeles: [...new Set(appels.map((a) => a.model))],
      msMedian: [...resultats.map((x) => x.ms as number)].sort((a, b) => a - b)[Math.floor(resultats.length / 2)] ?? 0,
    };
    fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
    fs.writeFileSync(SORTIE, `${JSON.stringify({ bilan, resultats }, null, 2)}\n`);
    console.info(JSON.stringify(bilan, null, 2));
    if (!process.env.K1_GARDER) await nettoyer();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
