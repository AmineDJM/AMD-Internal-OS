/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES NATURES DE DÉPENSE — `NATURES_DEPENSE` (Super Admin, 24/11/2026 : « champ nature OBLIGATOIRE sur
 * la demande de paiement »).
 *
 * UN SEUL RÉFÉRENTIEL. Chaque nature dit, par un code STABLE (`FAMILLE.NATURE`) : son libellé, sa rubrique comptable
 * (`FinanceCategory`), le pôle et la ligne budgétaire (clé `BudgetCategoryLine.cle`) où elle se range par défaut, la pièce
 * attendue, si elle revient, si elle n'est qu'un mouvement de trésorerie, et si son paiement porte une RETENUE À LA
 * SOURCE (`retenue`). Il réunit l'existant plutôt que de le recopier :
 *   • les natures de la caisse des moyens généraux sont celles de `general-means/natures.ts` (mêmes clés `MG_*`) ;
 *   • les natures d'Ad & Pro sont les libellés de `budget/natures.ts` (lus sur le poste ou la case, jamais saisis) ;
 *   • les BV, la paie, les impôts et l'informatique gardent leur circuit (`circuit`) : ils figurent ici pour que la
 *     campagne et la comptabilité lisent la même liste, mais la demande de paiement générique ne les propose pas.
 *
 * Avant ce référentiel, la demande de paiement générique partait toujours en `FOURNISSEUR`, sans ligne : les Finances
 * classaient au moment de payer. La nature choisie à la demande pré-choisit désormais la ligne — elles peuvent encore la
 * changer au règlement (le choix fait en payant l'emporte, `settle-budget.ts`).
 *
 * Vocabulaire (décisions du Super Admin) : vente et achat ; aucune nature d'impôt hors TVA et IBS — l'IRG et la CNAS vivent
 * dans la masse salariale.
 *
 * Module PUR (navigateur compris) : il n'importe que des modules purs sans import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { NATURES } from "@/lib/budget/natures";
import { NATURES_PAR_DEFAUT } from "@/lib/general-means/natures";
import type { RegimeRetenueSource } from "./retenues";

/** Rubrique comptable (les valeurs de l'énumération `FinanceCategory`). */
export type RubriqueNature =
  | "SALAIRE" | "AVANCE" | "LOYER" | "VOYAGE" | "EVENEMENT" | "BUREAUTIQUE" | "FOURNISSEUR" | "CHARGES" | "IMPOT"
  | "REMBOURSEMENT" | "CCA" | "AUTRE";

/** Le pôle qui tient la ligne par défaut. */
export type PoleNature = "ADMINISTRATION" | "PERSONNEL" | "OPERATIONS" | "MARKETING" | "REGULATORY" | "INFORMATIQUE" | "IMPOTS" | "TRESORERIE";


export interface NatureDepense {
  /** Code STABLE « FAMILLE.NATURE » — ce qui s'enregistre sur la demande ; un libellé se renomme, le code jamais. */
  code: string;
  libelle: string;
  famille: string;
  rubrique: RubriqueNature;
  pole: PoleNature;
  /** La clé de la ligne budgétaire (`BudgetCategoryLine.cle`) où elle se range par défaut — `null` : classée au règlement. */
  ligne: string | null;
  /** Le module (`ENTITY_MODULE`) dont une enveloppe peut la recevoir quand aucune ligne ne porte sa clé (attribution automatique). */
  module?: string;
  /** La pièce attendue (le justificatif est obligatoire ; ceci dit lequel). */
  piece: string;
  recurrente: boolean;
  /** Un mouvement de trésorerie, pas une charge (remboursement d'emprunt, avance) : il ne consomme aucun budget de charges. */
  tresorerieSeulement?: boolean;
  /** La retenue à la source que porte son paiement. */
  retenue?: RegimeRetenueSource;
  /** Si la dépense a son PROPRE circuit, la phrase qui y renvoie — la demande générique ne la propose pas. */
  circuit?: string;
  /** Le seul rattachement (`EntityType`) sous lequel une nature de circuit passe quand même par la demande de paiement. */
  rattachement?: string;
  /** Mots de la recherche (sans accents, en minuscules), en plus du libellé. */
  motsCles?: readonly string[];
}

const n = (code: string, libelle: string, rubrique: RubriqueNature, pole: PoleNature, ligne: string | null, piece: string, recurrente: boolean, plus: Partial<NatureDepense> = {}): NatureDepense => ({
  code, libelle, famille: code.split(".")[0], rubrique, pole, ligne, piece, recurrente, ...plus,
});

const CAISSE = "Se paie sur la caisse des moyens généraux (Moyens généraux › Caisse).";
const AD_PRO = "Se paie depuis son poste Ad & Pro ou sa prise en charge : la nature s'y lit sur le poste.";

/** Les familles, dans l'ordre de la liste. */
export const FAMILLES_NATURE: Readonly<Record<string, string>> = {
  HONORAIRES: "Honoraires et prestations",
  LOCAUX: "Locaux et charges fixes",
  PERSONNEL: "Personnel",
  FLOTTE: "Véhicules",
  LOGISTIQUE: "Logistique",
  MARKETING: "Marketing",
  REGLEMENTAIRE: "Réglementaire",
  INFORMATIQUE: "Informatique",
  GOUVERNANCE: "Gouvernance et dons",
  ACHATS: "Achats divers",
  TRESORERIE: "Trésorerie",
  MOYENS_GENERAUX: "Moyens généraux (caisse)",
  AD_PRO: "Ad & Pro",
  CIRCUITS: "Circuits dédiés",
};

export const NATURES_DEPENSE: readonly NatureDepense[] = [
  // ── Honoraires et prestations — les deux premières portent une RETENUE À LA SOURCE ──
  n("HONORAIRES.MEDECIN", "Honoraires de médecin (conférence, board, consultation)", "EVENEMENT", "MARKETING", "HONORAIRES_MEDECINS", "Note d'honoraires", false, { retenue: "HONORAIRES_MEDECIN", module: "CONSULTING", motsCles: ["medecin", "docteur", "dr", "conferencier", "orateur", "speaker", "board", "expert", "kol", "honoraires"] }),
  n("HONORAIRES.PRESTATAIRE_ETRANGER", "Prestation d'un prestataire étranger", "FOURNISSEUR", "ADMINISTRATION", "PRESTATAIRES_ETRANGERS", "Contrat et facture", false, { retenue: "PRESTATAIRE_ETRANGER", motsCles: ["etranger", "non resident", "international", "devises", "france", "europe", "consultant etranger"] }),
  n("HONORAIRES.JURIDIQUES", "Avocats et conseils juridiques", "FOURNISSEUR", "ADMINISTRATION", "HONORAIRES_JURIDIQUES", "Convention d'honoraires et facture", false, { motsCles: ["avocat", "juridique", "contentieux", "litige", "conseil"] }),
  n("HONORAIRES.NOTAIRES", "Notaires et huissiers", "FOURNISSEUR", "ADMINISTRATION", "NOTAIRES", "État de frais", false, { motsCles: ["notaire", "huissier", "acte", "constat"] }),
  n("HONORAIRES.CONSULTANTS", "Consultants (organisation, RH, qualité)", "FOURNISSEUR", "ADMINISTRATION", "CONSULTANTS", "Contrat et facture", false, { motsCles: ["consultant", "conseil", "audit", "cabinet", "organisation", "qualite"] }),
  n("HONORAIRES.TRADUCTIONS", "Traductions, légalisations, apostilles", "FOURNISSEUR", "ADMINISTRATION", "TRADUCTIONS", "Facture", false, { motsCles: ["traduction", "traducteur", "legalisation", "apostille"] }),

  // ── Locaux et charges fixes (mêmes clés que les lignes du Budget de l'administration) ──
  n("LOCAUX.LOYER", "Loyer", "LOYER", "ADMINISTRATION", "LOYER", "Appel de loyer ou quittance", true, { motsCles: ["loyer", "bail", "location bureau", "siege"] }),
  n("LOCAUX.CHARGES_LOCATIVES", "Charges locatives (syndic, copropriété)", "CHARGES", "ADMINISTRATION", "CHARGES_LOCATIVES", "Appel de charges", true, { motsCles: ["syndic", "copropriete", "charges locatives"] }),
  n("LOCAUX.ELECTRICITE_GAZ", "Électricité et gaz", "CHARGES", "ADMINISTRATION", "ELECTRICITE_GAZ", "Facture du fournisseur d'énergie", true, { motsCles: ["electricite", "gaz", "sonelgaz", "energie"] }),
  n("LOCAUX.EAU", "Eau", "CHARGES", "ADMINISTRATION", "EAU", "Facture d'eau", true, { motsCles: ["eau", "seaal", "ade"] }),
  n("LOCAUX.INTERNET", "Internet", "CHARGES", "ADMINISTRATION", "INTERNET", "Facture", true, { motsCles: ["internet", "fibre", "idoom", "adsl"] }),
  n("LOCAUX.TELEPHONIE_FIXE", "Téléphonie fixe", "CHARGES", "ADMINISTRATION", "TELEPHONIE_FIXE", "Facture", true, { motsCles: ["telephone fixe", "standard", "algerie telecom"] }),
  n("LOCAUX.NETTOYAGE", "Nettoyage des locaux", "CHARGES", "ADMINISTRATION", "NETTOYAGE", "Contrat et facture", true, { motsCles: ["nettoyage", "menage", "proprete"] }),
  n("LOCAUX.GARDIENNAGE", "Gardiennage et sécurité", "CHARGES", "ADMINISTRATION", "GARDIENNAGE", "Contrat et facture", true, { motsCles: ["gardiennage", "securite", "agent", "telesurveillance"] }),
  n("LOCAUX.MAINTENANCE", "Maintenance (climatisation, groupe électrogène, extincteurs)", "CHARGES", "ADMINISTRATION", "MAINTENANCE", "Facture", true, { motsCles: ["maintenance", "climatisation", "groupe electrogene", "extincteur", "ascenseur"] }),
  n("LOCAUX.LOCATION_MATERIEL", "Location de matériel (photocopieur, fontaines)", "CHARGES", "ADMINISTRATION", "LOCATION_MATERIEL", "Contrat et facture", true, { motsCles: ["photocopieur", "fontaine", "location materiel"] }),
  n("LOCAUX.AUTRE_CHARGE_FIXE", "Autre charge fixe des locaux", "CHARGES", "ADMINISTRATION", "AUTRE_CHARGE_FIXE", "Facture", true, { motsCles: ["dechets", "desinsectisation", "archivage"] }),

  // ── Personnel (hors paie, qui a son circuit) ──
  n("PERSONNEL.RECRUTEMENT", "Recrutement (annonces, cabinets)", "FOURNISSEUR", "PERSONNEL", "RECRUTEMENT", "Facture du cabinet ou de l'annonce", false, { module: "RECRUITMENT", motsCles: ["recrutement", "annonce", "emploitic", "chasseur"] }),
  n("PERSONNEL.FORMATION", "Formation", "EVENEMENT", "PERSONNEL", null, "Devis et attestation", false, { module: "TRAINING", motsCles: ["formation", "seminaire", "atelier"] }),
  n("PERSONNEL.MEDECINE_TRAVAIL", "Médecine du travail", "CHARGES", "PERSONNEL", "MEDECINE_TRAVAIL", "Convention et facture", true, { motsCles: ["medecine du travail", "visite medicale"] }),
  n("PERSONNEL.OEUVRES_SOCIALES", "Œuvres sociales", "AUTRE", "PERSONNEL", "OEUVRES_SOCIALES", "PV du comité et factures", true, { motsCles: ["oeuvres sociales", "aid", "colonie"] }),
  n("PERSONNEL.RESTAURATION_TRANSPORT", "Restauration et transport du personnel", "CHARGES", "PERSONNEL", "RESTAURATION_TRANSPORT", "Facture", true, { motsCles: ["cantine", "restauration", "navette", "panier"] }),
  n("PERSONNEL.SOLDES_DEPARTS", "Soldes de tout compte et indemnités de départ", "SALAIRE", "PERSONNEL", "SOLDES_DEPARTS", "Reçu pour solde de tout compte", false, { motsCles: ["solde de tout compte", "indemnite", "depart"] }),

  // ── Véhicules ──
  n("FLOTTE.LEASING", "Location longue durée de véhicules", "LOYER", "OPERATIONS", "LEASING_VEHICULES", "Contrat et facture", true, { motsCles: ["leasing", "location vehicule", "lld"] }),
  n("FLOTTE.CARBURANT", "Carburant (cartes, bons)", "CHARGES", "OPERATIONS", "CARBURANT", "Bons ou relevé de carte", true, { motsCles: ["carburant", "naftal", "essence", "gasoil"] }),
  n("FLOTTE.ENTRETIEN", "Entretien et réparation des véhicules", "CHARGES", "OPERATIONS", "ENTRETIEN", "Facture du garage", false, { motsCles: ["garage", "vidange", "pneus", "reparation vehicule"] }),
  n("FLOTTE.CONTROLES", "Contrôle technique et carte grise", "CHARGES", "OPERATIONS", "CONTROLES_CARTES_GRISES", "Quittance", false, { motsCles: ["controle technique", "carte grise", "mutation"] }),
  n("FLOTTE.SINISTRES_AMENDES", "Sinistres, franchises et amendes", "CHARGES", "OPERATIONS", "SINISTRES_AMENDES", "PV ou avis", false, { motsCles: ["sinistre", "franchise", "amende", "contravention"] }),

  // ── Logistique ──
  n("LOGISTIQUE.TRANSPORT", "Transport des livraisons", "FOURNISSEUR", "OPERATIONS", "TRANSPORT_LIVRAISONS", "Facture et bon de livraison", false, { module: "LOGISTICS", motsCles: ["transport", "livraison", "transporteur", "froid"] }),
  n("LOGISTIQUE.STOCKAGE", "Stockage (dépositaire, entrepôt)", "CHARGES", "OPERATIONS", "DEPOSITAIRE", "Contrat et facture", true, { module: "LOGISTICS", motsCles: ["stockage", "entrepot", "depositaire"] }),
  n("LOGISTIQUE.DESTRUCTION", "Destruction des produits périmés", "FOURNISSEUR", "OPERATIONS", "DESTRUCTION_PERIMES", "PV de destruction et facture", false, { module: "LOGISTICS", motsCles: ["destruction", "perime", "incineration"] }),

  // ── Marketing (hors Ad & Pro) ──
  n("MARKETING.ETUDES", "Études de marché et données", "FOURNISSEUR", "MARKETING", "ETUDES_MARCHE_DONNEES", "Contrat et facture", false, { motsCles: ["etude", "marche", "iqvia", "donnees", "audit pharmacie"] }),
  n("MARKETING.PUBLICITE", "Publicité, médias et digital", "EVENEMENT", "MARKETING", "PUBLICITE_MEDIAS", "Facture", false, { motsCles: ["publicite", "media", "digital", "reseaux sociaux", "annonce presse"] }),

  // ── Réglementaire (hors BV, qui ont leur circuit) ──
  n("REGLEMENTAIRE.PHARMACOVIGILANCE", "Pharmacovigilance (prestataire, base, formation)", "FOURNISSEUR", "REGULATORY", "PHARMACOVIGILANCE", "Facture", true, { module: "PHARMACOVIGILANCE", motsCles: ["pharmacovigilance", "pv", "vigilance"] }),
  n("REGLEMENTAIRE.COTISATIONS", "Cotisations professionnelles (ordre, associations, chambre)", "CHARGES", "REGULATORY", "COTISATIONS_PRO", "Appel de cotisation", true, { motsCles: ["cotisation", "ordre des pharmaciens", "chambre de commerce", "syndicat"] }),
  n("REGLEMENTAIRE.AGREMENT", "Agrément, prix, inspections (frais)", "CHARGES", "REGULATORY", null, "Quittance", false, { module: "REGULATORY", motsCles: ["agrement", "inspection", "prix", "attestation"] }),

  // ── Informatique (hors abonnements, qui ont leur circuit) ──
  n("INFORMATIQUE.MATERIEL", "Matériel informatique", "BUREAUTIQUE", "INFORMATIQUE", "MATERIEL_INFORMATIQUE", "Facture", false, { motsCles: ["ordinateur", "pc", "imprimante", "tablette", "materiel informatique"] }),
  n("INFORMATIQUE.HEBERGEMENT", "Hébergement, noms de domaine, messagerie", "FOURNISSEUR", "INFORMATIQUE", "HEBERGEMENT_DOMAINES", "Facture", true, { motsCles: ["hebergement", "domaine", "serveur", "messagerie", "certificat"] }),
  n("INFORMATIQUE.PRESTATAIRES", "Prestataires informatiques (développement, maintenance)", "FOURNISSEUR", "INFORMATIQUE", "PRESTATAIRES_IT", "Contrat et facture", false, { motsCles: ["developpement", "informaticien", "maintenance informatique", "logiciel"] }),

  // ── Gouvernance et dons ──
  n("GOUVERNANCE.DONS_MECENAT", "Dons et mécénat", "AUTRE", "ADMINISTRATION", "DONS_MECENAT", "Reçu de l'association", false, { motsCles: ["don", "mecenat", "association", "solidarite", "ramadan"] }),
  n("GOUVERNANCE.FRAIS_LEGAUX", "Frais d'AG, publications légales, registre du commerce", "CHARGES", "ADMINISTRATION", "FRAIS_AG_LEGAUX", "Quittance", false, { motsCles: ["assemblee", "ag", "registre du commerce", "cnrc", "publication legale", "boal"] }),

  // ── Achats divers (le dernier recours, pour que la liste ne force jamais un faux classement) ──
  n("ACHATS.FOURNISSEUR", "Autre achat auprès d'un fournisseur", "FOURNISSEUR", "ADMINISTRATION", null, "Facture", false, { motsCles: ["achat", "fournisseur", "divers"] }),

  // ── Trésorerie seulement : ni charge ni budget ──
  n("TRESORERIE.REMBOURSEMENT_EMPRUNT", "Remboursement d'emprunt (capital)", "REMBOURSEMENT", "TRESORERIE", null, "Tableau d'amortissement", true, { tresorerieSeulement: true, motsCles: ["emprunt", "credit", "pret", "echeance bancaire"] }),

  // ── Circuits dédiés : dans le référentiel, jamais proposés sur la demande générique ──
  ...NATURES_PAR_DEFAUT.map((m) => n(`MOYENS_GENERAUX.${m.cle}`, m.nom, "CHARGES", "ADMINISTRATION", m.cle, "Ticket ou facture", false, { circuit: CAISSE })),
  ...Object.entries(NATURES).map(([cle, libelle]) => n(`AD_PRO.${cle}`, libelle, "EVENEMENT", "MARKETING", null, "Facture", false, { circuit: AD_PRO })),
  n("CIRCUITS.BV_25", "Bon de versement 25 % (enregistrement)", "AUTRE", "REGULATORY", "BV_25", "Bon de versement et quittance", false, { circuit: "Se paie depuis le dossier d'enregistrement (Regulatory)." }),
  n("CIRCUITS.BV_75", "Bon de versement 75 % (enregistrement)", "AUTRE", "REGULATORY", "BV_75", "Bon de versement et quittance", false, { circuit: "Se paie depuis le dossier d'enregistrement (Regulatory)." }),
  n("CIRCUITS.INFO_MEDICALE", "Bon de versement d'une manifestation (information médicale)", "EVENEMENT", "MARKETING", null, "Bon de versement", false, { module: "MEDICAL_INFO", circuit: "Se demande depuis la déclaration d'information médicale.", rattachement: "MEDICAL_INFO_DECLARATION" }),
  n("CIRCUITS.PAIE", "Virement de la paie (net + primes)", "SALAIRE", "PERSONNEL", "MASSE_SALARIALE", "État de paie", true, { circuit: "Se paie par le virement de la paie (RH › Paie)." }),
  n("CIRCUITS.AVANCE_SALAIRE", "Avance sur salaire", "AVANCE", "TRESORERIE", null, "Demande signée", false, { tresorerieSeulement: true, circuit: "Se demande par une avance sur salaire (RH)." }),
  n("CIRCUITS.TVA", "TVA nette à reverser", "IMPOT", "IMPOTS", "TVA_NETTE", "G50 et quittance", true, { circuit: "Se paie depuis Impôts & cotisations (G50)." }),
  n("CIRCUITS.IBS", "IBS — acomptes et solde", "IMPOT", "IMPOTS", "IBS", "G50 et quittance", false, { circuit: "Se paie depuis Impôts & cotisations (G50)." }),
  n("CIRCUITS.ABONNEMENTS_IT", "Abonnements et licences informatiques", "FOURNISSEUR", "INFORMATIQUE", "ABONNEMENTS_LICENCES", "Facture", true, { circuit: "Se paie depuis les abonnements du Département Informatique." }),
];

const PAR_CODE = new Map(NATURES_DEPENSE.map((x) => [x.code, x]));

/** Les natures qu'une demande de paiement générique PROPOSE — celles qui n'ont pas leur propre circuit. */
export const NATURES_DEMANDE: readonly NatureDepense[] = NATURES_DEPENSE.filter((x) => !x.circuit);

/** Le libellé d'une demande sans nature : celles d'avant la règle, lisibles telles quelles. */
export const NATURE_NON_PRECISEE = "Nature non précisée";

export const REFUS_SANS_NATURE = "Choisissez la nature de la dépense (loyer, honoraires de médecin, transport…) : elle dit où la dépense se range au budget. Si rien ne convient, prenez « Autre achat auprès d'un fournisseur ».";

export function natureDepense(code: string | null | undefined): NatureDepense | null {
  return code ? PAR_CODE.get(code) ?? null : null;
}

/** Le libellé d'une nature — « Nature non précisée » pour une demande d'avant la règle. */
export function libelleNatureDepense(code: string | null | undefined): string {
  return natureDepense(code)?.libelle ?? NATURE_NON_PRECISEE;
}

/** Où la nature se range par défaut, en clair (« Budget de l'administration › Loyer »). */
export function phraseRangement(x: NatureDepense): string {
  if (x.tresorerieSeulement) return "Mouvement de trésorerie : aucune ligne de charges.";
  const pole = LIBELLE_POLE[x.pole];
  return x.ligne ? `Ligne budgétaire : ${pole} › ${x.libelle}` : `Ligne budgétaire : ${pole} (classée au règlement)`;
}

export const LIBELLE_POLE: Readonly<Record<PoleNature, string>> = {
  ADMINISTRATION: "Budget de l'administration",
  PERSONNEL: "Personnel",
  OPERATIONS: "Budget Operations & Sales",
  MARKETING: "Budget Marketing",
  REGULATORY: "Budget Regulatory",
  INFORMATIQUE: "Informatique",
  IMPOTS: "Impôts & taxes",
  TRESORERIE: "Trésorerie",
};

/**
 * LA NATURE D'UNE DEMANDE DE PAIEMENT, JUGÉE — `null` si elle passe, sinon la phrase du refus (et son remède).
 * Une nature de circuit ne passe que sous SON rattachement (le bon de versement d'une information médicale).
 */
export function refusNatureDemande(code: string | null | undefined, rattachement?: string | null): string | null {
  if (!code) return REFUS_SANS_NATURE;
  const x = natureDepense(code);
  if (!x) return "Nature de dépense inconnue : choisissez-la dans la liste.";
  if (x.circuit && !(x.rattachement && x.rattachement === rattachement)) return `« ${x.libelle} » ne passe pas par une demande de paiement : ${x.circuit}`;
  return null;
}

/** Minuscules, sans accents ni ponctuation — la forme de la recherche. */
export function normaliserRecherche(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

/** La recherche de la liste courte : chaque mot tapé doit se trouver dans le libellé, la famille ou les mots-clés. */
export function rechercherNatures(q: string, liste: readonly NatureDepense[] = NATURES_DEMANDE): NatureDepense[] {
  const mots = normaliserRecherche(q).split(" ").filter(Boolean);
  if (mots.length === 0) return [...liste];
  return liste.filter((x) => {
    const foin = normaliserRecherche(`${x.libelle} ${FAMILLES_NATURE[x.famille] ?? ""} ${(x.motsCles ?? []).join(" ")}`);
    return mots.every((m) => foin.includes(m));
  });
}

/**
 * LA NATURE QU'ON PEUT PROPOSER pour un objet saisi (l'assistant la propose, la personne la confirme) : celle dont le plus
 * de mots-clés se trouvent dans le texte. `null` si rien ne ressort — on demande alors, on ne devine pas.
 */
export function proposerNature(texte: string): NatureDepense | null {
  const t = ` ${normaliserRecherche(texte)} `;
  let meilleure: { x: NatureDepense; score: number } | null = null;
  for (const x of NATURES_DEMANDE) {
    const score = (x.motsCles ?? []).filter((m) => t.includes(` ${m} `)).reduce((s, m) => s + m.length, 0);
    if (score > 0 && (!meilleure || score > meilleure.score)) meilleure = { x, score };
  }
  return meilleure?.x ?? null;
}

/** Les natures de la liste groupées par famille, dans l'ordre du référentiel — pour un `<select>` à groupes. */
export function naturesParFamille(liste: readonly NatureDepense[] = NATURES_DEMANDE): { famille: string; libelle: string; natures: NatureDepense[] }[] {
  const groupes = new Map<string, NatureDepense[]>();
  for (const x of liste) groupes.set(x.famille, [...(groupes.get(x.famille) ?? []), x]);
  return [...groupes].map(([famille, natures]) => ({ famille, libelle: FAMILLES_NATURE[famille] ?? famille, natures }));
}
