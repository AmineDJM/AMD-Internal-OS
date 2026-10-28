/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CATALOGUE DES FAITS (mandat 5 §37) — pur.
 *
 * Un fait métier a un TYPE canonique, un domaine émetteur, des sources qui le produisent et les
 * entités qu'il concerne d'ordinaire. Ce catalogue est ce qui rend `WAIT_EVENT` quasi universel :
 * le planificateur y lit ce qu'une mission peut attendre (une signature, un paiement, une commande
 * SAP, une pièce, un e-mail, un appel d'offres…), l'ingestion y ramène ce qu'un fournisseur nomme
 * à sa façon (`envelope-completed` → `SIGNATURE_COMPLETED`), et le registre (`BusinessEvent`)
 * reste une chaîne libre : un fait inconnu entre quand même, sous son nom brut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface TypeFait {
  type: string;
  libelle: string;
  /** Le domaine émetteur par défaut (le « d'où ça vient » du registre). */
  sourceDomain: string;
  /** Les sources qui le produisent : `erp`, `drive`, `gmail`, `docusign`, `sap`, `hubspot`, `pch`, `iqvia`, `generic`… */
  sources: readonly string[];
  /** Les entités concernées d'ordinaire, en types du registre (`LEGAL_DOCUMENT`, `PCH_TENDER`…). */
  entites: readonly string[];
  description: string;
}

export const CATALOGUE: readonly TypeFait[] = [
  // ── L'ERP (l'audit devient un fait — `events/from-audit.ts`) ──
  { type: "PIECE_DEPOSEE", libelle: "Pièce déposée (enrichissement)", sourceDomain: "ENRICHISSEMENT", sources: ["erp", "drive"], entites: ["DRIVE_NODE", "AD_PRO_ITEM", "EMPLOYEE", "LEGAL_DOCUMENT", "RECRUITMENT_CANDIDATE"], description: "Une pièce est entrée dans l'ERP par un goulot de dépôt : son empreinte, son blob et ses rattachements — jamais son contenu. Elle part en file d'enrichissement des fiches." },
  { type: "DOCUMENT_UPLOADED", libelle: "Pièce déposée", sourceDomain: "DRIVE", sources: ["erp", "drive"], entites: ["DRIVE_NODE", "LEGAL_DOCUMENT", "CONSULTING_CONTRACT"], description: "Une pièce a été déposée dans le Drive ou sur un dossier." },
  { type: "VALIDATION_REQUIRED", libelle: "Validation demandée", sourceDomain: "VALIDATIONS", sources: ["erp"], entites: ["VALIDATION_REQUEST"], description: "Un circuit de validation attend une décision." },
  { type: "VALIDATION_APPROVED", libelle: "Validation accordée", sourceDomain: "VALIDATIONS", sources: ["erp"], entites: ["VALIDATION_REQUEST", "EXPENSE_ORDER", "PAYMENT_REQUEST"], description: "Une demande a été validée." },
  { type: "VALIDATION_REFUSED", libelle: "Validation refusée", sourceDomain: "VALIDATIONS", sources: ["erp"], entites: ["VALIDATION_REQUEST"], description: "Une demande a été refusée." },
  { type: "TASK_COMPLETED", libelle: "Tâche terminée", sourceDomain: "tasks", sources: ["erp"], entites: ["TASK"], description: "Une tâche est passée à faite." },
  { type: "PAYMENT_RECEIVED", libelle: "Paiement reçu", sourceDomain: "FINANCES", sources: ["erp", "sap", "generic"], entites: ["SALE", "INVOICE"], description: "Un règlement client a été encaissé." },
  { type: "PAYMENT_ISSUED", libelle: "Paiement émis", sourceDomain: "FINANCES", sources: ["erp", "sap"], entites: ["EXPENSE_ORDER", "PAYMENT_REQUEST"], description: "Un paiement fournisseur a été émis." },
  { type: "INVOICE_RECEIVED", libelle: "Facture reçue", sourceDomain: "FINANCES", sources: ["sap", "gmail", "generic"], entites: ["EXPENSE_ORDER", "SUPPLIER"], description: "Une facture fournisseur est arrivée." },
  { type: "DELIVERY_COMPLETED", libelle: "Livraison faite", sourceDomain: "LOGISTICS", sources: ["erp", "generic"], entites: ["SALE"], description: "Une livraison a été effectuée." },
  { type: "REGULATORY_STATUS_CHANGED", libelle: "Statut réglementaire changé", sourceDomain: "REGULATORY", sources: ["erp"], entites: ["REGULATORY_PRODUCT", "REGULATORY_DOSSIER"], description: "Le statut d'un produit ou d'un dossier réglementaire a changé." },
  { type: "CONTRACT_RECORDED", libelle: "Contrat enregistré", sourceDomain: "ADPRO_CONSULTING", sources: ["erp"], entites: ["CONSULTING_CONTRACT"], description: "Un contrat a été enregistré." },
  { type: "CONTRACT_SIGNED", libelle: "Contrat signé", sourceDomain: "LEGAL", sources: ["erp", "docusign", "signature"], entites: ["LEGAL_DOCUMENT", "CONSULTING_CONTRACT"], description: "Un contrat porte sa signature." },
  { type: "LEGAL_DOCUMENT_REGISTERED", libelle: "Pièce légale au registre", sourceDomain: "LEGAL", sources: ["erp"], entites: ["LEGAL_DOCUMENT"], description: "Un document légal est entré au registre." },
  { type: "TENDER_OPENED", libelle: "Appel d'offres ouvert", sourceDomain: "PCH", sources: ["erp", "pch"], entites: ["PCH_TENDER"], description: "Un appel d'offres est publié ou ouvert." },
  { type: "TENDER_STATUS_CHANGED", libelle: "Appel d'offres : statut changé", sourceDomain: "PCH", sources: ["erp", "pch"], entites: ["PCH_TENDER"], description: "Le statut d'un appel d'offres a changé." },
  { type: "TENDER_AWARDED", libelle: "Appel d'offres attribué", sourceDomain: "PCH", sources: ["pch", "erp"], entites: ["PCH_TENDER"], description: "Un lot a été attribué." },
  // ── Les communications ──
  { type: "EMAIL_RECEIVED", libelle: "E-mail reçu", sourceDomain: "comms", sources: ["gmail", "microsoft", "mail"], entites: ["EMAIL", "EMAIL_THREAD"], description: "Un e-mail humain est arrivé (jamais un accusé automatique)." },
  { type: "MESSAGE_RECEIVED", libelle: "Message reçu", sourceDomain: "messaging", sources: ["messaging"], entites: ["CONVERSATION"], description: "Un message interne est arrivé." },
  { type: "MEETING_SCHEDULED", libelle: "Réunion planifiée", sourceDomain: "calendar", sources: ["erp", "google", "microsoft"], entites: ["MEETING"], description: "Une réunion a été mise à l'agenda." },
  { type: "MEETING_ENDED", libelle: "Réunion terminée", sourceDomain: "calendar", sources: ["erp"], entites: ["MEETING"], description: "Une réunion est close, ses notes peuvent être relues." },
  // ── Les systèmes externes (webhooks — `platform/in-process/events/ingestion.ts`) ──
  { type: "SIGNATURE_SENT", libelle: "Envoyé à signer", sourceDomain: "LEGAL", sources: ["docusign", "signature"], entites: ["LEGAL_DOCUMENT"], description: "Une enveloppe a été envoyée au signataire." },
  { type: "SIGNATURE_STEP", libelle: "Un signataire a signé", sourceDomain: "LEGAL", sources: ["docusign", "signature"], entites: ["LEGAL_DOCUMENT"], description: "Un des signataires a signé ; l'enveloppe n'est pas forcément complète." },
  { type: "SIGNATURE_COMPLETED", libelle: "Signature complète", sourceDomain: "LEGAL", sources: ["docusign", "signature"], entites: ["LEGAL_DOCUMENT", "CONSULTING_CONTRACT"], description: "Tous les signataires ont signé : le document est exécuté." },
  { type: "SIGNATURE_DECLINED", libelle: "Signature refusée ou annulée", sourceDomain: "LEGAL", sources: ["docusign", "signature"], entites: ["LEGAL_DOCUMENT"], description: "Un signataire a refusé, ou l'enveloppe a été annulée." },
  { type: "PURCHASE_ORDER_CREATED", libelle: "Commande d'achat créée (SAP)", sourceDomain: "FINANCES", sources: ["sap"], entites: ["EXPENSE_ORDER", "SUPPLIER"], description: "Une commande d'achat a été créée dans SAP." },
  { type: "PURCHASE_ORDER_CHANGED", libelle: "Commande d'achat modifiée (SAP)", sourceDomain: "FINANCES", sources: ["sap"], entites: ["EXPENSE_ORDER", "SUPPLIER"], description: "Une commande d'achat SAP a changé (statut, montant, livraison)." },
  { type: "CRM_DEAL_UPDATED", libelle: "Transaction CRM mise à jour", sourceDomain: "SALES", sources: ["hubspot"], entites: ["COMPANY"], description: "Une transaction HubSpot a changé d'étape, de montant ou de propriétaire." },
  { type: "CRM_CONTACT_UPDATED", libelle: "Contact CRM mis à jour", sourceDomain: "SALES", sources: ["hubspot"], entites: ["PERSON", "COMPANY"], description: "Un contact HubSpot a été créé ou modifié." },
  { type: "MARKET_DATA_UPDATED", libelle: "Données de marché publiées", sourceDomain: "REGULATORY", sources: ["iqvia"], entites: ["PRODUCT"], description: "IQVIA a publié une nouvelle période de ventes de marché." },
  { type: "SUPPLIER_DELIVERY_UPDATED", libelle: "Livraison fournisseur mise à jour", sourceDomain: "LOGISTICS", sources: ["sap", "generic"], entites: ["SUPPLIER", "EXPENSE_ORDER"], description: "Un fournisseur a expédié, retardé ou livré." },
  { type: "WEBHOOK_RECEIVED", libelle: "Fait externe (type non catalogué)", sourceDomain: "external", sources: ["generic"], entites: [], description: "Un système externe a envoyé un fait dont le type n'est pas au catalogue : il entre sous son nom brut." },
];

export const TYPES_CONNUS: ReadonlySet<string> = new Set(CATALOGUE.map((t) => t.type));
export const estTypeConnu = (t: string): boolean => TYPES_CONNUS.has(normaliserType(t));
export const typesPour = (source: string): string[] => CATALOGUE.filter((t) => t.sources.includes(source)).map((t) => t.type);
export const catalogueDe = (type: string): TypeFait | null => CATALOGUE.find((t) => t.type === normaliserType(type)) ?? null;

/** Un type en MAJUSCULES_SOULIGNÉES, quelle que soit la façon dont un fournisseur l'écrit. */
export function normaliserType(brut: string): string {
  return brut.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

/** La ligne que le planificateur lit : ce qu'une mission peut attendre. */
export const RESUME_POUR_PLANNER = CATALOGUE.map((t) => t.type).join(", ");
