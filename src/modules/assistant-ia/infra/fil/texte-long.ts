import { proprietaire } from "@/platform/ia/proprietaire";
import { deposerAudio } from "../lecture/voix";
import { doitDevenirPiece, messageDuTexteLong, nomDuTexte } from "../../domaine/fil/texte-long";
import type { PieceDuTour } from "./service";

/** Le dossier du Drive où vont les textes collés trop longs pour un message. */
export const DOSSIER_TEXTES_LONGS = "Assistant IA — textes longs";

/**
 * UN TEXTE TROP LONG DEVIENT UNE PIÈCE (règle : `domaine/fil/texte-long.ts`) — déposé EN ENTIER dans le Drive de la
 * personne (quota vérifié), joint au message ; le message garde le début et le dit. Sous le seuil : rien ne change.
 * Le dépôt refusé (quota) : le texte reste ENTIER dans le message — jamais coupé.
 */
export async function texteOuPiece(userId: string, texte: string, pieces: PieceDuTour[], maintenant = new Date()): Promise<{ texte: string; pieces: PieceDuTour[] }> {
  const t = texte ?? "";
  if (!doitDevenirPiece(t)) return { texte: t, pieces };
  const user = await proprietaire(userId);
  if (!user) return { texte: t, pieces };
  const nom = nomDuTexte(t.length, maintenant);
  const d = await deposerAudio(user, Buffer.from(t, "utf8"), nom, "text/plain", DOSSIER_TEXTES_LONGS);
  if ("erreur" in d) {
    console.warn("[assistant-ia] texte long : dépôt refusé, le texte part entier dans le message", d.erreur);
    return { texte: t, pieces };
  }
  return { texte: messageDuTexteLong(t, nom), pieces: [...pieces, { id: d.id, nom }] };
}
