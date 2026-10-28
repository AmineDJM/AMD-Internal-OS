import { prisma } from "@/lib/prisma";
import { findSimilarReserves, reserveRisk } from "@/lib/regulatory/intelligence/reserves/library";
import { sansBloquer } from "@/lib/journal";

/**
 * ENRICHISSEMENT D'UN CONSTAT — le rendre défendable.
 *
 * Un finding qui dit « section 3.2.P.8 incomplète » ne sert à rien : on ne sait ni sur quoi il
 * se fonde, ni où regarder, ni quoi faire. On lui attache donc, quand l'information existe :
 *   • la **règle** appliquée ;
 *   • la **page** et l'**extrait exact** — la pièce ;
 *   • les **valeurs qui se contredisent** entre documents ;
 *   • une **recommandation** concrète ;
 *   • les **réserves ANPP historiques comparables**, et la probabilité qu'elle revienne.
 *
 * ⚠️ Les précédents sont attachés comme PRÉCÉDENTS. Ils n'aggravent jamais automatiquement la
 * sévérité d'un constat et ne créent aucun blocage : « l'ANPP nous l'a déjà reproché » est une
 * information précieuse, ce n'est pas une règle de droit.
 *
 * Ne lève jamais : un enrichissement raté laisse le finding tel quel, il ne le perd pas.
 */

export interface EnrichmentContext {
  /** DCI du produit, si connue — affine la recherche de précédents. */
  dci?: string | null;
  supplier?: string | null;
}

export interface Enrichment {
  similarReserveIds: string[];
  reserveRisk: number | null;
  /** Résumé lisible de ce qui a été trouvé, pour l'afficher sans requête supplémentaire. */
  note: string | null;
}

/**
 * Cherche les précédents d'un constat. Le texte interrogé combine titre et détail : c'est ce
 * qui décrit le reproche, alors que le seul code de règle serait trop pauvre pour une
 * recherche de similarité.
 */
export async function enrichFinding(
  finding: { title: string; detail: string; sectionCode?: string | null },
  ctx: EnrichmentContext = {},
): Promise<Enrichment> {
  const text = `${finding.title}. ${finding.detail}`.trim();
  if (text.length < 12) return { similarReserveIds: [], reserveRisk: null, note: null };

  try {
    const filters = {
      ctdSection: finding.sectionCode ?? null,
      dci: ctx.dci ?? null,
      supplier: ctx.supplier ?? null,
      limit: 5,
    };
    const [similar, risk] = await Promise.all([
      findSimilarReserves(text, filters),
      reserveRisk(text, filters),
    ]);

    if (similar.length === 0) return { similarReserveIds: [], reserveRisk: risk.score, note: null };

    const accepted = similar.find((s) => s.status === "ACCEPTED");
    const reiterated = similar.filter((s) => s.status === "REITERATED").length;

    const parts: string[] = [`${similar.length} réserve(s) ANPP comparable(s) déjà reçue(s).`];
    if (reiterated > 0) parts.push(`${reiterated} avait/avaient été RÉITÉRÉE(S) : la réponse apportée n'avait pas suffi.`);
    if (accepted) parts.push("Une réponse a déjà été acceptée sur un cas proche — voir la bibliothèque des réserves.");

    return {
      similarReserveIds: similar.map((s) => s.id),
      reserveRisk: risk.score,
      note: parts.join(" "),
    };
  } catch (e) {
    console.error("[findings] enrichissement impossible", e);
    return { similarReserveIds: [], reserveRisk: null, note: null };
  }
}

/**
 * Enrichit tous les constats OUVERTS d'une version de dossier.
 *
 * Appelé après une analyse : chaque constat se voit attacher ses précédents. Volontairement
 * séquentiel — la recherche de similarité tape la base, et un dossier de 300 constats ne doit
 * pas la saturer d'un coup.
 */
export async function enrichVersionFindings(dossierVersionId: string, ctx: EnrichmentContext = {}): Promise<number> {
  let enriched = 0;
  try {
    const findings = await prisma.regulatoryFinding.findMany({
      where: { dossierVersionId, status: "OPEN" },
      select: { id: true, title: true, detail: true, sectionCode: true },
      take: 500,
    });

    for (const f of findings) {
      const e = await enrichFinding(f, ctx);
      if (e.similarReserveIds.length === 0 && e.reserveRisk == null) continue;
      await prisma.regulatoryFinding.update({
        where: { id: f.id },
        data: { similarReserveIds: e.similarReserveIds, reserveRisk: e.reserveRisk },
      }).catch(sansBloquer("enrich.enrichVersionFindings.regulatoryFinding"));
      enriched++;
    }
  } catch (e) {
    console.error("[findings] enrichissement de version impossible", e);
  }
  return enriched;
}

/**
 * Contrôle de complétude d'un constat, tel qu'il sera affiché.
 *
 * Rend visible ce qui manque pour qu'il soit défendable. Ce n'est pas un blocage : un constat
 * incomplet reste utile — mais on doit SAVOIR qu'il est incomplet plutôt que de le découvrir
 * face à l'agence. Fonction PURE — testée.
 */
export interface QualityCheck {
  score: number; // 0..1
  missing: string[];
  defensible: boolean;
}

export function findingQuality(f: {
  ruleRef?: string | null;
  confidence?: number | null;
  page?: number | null;
  excerpt?: string | null;
  recommendation?: string | null;
  documentId?: string | null;
}): QualityCheck {
  const missing: string[] = [];
  if (!f.ruleRef) missing.push("règle appliquée");
  if (f.confidence == null) missing.push("niveau de confiance");
  if (!f.documentId) missing.push("document visé");
  if (f.page == null) missing.push("page");
  if (!f.excerpt) missing.push("extrait exact");
  if (!f.recommendation) missing.push("recommandation");

  const total = 6;
  const score = Math.round(((total - missing.length) / total) * 100) / 100;
  // Défendable = on peut MONTRER la pièce (document + page + extrait) et dire d'où vient la règle.
  const defensible = Boolean(f.ruleRef && f.documentId && f.page != null && f.excerpt);
  return { score, missing, defensible };
}
