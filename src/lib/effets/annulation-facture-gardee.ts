import type { DetailEffet, EffetLu } from "./annulation";
import type { PolitiqueAnnulation, ResultatMetier } from "./politiques";

type Metier = NonNullable<PolitiqueAnnulation["metier"]>;

const objet = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const chaine = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * LA FACTURE RESTE DANS LES PIÈCES (K10c) — annuler une demande de paiement compense l'ORDRE (retiré, ou passé à ANNULÉ)
 * et rend le BC « paiement à demander » ; la FACTURE jointe, elle, est un document reçu du fournisseur : elle reste dans
 * les pièces de la demande (on la retrouve pour la prochaine demande, l'audit la cite). Sans ce geste, l'annulation
 * ligne à ligne la retirait avec tout ce que le dépôt avait créé.
 *
 * La facture se reconnaît à la mise à jour du geste qui l'a rattachée (`factureDocumentId` dans l'« après ») ; on garde
 * sa chaîne de dépôt EXACTE : le `Document`, sa `Piece` (`pieceId`), les liens et la fiche de bibliothèque de cette
 * pièce (l'index SQL de la bibliothèque compris : ce geste ne dépose que la facture), l'objet stocké (`fileKey`) et ses
 * octets (`blobId`). Le lien `factureDocumentId` du BC, lui, revient à son état d'avant avec le reste de la ligne :
 * le BC redemande une facture à la prochaine demande.
 */
export const factureGardee: Metier = async ({ geste }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  const factures = new Set(geste.effets.filter((e) => e.operation === "UPDATE").map((e) => chaine(objet(e.apres)?.factureDocumentId)).filter((x): x is string => x != null));
  if (!factures.size) return { details, traites };

  const crees = (modele: string) => geste.effets.filter((e) => e.type === "ECRITURE" && e.operation === "CREATE" && e.modele === modele);
  const documents = crees("Document").filter((e) => e.enregistrementId && factures.has(e.enregistrementId));
  const pieces = new Set(documents.map((e) => chaine(objet(e.apres)?.pieceId)).filter((x): x is string => x != null));
  const cles = new Set(documents.map((e) => chaine(objet(e.apres)?.fileKey)).filter((x): x is string => x != null));
  const blobs = new Set(crees("Piece").filter((e) => e.enregistrementId && pieces.has(e.enregistrementId)).map((e) => chaine(objet(e.apres)?.blobId)).filter((x): x is string => x != null));

  const garder = (e: EffetLu, quoi: string) => {
    traites.add(e.id);
    details.push({ effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "la facture jointe reste dans les pièces de la demande : seule la demande de paiement est défaite" });
  };
  for (const e of documents) garder(e, `facture « ${chaine(objet(e.apres)?.name) ?? "jointe"} »`);
  for (const e of crees("Piece")) if (e.enregistrementId && pieces.has(e.enregistrementId)) garder(e, "la pièce de la facture");
  for (const e of crees("PieceLien")) if (pieces.has(chaine(objet(e.apres)?.pieceId) ?? "")) garder(e, "le rattachement de la facture à la demande");
  for (const e of geste.effets) {
    if (e.type === "ECRITURE" && e.modele === "BibliothequeFiche" && (e.operation === "SQL" || pieces.has(e.enregistrementId ?? ""))) garder(e, "la facture dans la bibliothèque");
  }
  for (const e of crees("StoredFile")) if (cles.has(e.enregistrementId ?? "")) garder(e, "le fichier de la facture");
  for (const e of crees("FileBlob")) if (blobs.has(e.enregistrementId ?? "")) garder(e, "les octets de la facture");
  return { details, traites };
};
