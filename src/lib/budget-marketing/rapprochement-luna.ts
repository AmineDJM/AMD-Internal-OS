import { prisma } from "@/lib/prisma";
import { proposerLecture, FORMATS_LUS, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/service";
import { texteDeLaLecture } from "@/lib/pieces-lues/lecture-fichier";
import { identiteDepuisLecture } from "@/lib/factures/identite";
import { extraireReferences, motsSignificatifs, type LuDePiece } from "@/lib/budget-marketing/rapprochement";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AD & PRO — CE QUE LUNA LIT D'UNE PIÈCE.
 *
 * Aucun lecteur neuf : la pièce passe par LE lecteur de pièces de la plateforme (`pieces-lues/service.ts`,
 * `proposerLecture` — Luna quand la pièce peut sortir de l'ERP et que la lecture par l'IA est ouverte, le moteur local
 * sinon ; texte natif, OCR, en-têtes, lignes ; une lecture par empreinte, gardée dans `LecturePiece`), puis par la même
 * identité de facture que le recensement des doublons (`factures/identite.ts` : fournisseur, n°, date, TTC, nature, chacun
 * passé par son garde-fou). On y ajoute ce que le rapprochement cherche en plus : les références imprimées (SPO-, MP-,
 * DIM-, PAY-, OD-, FIN-, n° de facture / BC) et les mots qui disent l'événement.
 *
 * Une pièce CONFIDENTIELLE (fichier non INTERNAL) n'est jamais montrée à un modèle : `sortieCloudPermise` faux.
 *
 * Serveur seulement — les tests le remplacent (`vi.mock`) : Luna ne sort jamais d'un banc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatLecturePiece =
  | { ok: true; lu: LuDePiece; lectureId: string | null }
  | { ok: false; raison: string };

/** L'extension lue d'un nom de fichier. */
export function extension(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
}

/** Un fichier que le lecteur ne lira pas (format, taille) — dit AVANT d'en charger les octets. */
export function refusAvantLecture(nom: string, taille: number | null): string | null {
  const ext = extension(nom);
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) return `format .${ext || "?"} non lu`;
  if (taille != null && taille > TAILLE_MAX_OCTETS) return "fichier de plus de 15 Mo, non lu";
  if (taille === 0) return "fichier vide";
  return null;
}

export async function lirePieceParLuna(userId: string, octets: Buffer, nomFichier: string, sortieCloudPermise: boolean): Promise<ResultatLecturePiece> {
  const ids = await prisma.companyLegalIdentity.findMany({ select: { nif: true, rcNumber: true } });
  const groupe = { nifs: ids.map((i) => i.nif).filter((x): x is string => Boolean(x)), rcs: ids.map((i) => i.rcNumber).filter((x): x is string => Boolean(x)) };
  const r = await proposerLecture({ user: { id: userId }, octets, nomFichier, contexte: { cible: "LEGAL_DOCUMENT", sortieCloudPermise, annuaireVisible: [], groupe } });
  if (!r.ok) return { ok: false, raison: r.error.slice(0, 300) };
  const p = r.proposition;
  const texte = await texteDeLaLecture(p.lectureId).catch(sansBloquer("rapprochement-luna.lirePieceParLuna.texteDeLaLecture", null));
  const identite = identiteDepuisLecture({ empreintes: [p.empreinte], texte, entetes: p.entetes, piece: p.piece, groupe });
  const debut = (texte ?? "").slice(0, 6000);
  return {
    ok: true,
    lectureId: p.lectureId,
    lu: {
      fournisseur: identite.fournisseur.nom ?? p.emetteur.nom ?? null,
      montant: identite.ttc,
      date: identite.date,
      numero: identite.numero,
      nature: identite.nature,
      references: extraireReferences(debut, nomFichier).slice(0, 40),
      motsCles: motsSignificatifs(debut).slice(0, 80),
    },
  };
}
