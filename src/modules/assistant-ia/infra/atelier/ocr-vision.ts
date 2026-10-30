import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { auNomDe } from "../consommation";
import { genererTexte } from "../generer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OCR VISION DES CONVERSIONS (décision 0019, suite) — quand tesseract lit mal une page scannée (arabe vocalisé, scan
 * dégradé), le modèle de vision de l'Assistant IA la TRANSCRIT. Par la porte `genererTexte` : interrupteur général,
 * budget et journal au nom du DEMANDEUR (`auNomDe`), rôle « ocr ».
 *
 * Ce lecteur ne décide pas ce qui a le droit de partir : la GARDE de confidentialité est passée par le socle
 * (`gardeOcrVision`, avant de l'appeler). Il ajoute ses propres conditions, celles du Super Admin :
 *   • le réglage « OCR vision » (Administration › IA) — COUPÉ par défaut ;
 *   • le plafond de dépense du MOIS civil (somme des appels journalisés au rôle « ocr »), vérifié avant chaque page.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CONSIGNE_OCR = [
  "Tu es un moteur d'OCR. Tu TRANSCRIS la page scannée jointe, sans rien d'autre.",
  "Règles absolues :",
  "- Recopie EXACTEMENT le texte imprimé, caractère pour caractère : aucune reformulation, aucune correction, aucune traduction, aucun résumé.",
  "- Arabe : écris dans l'ordre LOGIQUE (l'ordre de lecture), et CONSERVE TOUS les signes de vocalisation (fatha, damma, kasra, sukun, chadda, tanwin) tels qu'imprimés — n'en ajoute aucun qui n'est pas imprimé.",
  "- En particulier : pas de soukoun sur le lam de l'article « ال » s'il n'est pas imprimé ; une chadda, un tanwin ou une kasra imprimés ne s'omettent pas.",
  "- Chiffres, dates, ponctuation (y compris « ، » et « ؛ ») tels qu'imprimés.",
  "- Une ligne de texte de la page = une ligne de ta réponse ; une ligne VIDE entre deux paragraphes.",
  "- Un tableau : une ligne par rangée, au format « | cellule | cellule | », cellules dans l'ordre de lecture.",
  "- Ne décris pas les images ni la mise en page. Un passage illisible s'écrit [illisible].",
  "- Pas de titre, pas de commentaire, pas de bloc de code : uniquement le texte de la page.",
].join("\n");

const DELAI_PAGE_MS = 120_000;

/** La forme attendue par le moteur (`LecteurVision` de `lib/office/conversions-haute-fidelite`), redite ici : le
 * module ne prend pas une dépendance de plus vers `src/lib/` pour une signature. */
interface DemandeVision { page: number; image: Buffer; raison: string; tesseract: string[] }
type LecteurVision = (demandes: DemandeVision[]) => Promise<{ transcriptions: Record<number, string>; note: string | null; coutUsd: number }>;

export interface ReglageOcrVision { actif: boolean; plafondUsd: number }

export async function lireReglageOcrVision(): Promise<ReglageOcrVision> {
  const r = await prisma.aiSetting.findUnique({ where: { id: "global" }, select: { ocrVisionEnabled: true, ocrVisionPlafondUsd: true } })
    .catch(sansBloquer("ocr-vision.reglage", null));
  return { actif: r?.ocrVisionEnabled ?? false, plafondUsd: r ? Number(r.ocrVisionPlafondUsd) : 20 };
}

/** La dépense OCR vision du mois civil en cours (UTC), en dollars. */
export async function depenseOcrVisionDuMois(maintenant = new Date()): Promise<number> {
  const debut = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));
  const r = await prisma.aiUsageLog.aggregate({ where: { route: "ocr", createdAt: { gte: debut } }, _sum: { costUsd: true } });
  return Number(r._sum.costUsd ?? 0);
}

/**
 * LA FABRIQUE remise au socle des conversions : un lecteur au nom de `userId`. Chaque page passe par le modèle de
 * vision tant que le réglage est actif et que le plafond du mois n'est pas atteint ; ce qui n'a pas été lu est DIT.
 */
export function fabriqueVisionOcr(userId: string): LecteurVision {
  return async (demandes: DemandeVision[]) => {
    const transcriptions: Record<number, string> = {};
    const reglage = await lireReglageOcrVision();
    // L'interrupteur général de l'IA est relu par `genererTexte` à chaque page.
    if (!reglage.actif) {
      return { transcriptions, coutUsd: 0, note: `OCR vision coupé par l'administrateur : ${demandes.length} page${demandes.length > 1 ? "s" : ""} difficile${demandes.length > 1 ? "s" : ""} lue${demandes.length > 1 ? "s" : ""} en local seulement` };
    }
    const avant = await depenseOcrVisionDuMois();
    const refus: string[] = [];
    for (const d of demandes) {
      if ((await depenseOcrVisionDuMois()) >= reglage.plafondUsd) {
        refus.push(`page ${d.page} : plafond mensuel de l'OCR vision atteint (${reglage.plafondUsd} $)`);
        continue;
      }
      const contexte = `Page ${d.page} d'un document à convertir en Word (${d.raison}). Transcris-la.`;
      const r = await auNomDe(userId, () => genererTexte(CONSIGNE_OCR, contexte, DELAI_PAGE_MS, {
        images: [{ octets: d.image, mime: "image/png", legende: `page ${d.page}` }], origine: "ocr",
      }));
      if (r.ok && r.texte.trim() && !/^\[illisible\]$/i.test(r.texte.trim())) transcriptions[d.page] = r.texte;
      else refus.push(`page ${d.page} : ${r.ok ? "transcription vide" : r.raison}`);
    }
    const coutUsd = Math.max(0, (await depenseOcrVisionDuMois()) - avant);
    return { transcriptions, coutUsd, note: refus.length ? `OCR vision non appliqué — ${refus.join(" ; ")}` : null };
  };
}
