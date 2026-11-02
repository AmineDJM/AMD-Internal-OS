import { prisma } from "@/lib/prisma";
import type { AnppReserveSeverity, AnppReserveStatus } from "@prisma/client";

/**
 * LA BIBLIOTHÈQUE DES RÉSERVES — l'apprentissage, avec ses garde-fous.
 *
 * Ce module répond à quatre questions, et à quatre seulement :
 *   1. **« L'avons-nous déjà reçue ? »** → recherche de similarité sur le verbatim.
 *   2. **« Qu'avions-nous répondu, et ça a marché ? »** → meilleure réponse historique, c'est-à-dire
 *      celle qui a été ACCEPTÉE, jamais celle qui a été RÉITÉRÉE.
 *   3. **« Ce fournisseur / ce produit récidive-t-il ? »** → statistiques.
 *   4. **« Quelle est la probabilité qu'on nous la refasse ? »** → un score, présenté comme un
 *      score et jamais comme une certitude.
 *
 * ⚠️ RÈGLE ABSOLUE : **une réserve historique n'est pas une règle juridique.** Rien ici ne
 * produit de finding opposable. Ce module fournit des PRÉCÉDENTS, avec leur preuve, que
 * l'équipe Regulatory interprète. Les règles dérivées existent (`AnppDerivedRule`) mais restent
 * INERTES tant qu'un humain ne les a pas validées.
 */

export interface SimilarReserve {
  id: string;
  verbatim: string;
  category: string;
  severity: AnppReserveSeverity;
  status: AnppReserveStatus;
  ctdModule: string | null;
  ctdSection: string | null;
  productName: string | null;
  dci: string | null;
  supplier: string | null;
  response: string | null;
  outcomeNote: string | null;
  evidenceFile: string | null;
  evidencePage: number | null;
  receivedAt: string;
  /** Score de proximité 0..1 (lexical + trigram). */
  score: number;
}

interface Row {
  id: string; verbatim: string; category: string;
  severity: AnppReserveSeverity; status: AnppReserveStatus;
  ctdModule: string | null; ctdSection: string | null;
  productName: string | null; dci: string | null; supplier: string | null;
  response: string | null; outcomeNote: string | null;
  evidenceFile: string | null; evidencePage: number | null;
  receivedAt: Date; score: number;
}

export interface SimilarFilters {
  ctdModule?: string | null;
  ctdSection?: string | null;
  dci?: string | null;
  supplier?: string | null;
  limit?: number;
}

/**
 * Réserves les plus proches d'un texte donné.
 *
 * Deux mesures combinées, parce qu'aucune ne suffit seule : le **plein texte français** attrape
 * le vocabulaire réglementaire (« validation de la méthode analytique »), le **trigram** rattrape
 * les variantes d'écriture et les fautes de frappe des scans. Le score final est le meilleur des
 * deux, ce qui évite qu'une réserve pertinente soit ratée parce qu'elle est mal orthographiée.
 */
export async function findSimilarReserves(text: string, filters: SimilarFilters = {}): Promise<SimilarReserve[]> {
  const q = (text ?? "").trim();
  if (q.length < 12) return []; // trop court pour que « similaire » veuille dire quelque chose
  const limit = Math.min(Math.max(filters.limit ?? 8, 1), 30);

  const conds: string[] = [];
  const params: unknown[] = [q];
  let p = 2;
  if (filters.ctdModule) { conds.push(`r."ctdModule" = $${p++}`); params.push(filters.ctdModule); }
  if (filters.ctdSection) { conds.push(`r."ctdSection" = $${p++}`); params.push(filters.ctdSection); }
  if (filters.dci) { conds.push(`r."dci" ILIKE $${p++}`); params.push(`%${filters.dci}%`); }
  if (filters.supplier) { conds.push(`r."supplier" ILIKE $${p++}`); params.push(`%${filters.supplier}%`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit);

  const sql = `
    SELECT r."id", r."verbatim", r."category", r."severity", r."status",
           r."ctdModule", r."ctdSection", r."productName", r."dci", r."supplier",
           r."response", r."outcomeNote", r."evidenceFile", r."evidencePage",
           b."receivedAt",
           GREATEST(
             ts_rank(to_tsvector('french', r."verbatim"), plainto_tsquery('french', $1)),
             similarity(r."verbatim", $1)
           ) AS score
    FROM "AnppReserve" r
    JOIN "AnppReserveBatch" b ON b."id" = r."batchId"
    ${where}
    ORDER BY score DESC
    LIMIT $${p}`;

  let rows: Row[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<Row[]>(sql, ...params);
  } catch (e) {
    console.error("[reserves] recherche de similarité impossible", e);
    return [];
  }

  return rows
    .map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString(), score: Number(r.score) }))
    .filter((r) => r.score > 0.02); // en dessous, ce n'est plus de la similarité mais du bruit
}

// ───────────────────────────── Probabilité de réserve ─────────────────────────────

export interface ReserveRisk {
  /** Score 0..1 — une INDICATION, jamais une prédiction réglementaire. */
  score: number;
  level: "FAIBLE" | "MOYEN" | "ÉLEVÉ";
  /** Ce qui explique le score, en clair. */
  reasons: string[];
  /** Précédents utilisés pour l'établir. */
  precedents: SimilarReserve[];
}

/**
 * Probabilité qu'une réserve du même type nous soit à nouveau adressée.
 *
 * Calcul volontairement SIMPLE et EXPLICABLE — pas un modèle opaque : plus le reproche est
 * fréquent, plus il a été réitéré, plus il touche le même fournisseur ou la même DCI, plus le
 * risque monte. Chaque composante est rendue en clair dans `reasons`, pour qu'on puisse
 * contester le chiffre.
 */
export async function reserveRisk(text: string, filters: SimilarFilters = {}): Promise<ReserveRisk> {
  const precedents = await findSimilarReserves(text, { ...filters, limit: 20 });
  const reasons: string[] = [];
  if (precedents.length === 0) {
    return { score: 0, level: "FAIBLE", reasons: ["Aucun précédent comparable dans la bibliothèque."], precedents: [] };
  }

  const strong = precedents.filter((p) => p.score >= 0.25);
  const reiterated = precedents.filter((p) => p.status === "REITERATED");
  const sameSupplier = filters.supplier ? precedents.filter((p) => p.supplier && p.supplier.toLowerCase().includes(filters.supplier!.toLowerCase())) : [];
  const critical = precedents.filter((p) => p.severity === "CRITICAL");

  let score = 0;
  // Fréquence : plafonnée, sinon dix petites réserves pèseraient plus qu'un vrai motif.
  score += Math.min(0.4, strong.length * 0.1);
  if (strong.length > 0) reasons.push(`${strong.length} précédent(s) très proche(s) dans la bibliothèque.`);
  // Réitération : le signal le plus fort — l'ANPP a redemandé malgré une réponse.
  score += Math.min(0.3, reiterated.length * 0.15);
  if (reiterated.length > 0) reasons.push(`${reiterated.length} réserve(s) de ce type ont été RÉITÉRÉES : la réponse apportée n'avait pas suffi.`);
  // Même fournisseur : erreur systémique plutôt qu'accident.
  score += Math.min(0.2, sameSupplier.length * 0.1);
  if (sameSupplier.length > 0) reasons.push(`${sameSupplier.length} précédent(s) sur le même fournisseur — erreur probablement systémique.`);
  if (critical.length > 0) { score += 0.1; reasons.push(`${critical.length} précédent(s) de sévérité critique.`); }

  score = Math.min(1, Math.round(score * 100) / 100);
  return {
    score,
    level: score >= 0.6 ? "ÉLEVÉ" : score >= 0.3 ? "MOYEN" : "FAIBLE",
    reasons,
    precedents: precedents.slice(0, 5),
  };
}

// ───────────────────────────── Statistiques ─────────────────────────────

export interface ReserveStatRow { key: string; count: number; reiterated: number; critical: number }

export interface ReserveStats {
  total: number;
  open: number;
  accepted: number;
  reiterated: number;
  byCategory: ReserveStatRow[];
  byModule: ReserveStatRow[];
  bySupplier: ReserveStatRow[];
  byDci: ReserveStatRow[];
  /** Réserves les plus récurrentes, tous produits confondus. */
  recurring: { verbatim: string; category: string; count: number; reiterated: number }[];
}

/** Tableau de bord des réserves : par catégorie, module, fournisseur, DCI. */
export async function reserveStats(): Promise<ReserveStats> {
  const rows = await prisma.anppReserve.findMany({
    select: { category: true, ctdModule: true, supplier: true, dci: true, status: true, severity: true, verbatim: true },
  });

  const group = (pick: (r: (typeof rows)[number]) => string | null): ReserveStatRow[] => {
    const m = new Map<string, ReserveStatRow>();
    for (const r of rows) {
      const key = pick(r)?.trim() || "— non précisé —";
      const row = m.get(key) ?? { key, count: 0, reiterated: 0, critical: 0 };
      row.count += 1;
      if (r.status === "REITERATED") row.reiterated += 1;
      if (r.severity === "CRITICAL") row.critical += 1;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  };

  // Récurrence : on regroupe sur une empreinte grossière du verbatim (mots significatifs),
  // sinon deux formulations du même reproche compteraient pour deux.
  const sig = (t: string) =>
    t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 4).sort().slice(0, 8).join(" ");
  const byShape = new Map<string, { verbatim: string; category: string; count: number; reiterated: number }>();
  for (const r of rows) {
    const k = sig(r.verbatim);
    if (!k) continue;
    const cur = byShape.get(k) ?? { verbatim: r.verbatim, category: r.category, count: 0, reiterated: 0 };
    cur.count += 1;
    if (r.status === "REITERATED") cur.reiterated += 1;
    byShape.set(k, cur);
  }

  return {
    total: rows.length,
    open: rows.filter((r) => r.status === "OPEN").length,
    accepted: rows.filter((r) => r.status === "ACCEPTED").length,
    reiterated: rows.filter((r) => r.status === "REITERATED").length,
    byCategory: group((r) => r.category),
    byModule: group((r) => r.ctdModule),
    bySupplier: group((r) => r.supplier),
    byDci: group((r) => r.dci),
    recurring: [...byShape.values()].filter((x) => x.count > 1).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

// ───────────────────────────── Règles dérivées ─────────────────────────────

export interface RuleProposal {
  title: string;
  statement: string;
  ctdModule: string | null;
  ctdSection: string | null;
  category: string;
  severity: AnppReserveSeverity;
  evidenceReserveIds: string[];
  occurrences: number;
  confidence: number;
}

/**
 * Confiance d'une règle dérivée. **Explicable et bornée** :
 *   • elle croît avec le nombre d'occurrences (mais sature — dix fois ne vaut pas dix fois plus
 *     sûr que trois fois) ;
 *   • elle MONTE quand l'ANPP a réitéré (le reproche est constant) ;
 *   • elle ne dépasse jamais 0,9 : une règle dérivée reste une observation, pas un texte de loi.
 * Fonction PURE — testée.
 */
export function ruleConfidence(occurrences: number, reiterated: number, distinctProducts: number): number {
  const base = Math.min(0.6, occurrences * 0.12);
  const constancy = Math.min(0.2, reiterated * 0.1);
  // Le même reproche sur plusieurs produits différents = règle générale, pas accident produit.
  const generality = Math.min(0.15, Math.max(0, distinctProducts - 1) * 0.05);
  return Math.min(0.9, Math.round((base + constancy + generality) * 100) / 100);
}

/**
 * Propose des règles à partir des réserves récurrentes.
 *
 * Ne crée RIEN en base : renvoie des propositions. L'écriture, elle, passe par une action
 * serveur qui exige une validation humaine — c'est la frontière entre « apprendre » et
 * « décider tout seul ».
 */
export async function proposeRules(minOccurrences = 3): Promise<RuleProposal[]> {
  const rows = await prisma.anppReserve.findMany({
    select: {
      id: true, verbatim: true, category: true, severity: true, status: true,
      ctdModule: true, ctdSection: true, productName: true,
    },
  });

  // Regroupement par (catégorie, module, section) : c'est la maille à laquelle une règle a un sens.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.category}|${r.ctdModule ?? ""}|${r.ctdSection ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const proposals: RuleProposal[] = [];
  for (const [key, items] of groups) {
    if (items.length < minOccurrences) continue;
    const [category, ctdModule, ctdSection] = key.split("|");
    const reiterated = items.filter((i) => i.status === "REITERATED").length;
    const products = new Set(items.map((i) => i.productName).filter(Boolean));
    const critical = items.filter((i) => i.severity === "CRITICAL").length;

    const where = ctdSection || ctdModule || "le dossier";
    proposals.push({
      title: `${category} — ${where} (${items.length} occurrences)`,
      statement:
        `L'ANPP a formulé ${items.length} fois un reproche de type « ${category} » sur ${where}. ` +
        `Vérifier ce point AVANT soumission.`,
      ctdModule: ctdModule || null,
      ctdSection: ctdSection || null,
      category,
      severity: critical > items.length / 2 ? "CRITICAL" : "MAJOR",
      evidenceReserveIds: items.map((i) => i.id).slice(0, 50),
      occurrences: items.length,
      confidence: ruleConfidence(items.length, reiterated, products.size),
    });
  }

  return proposals.sort((a, b) => b.confidence - a.confidence);
}
