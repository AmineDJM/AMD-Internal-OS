/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JUSTIFICATIF OBLIGATOIRE (Super Admin, 24/11/2026) — la table, origine par origine.
 *
 * « Chaque paiement de n'importe quoi — BV, Regulatory, information médicale, Ad & Pro, salaire, n'importe quoi — doit
 * avoir une justification : une facture, une proforma, une lettre de demande, une fiche de paie… Tout. Tant qu'il n'y a
 * pas de justificatif, ça ne va même pas au centre de paiement, donc pas aux Finances. »
 *
 * ── POURQUOI UNE TABLE ──────────────────────────────────────────────────────────────────────
 *
 * Avant, chaque circuit décidait seul de ce qu'il exigeait, et à des moments différents : la demande de paiement à la
 * transmission, le poste Ad & Pro au dépôt, le congrès au règlement seulement, la paie et la caisse jamais. La règle
 * vit désormais à UN endroit, lu par l'unique émetteur d'ordres (`createExpenseOrder`), par le centre (alerte « sans
 * justificatif ») et par le règlement. Comme `COMPANY_OF_SOURCE`, elle est EXHAUSTIVE : `justificatif.test.ts` échoue si
 * une origine d'ordre n'y figure pas — un circuit ajouté sans sa ligne ne passe pas en silence.
 *
 * Pour chaque origine : les NATURES acceptées, les LIEUX où on les lit, et QUI la joint (le service à qui l'on dit
 * « Joindre le justificatif »). Une origine inconnue tombe sur `REGLE_PAR_DEFAUT` — exigeante, jamais exemptée.
 *
 * Module PUR — sans base ni session, importable par un écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * CE QUI JUSTIFIE UN PAIEMENT. Les natures de pièce du dossier (`PaymentPieceKind`), plus trois justificatifs qui ne
 * sont pas un fichier mais un FAIT de la plateforme, tracé et validé : le bon de versement, la demande signée par la
 * session du salarié, la pièce déjà validée au centre de validations.
 */
export type NatureJustificatif =
  | "INVOICE" | "PROFORMA" | "QUOTE" | "PURCHASE_ORDER" | "CONTRACT" | "REQUEST_LETTER"
  | "PAYROLL_STATE" | "PAYSLIP" | "PAYMENT_RECEIPT" | "CASH_VOUCHER" | "DECLARATION" | "PROOF"
  | "BON_DE_VERSEMENT" | "DEMANDE_SIGNEE" | "PIECE_VALIDEE";

export const LIBELLE_NATURE_JUSTIFICATIF: Record<NatureJustificatif, string> = {
  INVOICE: "facture",
  PROFORMA: "proforma",
  QUOTE: "devis",
  PURCHASE_ORDER: "bon de commande",
  CONTRACT: "contrat / convention",
  REQUEST_LETTER: "lettre de demande",
  PAYROLL_STATE: "état de paie",
  PAYSLIP: "fiche de paie",
  PAYMENT_RECEIPT: "quittance / bordereau",
  CASH_VOUCHER: "bon de remise",
  DECLARATION: "déclaration validée",
  PROOF: "pièce justificative",
  BON_DE_VERSEMENT: "bon de versement validé",
  DEMANDE_SIGNEE: "demande signée du salarié",
  PIECE_VALIDEE: "pièce validée au centre de validations",
};

/** OÙ ON LIT LE JUSTIFICATIF. */
export type LieuJustificatif =
  /** Une pièce du dossier de paiement : le dossier compagnon de l'ordre, ou la demande de paiement qui l'a émis. */
  | "PIECE_DOSSIER"
  /** Un fichier joint à l'ordre lui-même (dont la pièce jointe à sa naissance : état de paie, bon de remise…). */
  | "DOCUMENT_ORDRE"
  /** Un fichier de la fiche d'origine (congrès, sponsoring, avance, virement de paie, poste Ad & Pro…). */
  | "PIECE_SOURCE"
  /** Une pièce du registre Legal (facture, devis, BC, contrat) rattachée à l'ordre ou à la fiche, avec son fichier. */
  | "REGISTRE"
  /** La source EST le justificatif : la facture Legal, le bon de versement, la déclaration ou la pièce validées. */
  | "SOURCE";

export const LIBELLE_LIEU_JUSTIFICATIF: Record<LieuJustificatif, string> = {
  PIECE_DOSSIER: "pièce du dossier de paiement",
  DOCUMENT_ORDRE: "fichier joint à l'ordre",
  PIECE_SOURCE: "fichier de la fiche d'origine",
  REGISTRE: "registre Legal",
  SOURCE: "la fiche d'origine elle-même",
};

export interface RegleJustificatif {
  /** Les natures acceptées — une autre pièce (bon de livraison, photo) ne justifie pas le paiement. */
  natures: readonly NatureJustificatif[];
  /** Où on les lit. `DOCUMENT_ORDRE` et `PIECE_DOSSIER` valent partout : c'est là que « Joindre le justificatif » dépose. */
  lieux: readonly LieuJustificatif[];
  /** Tout fichier de la fiche d'origine compte (sa seule pièce possible est le justificatif : virement de paie, avance). */
  toutFichierDeLaSource?: boolean;
  /** Qui le joint — dit dans la notification et la ligne « Aujourd'hui ». */
  service: string;
}

const ACHAT: readonly NatureJustificatif[] = ["INVOICE", "PROFORMA", "QUOTE", "PURCHASE_ORDER", "CONTRACT", "REQUEST_LETTER", "PROOF"];
const PARTOUT: readonly LieuJustificatif[] = ["DOCUMENT_ORDRE", "PIECE_DOSSIER", "PIECE_SOURCE", "REGISTRE"];

/**
 * Les dépenses d'une opération Ad & Pro (sponsoring, congrès, événement, autre demande) — postes ou ordre global : une
 * pièce d'achat (le devis ou la proforma du poste direct, la facture du poste agence), ou la DÉCLARATION d'information
 * médicale validée par la Direction, dont la validation émet l'ordre.
 */
const OPERATION_AD_PRO: RegleJustificatif = {
  natures: [...ACHAT, "DECLARATION"], lieux: [...PARTOUT, "SOURCE"], service: "Le demandeur de l'opération",
};

/**
 * LES ORIGINES D'UN ORDRE DE DÉPENSE — toutes les `sourceType` passées à `createExpenseOrder`, plus `SANS_SOURCE` (la
 * remise de caisse d'avance, qui n'a pas de fiche d'origine).
 */
export type OrigineOrdre =
  | "PAYMENT_REQUEST" | "ADMIN_REQUEST" | "MEDICAL_INFO_DECLARATION" | "LEGAL_DOCUMENT" | "SPONSORING"
  | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER" | "PROMO_MATERIAL"
  | "CONSULTING_CONTRACT" | "REGULATORY_PRODUCT" | "PAYROLL" | "SALARY_ADVANCE" | "SANS_SOURCE";

export const JUSTIFICATIF_DE_SOURCE: Record<OrigineOrdre, RegleJustificatif> = {
  // La demande de paiement : la facture, le BC ou le devis qu'elle exige à la transmission ; le BON DE VERSEMENT de
  // l'information médicale, exempté de pièce (`payment-dossier.ts`), est lui-même son justificatif — validé en amont.
  PAYMENT_REQUEST: {
    natures: [...ACHAT, "PAYMENT_RECEIPT", "BON_DE_VERSEMENT"], lieux: ["PIECE_DOSSIER", "DOCUMENT_ORDRE", "SOURCE"],
    service: "Le demandeur",
  },
  // Le secrétariat : la facture / proforma déjà validée au centre de validations, ou une pièce de la demande.
  ADMIN_REQUEST: { natures: [...ACHAT, "PIECE_VALIDEE"], lieux: [...PARTOUT, "SOURCE"], service: "L'assistante de direction" },
  // La déclaration d'information médicale validée par la Direction : elle est la pièce du versement.
  MEDICAL_INFO_DECLARATION: { natures: ["DECLARATION", ...ACHAT], lieux: [...PARTOUT, "SOURCE"], service: "Le pharmacien responsable" },
  // La facture Legal envoyée au règlement : la source EST la facture.
  LEGAL_DOCUMENT: { natures: ["INVOICE", "QUOTE", "PURCHASE_ORDER", "CONTRACT"], lieux: [...PARTOUT, "SOURCE"], service: "Le demandeur" },
  SPONSORING: OPERATION_AD_PRO,
  // Une prise en charge : le devis retenu (son PDF), la facture de l'assistante, ou la déclaration validée.
  CONGRESS_NATIONAL: { ...OPERATION_AD_PRO, service: "L'assistante de direction" },
  CONGRESS_INTERNATIONAL: { ...OPERATION_AD_PRO, service: "L'assistante de direction" },
  EVENT: OPERATION_AD_PRO,
  AD_PRO_OTHER: OPERATION_AD_PRO,
  // Le matériel promotionnel : le BC transmis à l'agence (bordereau) ou sa facture.
  PROMO_MATERIAL: { natures: [...ACHAT, "PAYMENT_RECEIPT", "DECLARATION"], lieux: [...PARTOUT, "SOURCE"], service: "L'information médicale" },
  CONSULTING_CONTRACT: { natures: ACHAT, lieux: PARTOUT, service: "Le demandeur du contrat" },
  // Le BV Regulatory (ancien circuit) : la proforma / le courrier de l'ANPP déposé sur l'étape de demande.
  REGULATORY_PRODUCT: { natures: [...ACHAT, "PAYMENT_RECEIPT"], lieux: PARTOUT, service: "Le Regulatory" },
  // La paie : l'état de paie, exigé à l'envoi au centre (`envoyerPaieAuCentre`) et rangé sur le virement.
  PAYROLL: { natures: ["PAYROLL_STATE", "PAYSLIP"], lieux: ["DOCUMENT_ORDRE", "PIECE_DOSSIER", "PIECE_SOURCE"], toutFichierDeLaSource: true, service: "Les RH" },
  // L'avance sur salaire : la demande du salarié, faite par SA session (signée de fait), ou la demande signée scannée.
  SALARY_ADVANCE: {
    natures: ["DEMANDE_SIGNEE", "REQUEST_LETTER", "PROOF"], lieux: ["DOCUMENT_ORDRE", "PIECE_DOSSIER", "PIECE_SOURCE", "SOURCE"],
    toutFichierDeLaSource: true, service: "Les RH",
  },
  // La remise de caisse d'avance : le bon de remise, joint à la remise.
  SANS_SOURCE: { natures: ["CASH_VOUCHER", "REQUEST_LETTER", "PROOF"], lieux: ["DOCUMENT_ORDRE", "PIECE_DOSSIER"], service: "Les Moyens généraux" },
};

/** Une origine inconnue de la table : exigeante (une pièce d'achat), jamais exemptée. */
export const REGLE_PAR_DEFAUT: RegleJustificatif = { natures: ACHAT, lieux: PARTOUT, service: "Le demandeur" };

export function regleDeJustificatif(sourceType: string | null | undefined): RegleJustificatif {
  if (!sourceType) return JUSTIFICATIF_DE_SOURCE.SANS_SOURCE;
  return (JUSTIFICATIF_DE_SOURCE as Record<string, RegleJustificatif>)[sourceType] ?? REGLE_PAR_DEFAUT;
}

/** Les origines couvertes — lues par le test d'exhaustivité. */
export const ORIGINES_JUSTIFIEES = Object.keys(JUSTIFICATIF_DE_SOURCE) as OrigineOrdre[];

/**
 * LA NATURE D'UN FICHIER, lue sur sa catégorie de document. Une catégorie absente (photo, programme, rapport) ne justifie
 * aucun paiement : elle dit ce qu'on a fait, pas ce qu'on doit.
 */
export const NATURE_DE_CATEGORIE: Readonly<Record<string, NatureJustificatif>> = {
  INVOICE: "INVOICE", PROFORMA: "PROFORMA", QUOTE: "QUOTE", SUPPLIER_OFFER: "QUOTE", PURCHASE_ORDER: "PURCHASE_ORDER",
  CONVENTION: "CONTRACT", REQUEST_LETTER: "REQUEST_LETTER", SUBMISSION_LETTER: "REQUEST_LETTER",
  PAYMENT_SLIP: "PAYMENT_RECEIPT", PAYMENT_RECEIPT: "PAYMENT_RECEIPT", BV_RECEIPT: "PAYMENT_RECEIPT", SUPPORTING_DOC: "PROOF",
};

/** La catégorie de document où se range un justificatif joint (les natures sans catégorie propre vont en « pièce justificative »). */
export function categorieDeNature(n: NatureJustificatif): string {
  const propre: Partial<Record<NatureJustificatif, string>> = {
    INVOICE: "INVOICE", PROFORMA: "PROFORMA", QUOTE: "QUOTE", PURCHASE_ORDER: "PURCHASE_ORDER", CONTRACT: "CONVENTION",
    REQUEST_LETTER: "REQUEST_LETTER", PAYMENT_RECEIPT: "PAYMENT_RECEIPT",
  };
  return propre[n] ?? "SUPPORTING_DOC";
}

/** La nature d'une pièce du registre Legal. */
export const NATURE_DE_PIECE_LEGAL: Readonly<Record<string, NatureJustificatif>> = {
  INVOICE: "INVOICE", QUOTE: "QUOTE", PURCHASE_ORDER: "PURCHASE_ORDER", CONTRACT: "CONTRACT", AGREEMENT: "CONTRACT", AMENDMENT: "CONTRACT",
};

/** Les natures d'une pièce de dossier (`PaymentPieceKind`) qui peuvent justifier — le bon de livraison et « autre » non. */
export const KINDS_JUSTIFIANTS: readonly string[] = [
  "INVOICE", "PURCHASE_ORDER", "QUOTE", "CONTRACT", "PROOF", "PROFORMA", "REQUEST_LETTER",
  "PAYROLL_STATE", "PAYSLIP", "PAYMENT_RECEIPT", "CASH_VOUCHER", "DECLARATION",
];

/** Une nature est-elle acceptée pour cette origine ? */
export function natureAcceptee(regle: RegleJustificatif, nature: string | null | undefined): nature is NatureJustificatif {
  return nature != null && (regle.natures as readonly string[]).includes(nature);
}

/** Ce que l'on dit au service qui doit joindre la pièce — la phrase nomme ce qu'on attend, pas seulement ce qui manque. */
export function phraseJustificatifAttendu(sourceType: string | null | undefined): string {
  const r = regleDeJustificatif(sourceType);
  const natures = r.natures.filter((n) => n !== "PROOF").slice(0, 4).map((n) => LIBELLE_NATURE_JUSTIFICATIF[n]);
  return `Joignez ${natures.length > 1 ? `${natures.slice(0, -1).join(", ")} ou ${natures[natures.length - 1]}` : natures[0] ?? "le justificatif"} `
    + "au dossier de paiement : sans justificatif, le paiement n'entre pas au centre de paiement.";
}

/** Le titre de la ligne « Aujourd'hui » et de la notification. */
export const titreJoindreJustificatif = (ordre: { reference: string; label: string }) => `Joindre le justificatif — ${ordre.reference} · ${ordre.label}`;

/** Le refus du règlement d'un ordre né sous la règle, dont le justificatif a disparu (pièce refusée, fichier retiré). */
export const REFUS_REGLEMENT_SANS_JUSTIFICATIF =
  "Justificatif manquant : la pièce qui justifie ce paiement a été refusée ou retirée. Demandez-la au demandeur (elle se joint "
  + "au dossier de paiement) avant de régler.";

/** Le dépôt d'une pièce sur un dossier compagnon SOLDÉ : régulariser, oui ; remplacer ou retirer, jamais. */
export function refusDeDepotDePiece(d: { status: string; origin: string | null | undefined; remplace: boolean }): string | null {
  const clos = d.status === "APPROVED" || d.status === "REJECTED" || d.status === "CANCELLED";
  if (!clos) return null;
  if (d.status === "APPROVED" && d.origin === "EXPENSE_ORDER" && !d.remplace) return null;
  return d.status === "APPROVED" && d.origin === "EXPENSE_ORDER"
    ? "Ce paiement est soldé : on peut encore y AJOUTER un justificatif pour régulariser, jamais en remplacer ni en retirer un."
    : "Ce dossier est clos : il ne reçoit plus de pièce.";
}

/** Le dépôt est-il une régularisation (pièce ajoutée à un paiement déjà soldé) ? */
export const estRegularisation = (status: string, origin: string | null | undefined) => status === "APPROVED" && origin === "EXPENSE_ORDER";
