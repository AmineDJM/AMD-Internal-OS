import { userCan } from "@/lib/rbac";
import { canManageLetterheads } from "@/platform/in-process/office";
import type { OpMeta } from "./types";

/**
 * CATALOGUE DES OPS — Vague 8 : fichiers first-class (les 8 derniers trous).
 *
 * Morceau de `OPS_CATALOG` (`../catalog.ts`), recomposé dans l'ordre d'origine : l'ordre des ops
 * fait partie du contrat (goldens, prompt de l'IA). Métadonnées pures, sans Prisma ni actions.
 */
export const OPS_FICHIERS: OpMeta[] = [
  // ───────────── VAGUE 8 — FICHIERS FIRST-CLASS (les 8 derniers trous) ─────────────
  {
    tool: "task_operation", op: "upload_document", module: "Pièces jointes",
    uiLabel: "Joindre un fichier à une fiche",
    aliases: ["joins le fichier au dossier", "ajoute la pièce jointe à la fiche", "mets ce document sur le sponsoring"],
    risk: "NORMAL",
    summary: "Joint un fichier du Drive (nommé) à la bibliothèque d'un objet métier (dossier, sponsoring, événement…) — le contenu est copié, le fichier du Drive reste intact.",
    gate: () => true,
    gateNote: "droit de TÉLÉVERSEMENT sur l'objet visé (revérifié par l'action)",
    covers: ["document-actions:uploadDocument"],
  },
  {
    tool: "finance_operation", op: "import_transactions", module: "Finances",
    uiLabel: "Importer des mouvements (CSV)",
    aliases: ["importe le csv de trésorerie", "charge les mouvements depuis le fichier"],
    risk: "SENSITIVE",
    summary: "Importe des mouvements de trésorerie depuis un CSV (fichier du Drive ou lignes collées) — un mouvement par ligne exploitable, références FIN- attribuées à la suite.",
    gate: (u) => userCan(u, "FINANCES", "CREATE"),
    covers: ["finance-actions:importTransactions"],
  },
  {
    tool: "finance_operation", op: "spend_from_petty_cash", module: "Moyens généraux",
    uiLabel: "Dépense de caisse (avec pièce)",
    aliases: ["impute la dépense à ma caisse", "enregistre l'achat sur la caisse d'avance"],
    risk: "SENSITIVE",
    summary: "Impute une dépense à VOTRE caisse d'avance avec la pièce OBLIGATOIRE (facture / bon scanné, fichier du Drive) — solde recontrôlé par l'action.",
    gate: () => true,
    gateNote: "détenteur de la caisse, ou vue globale (revérifié par l'action)",
    covers: ["petty-cash-actions:spendFromPettyCash"],
  },
  {
    tool: "finance_operation", op: "add_payment_piece", module: "Centre de paiement",
    uiLabel: "Ajouter une pièce à une demande de paiement",
    aliases: ["ajoute la facture à la demande de paiement", "dépose la pièce sur le dossier pay"],
    risk: "NORMAL",
    summary: "Ajoute une pièce (fichier du Drive) à une demande de paiement — entre dans le circuit de contrôle des pièces ; un dossier clos n'en reçoit plus.",
    gate: () => true,
    gateNote: "demandeur du dossier ou Finances (revérifié par l'action)",
    covers: ["payment-request-actions:addPaymentPiece"],
  },
  {
    tool: "medical_operation", op: "create_directory_column", module: "Annuaire",
    uiLabel: "Ajouter une colonne à un annuaire",
    aliases: ["ajoute une colonne dernier congrès à l'annuaire des infectiologues", "nouvelle colonne dans l'annuaire"],
    risk: "NORMAL",
    summary: "Ajoute une colonne PROPRE à un annuaire de praticiens (texte, nombre, date ou liste de choix) — les autres annuaires ne la voient pas.",
    gate: (u) => userCan(u, "MEDICAL", "UPDATE"),
    covers: ["medical-directory-crud-actions:createDirectoryColumn"],
  },
  {
    tool: "medical_operation", op: "update_directory_column", module: "Annuaire",
    uiLabel: "Renommer / retyper une colonne d'annuaire",
    aliases: ["renomme la colonne statut de l'annuaire", "change le type de la colonne"],
    risk: "NORMAL",
    summary: "Renomme une colonne d'annuaire ou change son type — les valeurs déjà saisies sont conservées (la clé technique ne bouge pas).",
    gate: (u) => userCan(u, "MEDICAL", "UPDATE"),
    covers: ["medical-directory-crud-actions:updateDirectoryColumn"],
  },
  {
    tool: "medical_operation", op: "delete_directory_column", module: "Annuaire",
    uiLabel: "Retirer une colonne d'annuaire",
    aliases: ["supprime la colonne dernier congrès", "enlève cette colonne de l'annuaire"],
    risk: "SENSITIVE",
    summary: "Retire une colonne de la grille d'un annuaire. Les valeurs déjà saisies sont CONSERVÉES : recréer la colonne sous le même nom les retrouve.",
    gate: (u) => userCan(u, "MEDICAL", "UPDATE"),
    covers: ["medical-directory-crud-actions:deleteDirectoryColumn"],
  },
  {
    tool: "medical_operation", op: "import_directory_sheet", module: "Annuaire",
    uiLabel: "Importer l'annuaire (Excel / CSV)",
    aliases: ["importe le fichier excel des médecins", "charge l'annuaire depuis le classeur"],
    risk: "SENSITIVE",
    summary: "Importe des praticiens depuis un classeur Excel / CSV du Drive — une fiche par ligne avec « Nom » ; colonnes reconnues rapportées après import.",
    gate: (u) => userCan(u, "MEDICAL", "CREATE"),
    covers: ["medical-directory-actions:importDirectorySheet"],
  },
  {
    tool: "medical_info_operation", op: "fulfill_doc_request", module: "Information médicale",
    uiLabel: "Déposer la pièce demandée",
    aliases: ["dépose la pièce qu'on m'a demandée", "réponds à la demande de document"],
    risk: "NORMAL",
    summary: "Dépose la pièce qui VOUS a été demandée sur une déclaration d'information médicale (fichier du Drive) — clôt la demande et notifie le demandeur.",
    gate: () => true,
    gateNote: "la personne sollicitée, ou un gestionnaire du module (revérifié par l'action)",
    covers: ["medical-info-actions:fulfillDocRequest"],
  },
  {
    tool: "pch_operation", op: "analyze_tender_document", module: "PCH — Marchés",
    uiLabel: "Lire l'appel d'offres (IA)",
    aliases: ["analyse le pdf de l'appel d'offres", "lis le document du marché pch"],
    risk: "SENSITIVE",
    summary: "Lecture IA du document d'un appel d'offres PCH (PDF / image du Drive) : son texte est lu tel quel, l'OCR ne sert qu'aux pages scannées — une nouvelle lecture REMPLACE les lignes des lectures précédentes que personne n'a touchées ; opération facturée (IA).",
    gate: (u) => userCan(u, "PCH", "UPDATE"),
    covers: ["pch-tender-line-actions:analyzeTenderDocument"],
  },
  {
    tool: "org_operation", op: "upload_letterhead", module: "Bureautique",
    uiLabel: "Déposer un papier en-tête",
    aliases: ["dépose le papier en-tête word", "mets à jour l'en-tête de la société"],
    risk: "SENSITIVE",
    summary: "Dépose un papier en-tête (Word / Excel / PowerPoint, fichier du Drive à l'extension exacte) — servira à TOUS les documents « avec en-tête » créés ensuite.",
    gate: (u) => canManageLetterheads(u),
    gateNote: "assistante de direction ou Super Admin (revérifié par l'action)",
    covers: ["letterhead-actions:uploadLetterhead"],
  },
];
