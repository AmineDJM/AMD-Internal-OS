import type { VisibleFieldDef } from "@/components/shared/create-record-button";

/**
 * Catalogue des types de demande (cartes de l'assistant de création).
 *
 * ── « DEMANDE RH » N'Y EST PLUS (décision de la Direction, 09/2026 — §118.138) ───────────
 *
 * « Enlève les demandes RH depuis le bureau du secrétariat. » Une absence, un justificatif, une
 * information RH se demandent dans le module RH, qui a ses circuits, ses pièces et ses droits ;
 * les faire transiter par le secrétariat créait une seconde file pour la même chose, sans aucun
 * de ces circuits.
 *
 * CE QUI N'EST PAS RETIRÉ, et c'est la moitié qui compte : la valeur `HR_SIMPLE` reste dans
 * l'énumération Prisma et dans `ADMIN_REQUEST_TYPE` (`labels.ts`). Les demandes DÉJÀ posées la
 * portent : retirer le libellé afficherait « HR_SIMPLE » en clair sur leur fiche, et retirer la
 * valeur de l'énumération rendrait leur ligne illisible. On ferme la porte d'ENTRÉE, on ne
 * réécrit pas l'histoire.
 *
 * « MISSION CHAUFFEUR » (`DRIVER`) n'y est plus non plus (Direction, 10/2026) — même règle : ses
 * champs restent ci-dessous pour relire les demandes déjà posées (`secretariat/traitement.ts`).
 */
export const REQUEST_TYPES: { value: string; label: string; icon: string; description: string }[] = [
  { value: "TRAVEL", label: "Déplacement / Hôtel / Billet", icon: "Plane", description: "Billet, hôtel, mission, congrès, invité, aéroport" },
  { value: "MAIL", label: "Courrier / Document officiel", icon: "Mail", description: "Courrier PCH/ANPP, lettre, invitation, envoi & suivi" },
  { value: "SIGNATURE", label: "Signature / Cachet / Scan", icon: "PenLine", description: "Faire signer, cacheter, scanner, imprimer, classer" },
  { value: "PURCHASE", label: "Achat interne / Fournitures", icon: "ShoppingCart", description: "Mobilier, fournitures, café, petit matériel" },
  { value: "QUOTE", label: "Devis fournisseur", icon: "FileText", description: "Demander ou comparer des devis" },
  { value: "PAYMENT", label: "Paiement / Facture", icon: "Banknote", description: "Prestataire, agence, fournisseur, remboursement" },
  { value: "GUEST_VISA", label: "Visa / Professeur / Invité", icon: "UserCheck", description: "Invitation, visa, venue & suivi d'un invité" },
  { value: "OTHER", label: "Autre", icon: "CircleHelp", description: "Demande libre en texte normal" },
];

const ouiNon = [{ value: "oui", label: "Oui" }, { value: "non", label: "Non" }];

/** Champs spécifiques par type — stockés dans `fields` (JSON). */
export const REQUEST_TYPE_FIELDS: Record<string, VisibleFieldDef[]> = {
  TRAVEL: [
    { type: "text", name: "poste", label: "Poste / fonction" },
    { type: "text", name: "villeDepart", label: "Ville de départ" },
    { type: "text", name: "villeArrivee", label: "Ville d'arrivée" },
    { type: "date", name: "dateDepart", label: "Date de départ" },
    { type: "date", name: "dateRetour", label: "Date de retour" },
    { type: "select", name: "billet", label: "Billet nécessaire", options: ouiNon, defaultValue: "oui" },
    { type: "select", name: "hotel", label: "Hôtel nécessaire", options: ouiNon, defaultValue: "non" },
    { type: "number", name: "nbNuits", label: "Nombre de nuits" },
    { type: "text", name: "hotelPref", label: "Préférence hôtel" },
    { type: "text", name: "agence", label: "Agence de voyage" },
    { type: "number", name: "budget", label: "Budget estimé (DZD)" },
  ],
  MAIL: [
    { type: "text", name: "destinataire", label: "Destinataire" },
    { type: "text", name: "organisme", label: "Organisme" },
    { type: "text", name: "objet", label: "Objet", full: true },
    { type: "textarea", name: "contenu", label: "Contenu souhaité" },
    { type: "select", name: "signature", label: "Signature nécessaire", options: ouiNon, defaultValue: "non" },
    { type: "select", name: "cachet", label: "Cachet nécessaire", options: ouiNon, defaultValue: "non" },
    { type: "select", name: "modeEnvoi", label: "Mode d'envoi", options: [{ value: "mail", label: "Mail" }, { value: "depot", label: "Dépôt physique" }, { value: "courrier", label: "Courrier" }, { value: "autre", label: "Autre" }] },
  ],
  SIGNATURE: [
    { type: "text", name: "documentConcerne", label: "Document concerné", full: true },
    { type: "select", name: "action", label: "Action", options: [{ value: "signature", label: "Signature" }, { value: "cachet", label: "Cachet" }, { value: "scan", label: "Scan" }, { value: "impression", label: "Impression" }, { value: "classement", label: "Classement" }, { value: "autre", label: "Autre" }] },
    { type: "text", name: "signataire", label: "Signataire souhaité" },
    { type: "number", name: "exemplaires", label: "Nombre d'exemplaires" },
  ],
  PURCHASE: [
    { type: "text", name: "article", label: "Article demandé", full: true },
    { type: "number", name: "quantite", label: "Quantité" },
    { type: "number", name: "budget", label: "Budget estimé (DZD)" },
    { type: "text", name: "fournisseur", label: "Fournisseur proposé" },
    { type: "select", name: "devisDispo", label: "Devis déjà disponible", options: ouiNon, defaultValue: "non" },
  ],
  QUOTE: [
    { type: "text", name: "produit", label: "Produit / service", full: true },
    { type: "number", name: "quantite", label: "Quantité" },
    { type: "text", name: "fournisseurCible", label: "Fournisseur cible" },
    { type: "text", name: "fournisseursAlt", label: "Fournisseurs alternatifs" },
    { type: "number", name: "budget", label: "Budget estimé (DZD)" },
  ],
  PAYMENT: [
    { type: "text", name: "beneficiaire", label: "Bénéficiaire", full: true },
    { type: "text", name: "typePaiement", label: "Type de paiement" },
    { type: "number", name: "montant", label: "Montant" },
    { type: "text", name: "devise", label: "Devise", defaultValue: "DZD" },
    { type: "select", name: "factureDispo", label: "Facture disponible", options: ouiNon, defaultValue: "non" },
    { type: "text", name: "modePaiement", label: "Mode de paiement souhaité" },
    { type: "date", name: "datePaiement", label: "Date souhaitée de paiement" },
  ],
  // DRIVER ne se crée plus : ses champs servent à RELIRE les demandes déjà posées.
  DRIVER: [
    { type: "text", name: "lieuDepart", label: "Lieu de départ" },
    { type: "text", name: "destination", label: "Destination" },
    { type: "text", name: "adresse", label: "Adresse complète", full: true },
    { type: "text", name: "contact", label: "Contact sur place" },
    { type: "text", name: "telephone", label: "Téléphone contact" },
    { type: "textarea", name: "instructions", label: "Instructions" },
    { type: "text", name: "objetDeposer", label: "Objet à déposer" },
    { type: "text", name: "objetRecuperer", label: "Objet à récupérer" },
  ],
  GUEST_VISA: [
    { type: "text", name: "nom", label: "Nom de la personne" },
    { type: "text", name: "fonction", label: "Fonction" },
    { type: "text", name: "organisme", label: "Organisme" },
    { type: "text", name: "pays", label: "Pays" },
    { type: "text", name: "telephone", label: "Téléphone" },
    { type: "text", name: "email", label: "E-mail" },
    { type: "select", name: "typeAide", label: "Type d'aide", options: [{ value: "visa", label: "Visa" }, { value: "billet", label: "Billet" }, { value: "hotel", label: "Hôtel" }, { value: "invitation", label: "Invitation" }, { value: "formulaire", label: "Formulaire" }, { value: "autre", label: "Autre" }] },
    { type: "text", name: "evenement", label: "Événement lié" },
  ],
  // HR_SIMPLE garde ses champs : ils servent à RELIRE les demandes déjà posées (`fieldLabels`).
  // Les supprimer afficherait « typeDemande » en clair sur une fiche d'archive.
  HR_SIMPLE: [
    { type: "text", name: "typeDemande", label: "Type de demande" },
    { type: "date", name: "dateDebut", label: "Date début" },
    { type: "date", name: "dateFin", label: "Date fin" },
  ],
  OTHER: [],
};

/** Map name → label for a type, to render stored `fields` on the detail page. */
export function fieldLabels(type: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of REQUEST_TYPE_FIELDS[type] ?? []) out[f.name] = f.label;
  return out;
}
