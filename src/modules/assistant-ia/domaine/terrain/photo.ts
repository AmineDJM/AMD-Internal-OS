/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PHOTOS DE TERRAIN (lot J13, décision 0025) — les RÈGLES, zéro import.
 *
 * Un présentoir en pharmacie, une ordonnance (anonymisée), une facture, une carte de visite : la vision les
 * lit et en tire des FAITS PROPOSÉS — jamais écrits seuls. La personne retient ce qui est juste ; la photo se
 * rattache à la visite (pièce du compte rendu) par une carte.
 *
 * UNE ORDONNANCE NE LIVRE JAMAIS LE PATIENT : la consigne interdit de recopier nom, âge, adresse, numéro ; et
 * `nettoyerFaits` retire en plus toute ligne qui en a la forme. Les faits d'une ordonnance sont des
 * PRESCRIPTIONS (produit, dosage, prescripteur), rien d'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SORTES_PHOTO = ["PRESENTOIR", "ORDONNANCE", "FACTURE", "CARTE_VISITE", "AUTRE"] as const;
export type SortePhoto = (typeof SORTES_PHOTO)[number];

export const LIBELLE_PHOTO: Record<SortePhoto, string> = {
  PRESENTOIR: "Présentoir / linéaire",
  ORDONNANCE: "Ordonnance (anonymisée)",
  FACTURE: "Facture",
  CARTE_VISITE: "Carte de visite",
  AUTRE: "Autre photo",
};

export interface FaitPropose {
  /** « Produit présent », « Prescription », « Téléphone »… */
  cle: string;
  valeur: string;
}

export interface LecturePhoto {
  sorte: SortePhoto;
  resume: string;
  faits: FaitPropose[];
}

export const MAX_FAITS = 12;

export const CONSIGNE_PHOTO = [
  "Tu regardes UNE photo prise sur le terrain par un délégué médical d'un laboratoire algérien.",
  "Rends UNIQUEMENT un objet JSON : {\"sorte\":\"PRESENTOIR\"|\"ORDONNANCE\"|\"FACTURE\"|\"CARTE_VISITE\"|\"AUTRE\",\"resume\":string,\"faits\":[{\"cle\":string,\"valeur\":string}]}.",
  "PRESENTOIR : produits visibles (marque, laboratoire), place, prix affichés, ruptures apparentes.",
  "ORDONNANCE : seulement les prescriptions (produit, dosage, durée) et la spécialité du prescripteur. NE RECOPIE JAMAIS le",
  "nom, l'âge, l'adresse, le numéro ou toute donnée du PATIENT — s'il en voit, écris « données patient non recopiées ».",
  "FACTURE : fournisseur, date, numéro, total TTC, lignes principales. CARTE_VISITE : nom, titre, spécialité, établissement,",
  "téléphone, e-mail. Ne recopie jamais un RIB, un IBAN ou un numéro d'identité ; n'invente rien ; 12 faits au plus ;",
  "« resume » tient en une phrase en français.",
].join("\n");

const PATIENT = /\b(patient|patiente|malade|nom du patient|âge|age|né le|née le|adresse|n° ?(ss|sécu|assur))/i;

/** Les faits relus : bornés, et pour une ordonnance, toute trace du patient retirée. */
export function nettoyerFaits(sorte: SortePhoto, faits: unknown): FaitPropose[] {
  if (!Array.isArray(faits)) return [];
  return faits.flatMap((f): FaitPropose[] => {
    if (!f || typeof f !== "object") return [];
    const cle = typeof (f as { cle?: unknown }).cle === "string" ? (f as { cle: string }).cle.trim().slice(0, 60) : "";
    const valeur = typeof (f as { valeur?: unknown }).valeur === "string" ? (f as { valeur: string }).valeur.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!cle || !valeur) return [];
    if (sorte === "ORDONNANCE" && (PATIENT.test(cle) || PATIENT.test(valeur))) return [];
    return [{ cle, valeur }];
  }).slice(0, MAX_FAITS);
}

export function lireLecturePhoto(o: unknown, sorteDemandee: SortePhoto | null): LecturePhoto | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const lue = (SORTES_PHOTO as readonly string[]).includes(String(r.sorte)) ? (r.sorte as SortePhoto) : "AUTRE";
  // Ce que la personne a dit prendre l'emporte : une ordonnance annoncée garde ses règles d'anonymat.
  const sorte = sorteDemandee === "ORDONNANCE" || lue === "ORDONNANCE" ? "ORDONNANCE" : (sorteDemandee ?? lue);
  const resume = typeof r.resume === "string" ? r.resume.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return { sorte, resume: resume || LIBELLE_PHOTO[sorte], faits: nettoyerFaits(sorte, r.faits) };
}
