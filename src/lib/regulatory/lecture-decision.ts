import { prisma } from "@/lib/prisma";
import { readFileByKey } from "@/lib/storage";
import { disponibiliteLecturePieces, lirePieceEnregistrementParModele } from "@/lib/lecture-pieces-ia";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { moteurLuna } from "@/lib/pieces-lues/moteur-luna";
import { methodeCourte, noteDeMethode, refusFormatDePiece, refusTailleDePiece } from "@/lib/pieces-lues/phrases";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import { moteurParDefaut } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import {
  phraseSansLecture, proposerDates,
  type NaturePieceEnregistrement, type PropositionDecision, type PropositionPrix,
} from "@/lib/regulatory/decision-lue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LA DÉCISION D'ENREGISTREMENT OU L'ATTESTATION DE PRIX D'UN DOSSIER — serveur.
 *
 * Le même lecteur que les pièces commerciales et les documents Legal (`lireFichierUneFois` : une
 * fois par empreinte ; un scan par Luna quand la pièce peut sortir, par le moteur OCR local —
 * Mistral, puis Tesseract — sinon), puis le modèle par la porte de la lecture des pièces. Rend une
 * PROPOSITION, jamais un fait ; quand l'IA ne lit pas (coupée, désactivée, pièce illisible), la
 * proposition le DIT et reste vide : la saisie à la main ne dépend de rien.
 *
 * Ne contrôle aucun droit : l'action appelante a passé la porte du dossier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const extensionDe = (nom: string): string => {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
};

export type PropositionLue = { nature: "DECISION"; proposition: PropositionDecision } | { nature: "PRIX"; proposition: PropositionPrix };

export async function lirePieceDuDossier(args: {
  userId: string;
  productId: string;
  documentId: string;
  nature: NaturePieceEnregistrement;
  /** Dossier verrouillé ou pièce non interne : rien ne sort de l'ERP. */
  confidentielle: boolean;
}): Promise<{ ok: true; lue: PropositionLue } | { ok: false; error: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: args.documentId, entityType: "REGULATORY_PRODUCT", entityId: args.productId },
    select: { id: true, name: true, fileKey: true, confidentiality: true },
  });
  if (!doc) return { ok: false, error: "Pièce introuvable sur ce dossier : déposez-la depuis la carte « Décision d'enregistrement »." };
  if (!doc.fileKey) return { ok: false, error: "Cette pièce n'a pas de fichier : redéposez-la." };

  const confidentielle = args.confidentielle || doc.confidentiality !== "INTERNAL";
  const entete = { documentId: doc.id, nomFichier: doc.name, luLe: new Date().toISOString() };
  const vide = (erreur: string, methode = "non lue"): PropositionLue => args.nature === "DECISION"
    ? { nature: "DECISION", proposition: { ...entete, methode, erreur, numero: null, dateDecision: null, debut: null, fin: null } }
    : { nature: "PRIX", proposition: { ...entete, methode, erreur, date: null, prix: [] } };

  const ext = extensionDe(doc.name);
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) return { ok: true, lue: vide(refusFormatDePiece(ext, FORMATS_LUS)) };
  const octets = await readFileByKey(doc.fileKey).catch(() => null);
  if (!octets || octets.length === 0) return { ok: true, lue: vide("Le fichier n'a pas pu être relu sur le stockage : saisissez les valeurs depuis le document.") };
  if (octets.length > TAILLE_MAX_OCTETS) return { ok: true, lue: vide(refusTailleDePiece(octets.length, TAILLE_MAX_OCTETS)) };

  // UN SCAN SE LIT PAR LUNA quand la pièce peut sortir et que la lecture par l'IA est ouverte ; sinon en local.
  const parLuna = !confidentielle && (await disponibiliteLecturePieces()).disponible;
  const lu = await lireFichierUneFois({ octets, ext, cloud: false, maxPages: PAGES_MAX, userId: args.userId },
    parLuna ? { ocr: moteurLuna(moteurParDefaut) } : {});
  if (!lu.ok) return { ok: true, lue: vide(lu.message) };
  const l = lu.lecture;
  const methode = methodeCourte(l);
  const r = await lirePieceEnregistrementParModele({
    nature: args.nature, texte: l.ocrEchoue ? "" : l.texte, nomFichier: doc.name, confidentielle, userId: args.userId,
    noteMethode: noteDeMethode({
      methode: l.methode, confiance: l.confiance, aRelire: l.aRelire, ocrTente: l.ocrTente, ocrEchoue: l.ocrEchoue, raisonOcr: l.raisonOcr,
      pagesLues: l.pagesLues, pagesTotal: l.pagesTotal, tronque: l.tronque, moteur: l.moteur, caracteres: l.caracteres,
    }),
  });
  if (!r.ok) return { ok: true, lue: vide(phraseSansLecture(r.raison, r.cause, args.nature) ?? r.error, methode) };
  if (args.nature === "DECISION") {
    const dates = proposerDates(r.decision);
    const rien = !dates.numero && !dates.dateDecision && !dates.debut && !dates.fin;
    return { ok: true, lue: { nature: "DECISION", proposition: { ...entete, methode, erreur: rien ? "L'IA n'a trouvé ni numéro ni date sur cette pièce — saisissez-les depuis la décision." : null, ...dates } } };
  }
  const a = r.attestation;
  const rien = !a || a.prix.length === 0;
  return { ok: true, lue: { nature: "PRIX", proposition: { ...entete, methode, erreur: rien ? "L'IA n'a trouvé aucun prix en DZD sur cette pièce — saisissez-le depuis l'attestation." : null, date: a?.date ?? null, prix: a?.prix ?? [] } } };
}
