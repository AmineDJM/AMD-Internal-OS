/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE BIBLIOTHÈQUE — LA PORTE D'INSCRIPTION (J1).
 *
 * La porte que chaque point d'entrée importe après avoir écrit une pièce au coffre (`putBlob`, `saveFile`).
 * Volontairement ÉTROITE : elle n'emporte ni la recherche, ni les règles d'accès, ni les lecteurs — un
 * fichier d'actions ou une route qui inscrit ne tire dans son graphe que le registre (Prisma) et le
 * domaine pur. La recherche est sur `./api`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  inscrirePiece, inscrireDocument, inscrireDocumentEcrit, inscrireDocumentExistant, inscrireDocumentRh, inscrireFichierDrive,
  type InscriptionPiece, type ResultatInscription,
} from "./infra/inscription";
export type { Famille } from "./domaine/familles";
