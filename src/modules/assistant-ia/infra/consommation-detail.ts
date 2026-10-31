import { prisma } from "@/lib/prisma";
import { facturer, GRILLE_RELEVEE_LE, LIBELLE_POSTE, POSTES, tarifDuModele, type Poste } from "@/platform/ia/telemetry/tarifs";
import { lireReglagesAssistantIa } from "./consommation";
import { rapprocherOpenAI } from "./consommation-rapprochement";
import {
  additionner, intervallesResumes, jourAlger, LIBELLE_RESUME, periodeChoisie, totauxVides, usageDe,
  type AppelDetaille, type CleResume, type LigneVentilee, type Perimetre, type Plafonds, type PosteCout, type Totaux, type VueConsommation,
} from "../domaine/consommation-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOMMATION IA, LUE DANS LE JOURNAL — lot K8, décision 0035.
 *
 * Une seule source : `ModelCallLog` (une ligne par appel PAYÉ, tous fournisseurs, Adam, l'Assistant IA,
 * le worker). Les agrégats sont faits EN BASE (somme exacte des `Decimal`) ; l'écran ne lit jamais des
 * milliers de lignes, sauf le détail appel par appel, borné (`LIMITE_DETAIL`, l'export en lit plus).
 *
 * LE PÉRIMÈTRE EST UNE GARDE, PAS UN FILTRE D'ÉCRAN : « moi » ajoute `userId = <la personne connectée>`
 * à CHAQUE requête ; « entreprise » n'est servi qu'au Super Admin (vérifié par l'action, et ici encore).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const LIMITE_DETAIL = 300;
export const LIMITE_EXPORT = 50_000;

type Brut = Record<string, unknown>;
const n = (v: unknown): number => (v == null ? 0 : Number(v));

const SOMMES = `COUNT(*) AS "appels",
  COALESCE(SUM("inputTokens"),0) AS "entree", COALESCE(SUM("cachedInputTokens"),0) AS "entreeCache",
  COALESCE(SUM("outputTokens"),0) AS "sortie", COALESCE(SUM("reasoningTokens"),0) AS "raisonnement",
  COALESCE(SUM("audioInputTokens"),0) AS "audioEntree", COALESCE(SUM("cachedAudioInputTokens"),0) AS "audioEntreeCache",
  COALESCE(SUM("audioOutputTokens"),0) AS "audioSortie", COALESCE(SUM("imageInputTokens"),0) AS "imageEntree",
  COALESCE(SUM("cachedImageInputTokens"),0) AS "imageEntreeCache", COALESCE(SUM("imageOutputTokens"),0) AS "imageSortie",
  COALESCE(SUM("webSearchCalls"),0) AS "recherchesWeb", COALESCE(SUM("durationMs"),0) AS "dureeMs", COALESCE(SUM("pages"),0) AS "pages",
  COALESCE(SUM("costUsd"),0)::text AS "cout",
  SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif",
  SUM(CASE WHEN "estimated" THEN 1 ELSE 0 END) AS "estimes"`;

function totaux(r: Brut | undefined): Totaux {
  if (!r) return totauxVides();
  return {
    appels: n(r.appels), entree: n(r.entree), entreeCache: n(r.entreeCache), sortie: n(r.sortie), raisonnement: n(r.raisonnement),
    audioEntree: n(r.audioEntree), audioEntreeCache: n(r.audioEntreeCache), audioSortie: n(r.audioSortie),
    imageEntree: n(r.imageEntree), imageEntreeCache: n(r.imageEntreeCache), imageSortie: n(r.imageSortie),
    recherchesWeb: n(r.recherchesWeb), dureeMs: n(r.dureeMs), pages: n(r.pages),
    coutUsd: additionner([String(r.cout ?? "0")]), sansTarif: n(r.sansTarif), estimes: n(r.estimes),
  };
}

function fusionner(a: Totaux, b: Totaux): Totaux {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof Totaux)[]) {
    if (k === "coutUsd") out.coutUsd = additionner([a.coutUsd, b.coutUsd]);
    else (out[k] as number) = (a[k] as number) + (b[k] as number);
  }
  return out;
}

/** La clause du périmètre : paramètres numérotés à partir de `$debut`. Jamais de valeur interpolée. */
function clause(p: { debut: Date; fin: Date; userId: string | null }): { where: string; params: unknown[] } {
  return p.userId
    ? { where: `"at" >= $1 AND "at" < $2 AND "userId" = $3`, params: [p.debut, p.fin, p.userId] }
    : { where: `"at" >= $1 AND "at" < $2`, params: [p.debut, p.fin] };
}

export interface DemandeConsommation {
  perimetre: Perimetre;
  /** La personne CONNECTÉE — en « moi », le seul `userId` lu. */
  userId: string;
  estSuperAdmin: boolean;
  du?: string | null;
  au?: string | null;
  /** Super Admin, périmètre entreprise : restreindre à une personne. */
  personne?: string | null;
  now?: Date;
}

/** Qui est lu : la personne connectée (« moi »), ou toute l'entreprise / une personne (Super Admin seul). */
export function cibleDe(d: DemandeConsommation): { userId: string | null } | { refus: string } {
  if (d.perimetre === "moi") return { userId: d.userId };
  if (!d.estSuperAdmin) return { refus: "La consommation de toute l'entreprise est réservée au Super Admin." };
  return { userId: d.personne?.trim() ? d.personne.trim() : null };
}

export async function lireConsommation(d: DemandeConsommation): Promise<VueConsommation | { refus: string }> {
  const cible = cibleDe(d);
  if ("refus" in cible) return cible;
  const now = d.now ?? new Date();
  const { debut, fin } = periodeChoisie(d.du, d.au, now);
  const base = { debut, fin, userId: cible.userId };
  const c = clause(base);
  const sql = <T = Brut>(q: string, params: unknown[] = c.params) => prisma.$queryRawUnsafe<T[]>(q, ...params);

  const resumesIntervalles = intervallesResumes(now);
  const cles = Object.keys(resumesIntervalles) as CleResume[];

  const [resumesBruts, total, parModeleBrut, parUsageBrut, parConvBrut, parPersonneBrut, parJourBrut, appelsBruts, plafonds] = await Promise.all([
    Promise.all(cles.map((k) => {
      const cc = clause({ ...resumesIntervalles[k], userId: cible.userId });
      return sql(`SELECT ${SOMMES} FROM "ModelCallLog" WHERE ${cc.where}`, cc.params);
    })),
    sql(`SELECT ${SOMMES} FROM "ModelCallLog" WHERE ${c.where}`),
    sql<Brut & { provider: string; model: string; batch: boolean }>(
      `SELECT "provider", "model", "batch", ${SOMMES} FROM "ModelCallLog" WHERE ${c.where} GROUP BY 1, 2, 3`),
    sql<Brut & { feature: string | null; role: string | null; route: string | null }>(
      `SELECT "feature", "role", "route", ${SOMMES} FROM "ModelCallLog" WHERE ${c.where} GROUP BY 1, 2, 3`),
    sql<Brut & { threadId: string }>(
      `SELECT "threadId", ${SOMMES} FROM "ModelCallLog" WHERE ${c.where} AND "threadId" IS NOT NULL
       GROUP BY 1 ORDER BY SUM(COALESCE("costUsd",0)) DESC, COUNT(*) DESC LIMIT 50`),
    cible.userId ? Promise.resolve([] as (Brut & { userId: string | null })[]) : sql<Brut & { userId: string | null }>(
      `SELECT "userId", ${SOMMES} FROM "ModelCallLog" WHERE ${c.where} GROUP BY 1 ORDER BY SUM(COALESCE("costUsd",0)) DESC`),
    // Le jour d'Alger : l'instant UTC décalé d'une heure, tronqué au jour.
    sql<Brut & { jour: string }>(
      `SELECT to_char(date_trunc('day', "at" + interval '1 hour'), 'YYYY-MM-DD') AS "jour", ${SOMMES}
       FROM "ModelCallLog" WHERE ${c.where} GROUP BY 1 ORDER BY 1`),
    lireAppels(base, LIMITE_DETAIL + 1),
    d.perimetre === "entreprise" ? lirePlafonds(debut) : Promise.resolve(null),
  ]);

  // Les noms (personnes, conversations) — une requête chacun, jamais par ligne.
  const ids = [...new Set(parPersonneBrut.map((p) => p.userId).filter((x): x is string => !!x))];
  const noms = await nomsDe(ids);
  const titres = await titresDe(parConvBrut.map((r) => r.threadId));

  const ventiler = <R extends Brut>(rows: R[], cleDe: (r: R) => { cle: string; libelle: string; detail?: string }): LigneVentilee[] => {
    const m = new Map<string, LigneVentilee>();
    for (const r of rows) {
      const k = cleDe(r);
      const prec = m.get(k.cle);
      const t = totaux(r);
      m.set(k.cle, prec ? { ...prec, ...fusionner(prec, t) } : { ...k, ...t });
    }
    return [...m.values()].sort((a, b) => Number(b.coutUsd) - Number(a.coutUsd) || b.appels - a.appels);
  };

  const parModele = ventiler(parModeleBrut, (r) => ({
    cle: `${r.provider}/${r.model}${r.batch ? "/lot" : ""}`, libelle: r.model,
    detail: `${r.provider}${r.batch ? " · API Batch" : ""}${tarifDuModele(r.model) ? "" : " · tarif inconnu"}`,
  }));

  const appelsTronques = appelsBruts.length > LIMITE_DETAIL;
  return {
    perimetre: d.perimetre,
    periode: { debut: debut.toISOString(), fin: fin.toISOString(), libelle: `du ${jourAlger(debut)} au ${jourAlger(new Date(fin.getTime() - 1))}` },
    resumes: cles.map((k, i) => ({ cle: k, libelle: LIBELLE_RESUME[k], totaux: totaux(resumesBruts[i][0]) })),
    totaux: totaux(total[0]),
    postes: postesDe(parModeleBrut),
    parModele,
    parUsage: ventiler(parUsageBrut, (r) => usageDe(r.feature, r.role, r.route)),
    parConversation: ventiler(parConvBrut, (r) => ({ cle: r.threadId, libelle: titres.get(r.threadId) ?? `Conversation ${r.threadId.slice(-6)}` })),
    parPersonne: ventiler(parPersonneBrut, (r) => (r.userId
      ? { cle: r.userId, libelle: noms.get(r.userId) ?? "Compte supprimé" }
      : { cle: "systeme", libelle: "Système (sans personne : worker, tâches planifiées)" })),
    parJour: parJourBrut.map((j) => ({ jour: j.jour, coutUsd: additionner([String(j.cout ?? "0")]), jetons: n(j.entree) + n(j.sortie), appels: n(j.appels) })),
    appels: appelsBruts.slice(0, LIMITE_DETAIL),
    appelsTronques,
    plafonds,
    rapprochement: d.perimetre === "entreprise" && !cible.userId ? await rapprocherOpenAI(debut, fin, totaux(total[0])) : null,
    grilleRelevee: GRILLE_RELEVEE_LE,
  };
}

/**
 * LE COÛT PAR TYPE DE JETON — recalculé à la GRILLE sur les sommes par modèle (le tarif est linéaire : la somme des
 * postes d'un modèle est la facture de ses jetons). Les arrondis par appel du journal peuvent l'écarter du total de
 * quelques micro-dollars : l'écran le dit. Un poste consommé par un modèle sans tarif est « inconnu ».
 */
function postesDe(rows: (Brut & { model: string; batch: boolean })[]): PosteCout[] {
  const acc = new Map<Poste, { quantite: number; montants: string[]; inconnu: boolean }>();
  const quantiteDe: Record<Poste, (r: Brut) => number> = {
    texteEntree: (r) => n(r.entree) - n(r.audioEntree) - n(r.imageEntree) - (n(r.entreeCache) - n(r.audioEntreeCache) - n(r.imageEntreeCache)),
    texteEntreeCache: (r) => n(r.entreeCache) - n(r.audioEntreeCache) - n(r.imageEntreeCache),
    texteSortie: (r) => n(r.sortie) - n(r.audioSortie) - n(r.imageSortie),
    audioEntree: (r) => n(r.audioEntree) - n(r.audioEntreeCache), audioEntreeCache: (r) => n(r.audioEntreeCache), audioSortie: (r) => n(r.audioSortie),
    imageEntree: (r) => n(r.imageEntree) - n(r.imageEntreeCache), imageEntreeCache: (r) => n(r.imageEntreeCache), imageSortie: (r) => n(r.imageSortie),
    duree: (r) => n(r.dureeMs), pages: (r) => n(r.pages), recherchesWeb: (r) => n(r.recherchesWeb),
  };
  for (const r of rows) {
    const f = facturer({
      entree: n(r.entree), entreeCache: n(r.entreeCache), sortie: n(r.sortie), audioEntree: n(r.audioEntree), audioEntreeCache: n(r.audioEntreeCache),
      audioSortie: n(r.audioSortie), imageEntree: n(r.imageEntree), imageEntreeCache: n(r.imageEntreeCache), imageSortie: n(r.imageSortie),
      dureeMs: n(r.dureeMs), pages: n(r.pages), recherchesWeb: n(r.recherchesWeb), lot: !!r.batch,
      // Lignes à équivalents (GPT-Live, vocal sans jetons) : le modèle facturé à la durée les ignore déjà.
    }, tarifDuModele(r.model));
    for (const p of POSTES) {
      const q = Math.max(0, quantiteDe[p](r));
      if (!q) continue;
      const a = acc.get(p) ?? { quantite: 0, montants: [], inconnu: false };
      a.quantite += q;
      if (f.postes[p]) a.montants.push(f.postes[p] as string);
      else if (f.sansPrix.includes(p) || !tarifDuModele(r.model)) a.inconnu = true;
      acc.set(p, a);
    }
  }
  const unite: Record<Poste, string> = {
    texteEntree: "jetons", texteEntreeCache: "jetons", texteSortie: "jetons", audioEntree: "jetons", audioEntreeCache: "jetons", audioSortie: "jetons",
    imageEntree: "jetons", imageEntreeCache: "jetons", imageSortie: "jetons", duree: "ms", pages: "pages", recherchesWeb: "appels",
  };
  return POSTES.filter((p) => acc.has(p)).map((p) => {
    const a = acc.get(p)!;
    return { poste: p, libelle: LIBELLE_POSTE[p], quantite: a.quantite, unite: unite[p], coutUsd: a.inconnu && !a.montants.length ? null : additionner(a.montants) };
  });
}

type LigneBrute = {
  id: string; at: Date; userId: string | null; feature: string | null; role: string; route: string | null; provider: string; model: string;
  threadId: string | null; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number;
  audioInputTokens: number; cachedAudioInputTokens: number; audioOutputTokens: number; imageInputTokens: number; cachedImageInputTokens: number;
  imageOutputTokens: number; webSearchCalls: number; durationMs: number; pages: number; costUsd: { toFixed(d: number): string } | null;
  ms: number; estimated: boolean; batch: boolean; priceGrid: string | null;
};

/** Le détail appel par appel, du plus récent au plus ancien — `limite` lignes au plus. */
export async function lireAppels(p: { debut: Date; fin: Date; userId: string | null }, limite: number): Promise<AppelDetaille[]> {
  const lignes = (await prisma.modelCallLog.findMany({
    where: { at: { gte: p.debut, lt: p.fin }, ...(p.userId ? { userId: p.userId } : {}) },
    orderBy: { at: "desc" }, take: limite,
  })) as unknown as LigneBrute[];
  const noms = await nomsDe([...new Set(lignes.map((l) => l.userId).filter((x): x is string => !!x))]);
  const titres = await titresDe([...new Set(lignes.map((l) => l.threadId).filter((x): x is string => !!x))]);
  return lignes.map((l) => ({
    id: l.id, at: l.at.toISOString(), personne: l.userId ? noms.get(l.userId) ?? "Compte supprimé" : null,
    usage: usageDe(l.feature, l.role, l.route).libelle, fournisseur: l.provider, modele: l.model,
    conversation: l.threadId ? titres.get(l.threadId) ?? l.threadId : null,
    entree: l.inputTokens, entreeCache: l.cachedInputTokens, sortie: l.outputTokens, raisonnement: l.reasoningTokens,
    audioEntree: l.audioInputTokens, audioEntreeCache: l.cachedAudioInputTokens, audioSortie: l.audioOutputTokens,
    imageEntree: l.imageInputTokens, imageEntreeCache: l.cachedImageInputTokens, imageSortie: l.imageOutputTokens,
    recherchesWeb: l.webSearchCalls, dureeFactureeMs: l.durationMs, pages: l.pages,
    coutUsd: l.costUsd == null ? null : l.costUsd.toFixed(6), ms: l.ms, estime: l.estimated, lot: l.batch, grille: l.priceGrid,
  }));
}

async function nomsDe(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Les titres des conversations : celles d'Adventum IA (`AssistantIaFil`) et celles d'Adam (`AssistantThread`). */
async function titresDe(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const [fils, fils2] = await Promise.all([
    prisma.assistantIaFil.findMany({ where: { id: { in: ids } }, select: { id: true, titre: true } }),
    prisma.assistantThread.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
  ]);
  const m = new Map<string, string>();
  for (const f of fils) if (f.titre) m.set(f.id, f.titre);
  for (const f of fils2) if (f.title) m.set(f.id, f.title);
  return m;
}

/** Les plafonds EN COURS (Super Admin) : jetons par jour et par tour, dépense des travaux, plafonds atteints depuis le début. */
async function lirePlafonds(depuis: Date): Promise<Plafonds> {
  const [reglages, ligne, atteints] = await Promise.all([
    lireReglagesAssistantIa(),
    prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { plafondTravailUsd: true, plafondMensuelUsd: true } }),
    prisma.assistantIaPlafondAtteint.findMany({ where: { createdAt: { gte: depuis } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const noms = await nomsDe([...new Set(atteints.map((a) => a.userId))]);
  return {
    jetonsJour: reglages.plafondJetonsJour, jetonsTour: reglages.plafondJetonsTour,
    travailUsd: ligne?.plafondTravailUsd ?? null, mensuelUsd: ligne?.plafondMensuelUsd ?? null,
    atteints: atteints.map((a) => ({ nom: noms.get(a.userId) ?? "Compte supprimé", jour: a.jour.toISOString().slice(0, 10), jetons: a.jetons, plafond: a.plafond })),
  };
}
