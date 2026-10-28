import type { Prisma } from "@prisma/client";
import {
  userCan, scopeRegulatory, scopeSales, scopeMedicalDoctors, scopeMedicalVisits,
  scopeAdminRequests, scopeMedicalInfo, type SessionUser, type Module,
} from "@/lib/rbac";
import { polesLisibles } from "@/lib/lecteurs/consulting";
import { hasScope, type Scope } from "@/lib/api/scopes";

/**
 * REGISTRE DES OBJETS MÉTIER exposés par l'API.
 *
 * Une entrée par objet, et UNE SEULE : elle dit le modèle Prisma, le module qui le gouverne, la
 * portée à appliquer (celle de l'ERP, pas une copie), les champs lisibles, ceux sur lesquels on
 * cherche, et les objets liés. Toutes les routes génériques — liste, détail, recherche,
 * historique, pièces jointes, objets liés, actions disponibles — se servent de ce registre.
 *
 * C'est ce qui rend l'exhaustivité ATTEIGNABLE : couvrir un objet de plus, c'est ajouter une
 * entrée déclarative, pas écrire six routes. Et c'est ce qui la rend VÉRIFIABLE : un script
 * compare ce registre à la carte de l'ERP et signale ce qui manque.
 *
 * La portée n'est JAMAIS réimplémentée ici : `scope` renvoie la fonction déjà utilisée par les
 * écrans. Un dossier verrouillé, un dossier d'un autre département, une visite qui ne nous
 * appartient pas restent invisibles par API exactement comme à l'écran.
 */

export interface EntityDef {
  /** Nom exposé par l'API — stable, en minuscules, au singulier. */
  name: string;
  /** Nom du modèle Prisma correspondant (délégué `prisma[model]`). */
  model: Prisma.ModelName;
  /** Module RBAC qui gouverne l'objet. */
  module: Module;
  label: string;
  description: string;
  /** Portée par ligne — LA fonction de l'ERP, pas une copie. `null` = pas de filtre par ligne. */
  scope: ((user: SessionUser) => Record<string, unknown>) | null;
  /**
   * LES AUTRES MODULES QUI OUVRENT CET OBJET, quand le module qui garde une ligne dépend de la
   * LIGNE (§118.150 : un contrat de consulting est gardé par Ad & Pro ou par les RH selon son
   * pôle). Ouvrir l'objet n'ouvre pas toutes ses lignes : `scope` doit alors borner chacune au
   * module de la personne. Sans ce champ, les RH — qui voient ces contrats à l'écran — se
   * verraient refuser l'objet entier par l'API et par Adam : un « je ne peux pas » écrit dans
   * le registre (§118.63).
   */
  lisiblePar?: Module[];
  /** Champs rendus en liste (courts) — une liste de 200 objets ne charge pas tout. */
  listFields: string[];
  /** Champs rendus en détail. Vide = tous les champs scalaires du modèle. */
  detailFields?: string[];
  /** Champs texte sur lesquels porte la recherche plein texte. */
  searchFields: string[];
  /** Champ portant la référence lisible (« REG-2026-001 »), s'il existe. */
  referenceField?: string;
  /** Champ portant le statut de workflow, s'il existe. */
  statusField?: string;
  /** Type d'entité au sens `Document.entityType` / `AuditLog.entityType`, s'il existe. */
  entityType?: string;
  /** Objets liés exposés par `/related` : nom → champ de relation Prisma. */
  related?: Record<string, string>;
  /**
   * LA PROJECTION D'UNE RELATION (audit 27/10, reste de SA-05) : les champs rendus pour chaque objet lié, quand
   * l'objet lié porte des données personnelles. Sans elle, `/related` rendait la ligne entière — les membres d'un
   * département arrivaient avec adresse et téléphone, que la fiche du salarié ne montre qu'aux RH.
   */
  champsRelation?: Record<string, string[]>;
  /** Tri par défaut. */
  orderBy?: Record<string, "asc" | "desc">;
  /** L'objet porte-t-il un circuit de validation exposé par `/workflow` ? */
  workflow?: "regulatory" | "adpro" | "leave" | "validation" | null;
  /**
   * LA PORTÉE D'API QUE L'OBJET EXIGE EN PLUS de la lecture (audit 27/10, SA-15). Les comptes et le journal d'audit
   * sont des objets d'administration : le droit `ADMIN:VIEW` de la personne au nom de qui l'agent agit ne suffit pas,
   * le CLIENT doit aussi porter `erp.admin` — sans quoi une clé `erp.read` listait comptes et journal. Lue par toutes
   * les routes de lecture (`porteeManquante`).
   */
  porteeRequise?: Scope;
}

/** Portée « le module suffit » : l'objet n'a pas de filtre par ligne, seul le droit compte. */
const moduleOnly = null;

export const ENTITIES: EntityDef[] = [
  {
    name: "regulatory_dossier",
    model: "RegulatoryProduct",
    module: "REGULATORY",
    label: "Dossier réglementaire",
    description:
      "Un produit (DCI, dosage, forme, conditionnement) suivi jusqu'à sa décision d'enregistrement (DE) auprès de l'ANPP. "
      + "C'est l'objet central du module Regulatory : il porte le workflow en 17 étapes, le processus officiel ANPP, "
      + "les variations de fabrication, les pièces et les demandes de bon de virement.",
    scope: scopeRegulatory,
    listFields: ["id", "reference", "dci", "brandName", "dosage", "dosageUnit", "pharmaceuticalForm", "packaging", "status", "priority", "manufacturingStatus", "responsibleId", "companyId", "targetDate", "updatedAt"],
    searchFields: ["reference", "dci", "brandName", "therapeuticClass", "comments"],
    referenceField: "reference",
    statusField: "status",
    entityType: "REGULATORY_PRODUCT",
    related: { steps: "steps", variations: "variations", stockMovements: "stockMovements", stockSnapshots: "stockSnapshots" },
    detailFields: undefined,
    orderBy: { updatedAt: "desc" },
    workflow: "regulatory",
  },
  {
    name: "supplier",
    model: "Supplier",
    module: "REGULATORY",
    label: "Fournisseur / laboratoire partenaire",
    description: "Laboratoire ou fournisseur rattaché à des dossiers réglementaires ; peut disposer d'un accès au portail externe.",
    scope: moduleOnly,
    listFields: ["id", "name", "country", "contactEmail", "active", "createdAt"],
    searchFields: ["name", "country", "contactEmail", "notes"],
    related: { products: "products" },
    orderBy: { name: "asc" },
  },
  {
    name: "company",
    model: "Company",
    // Lue par quiconque a un espace de travail : l'entité cloisonne presque tout, la connaître
    // est un préalable, pas un privilège. (Elle était rattachée au « tableau de bord », qui
    // n'existe plus.)
    module: "WORKSPACE",
    label: "Entité du groupe",
    description: "Société du groupe (Adventum, Pharmagène…). L'entité cloisonne la plupart des objets de la plateforme.",
    scope: moduleOnly,
    listFields: ["id", "name", "shortName", "color", "isActive", "sortOrder"],
    searchFields: ["name", "shortName"],
    orderBy: { sortOrder: "asc" },
  },
  {
    name: "department",
    model: "Department",
    module: "RH",
    label: "Département",
    description: "Nœud de l'organigramme (N niveaux). Porte les budgets, la caisse d'avance et la chaîne du N+1.",
    scope: moduleOnly,
    listFields: ["id", "name", "code", "parentId", "companyId", "headId", "deputyId", "description"],
    searchFields: ["name", "code"],
    related: { children: "children", members: "members", budgets: "budgets", pettyCash: "pettyCash" },
    // Les membres : ce que la LISTE des employés rend, pas leur fiche (adresse, téléphone, pièces d'identité).
    champsRelation: { members: ["id", "fullName", "position", "departmentId", "companyId", "isActive", "hireDate", "contractType", "userId"] },
    orderBy: { name: "asc" },
  },
  {
    name: "employee",
    model: "Employee",
    module: "RH",
    label: "Employé",
    description: "Fiche du personnel : contrat, département, congés, paie, documents.",
    scope: moduleOnly,
    listFields: ["id", "fullName", "position", "departmentId", "companyId", "isActive", "hireDate", "contractType", "userId"],
    searchFields: ["fullName", "position", "email", "notes"],
    entityType: "EMPLOYEE",
    related: { leaveRequests: "leaveRequests", payrolls: "payrolls", documents: "documents" },
    orderBy: { fullName: "asc" },
  },
  {
    name: "leave_request",
    model: "LeaveRequest",
    module: "RH",
    label: "Demande de congé",
    description: "Congé soumis à la chaîne de validation à trois étages : responsable → ressources humaines → direction.",
    scope: moduleOnly,
    listFields: ["id", "employeeId", "type", "startDate", "endDate", "days", "status", "stage", "managerId", "createdAt"],
    searchFields: ["reason"],
    statusField: "status",
    entityType: "LEAVE_REQUEST",
    orderBy: { createdAt: "desc" },
    workflow: "leave",
  },
  {
    name: "admin_request",
    model: "AdministrativeRequest",
    module: "ADMIN_REQUESTS",
    label: "Demande au bureau du secrétariat",
    description: "Demande d'achat, de mission, de course ou de prestation traitée par l'assistante de direction, avec son circuit de validation et son imputation budgétaire à la clôture.",
    scope: scopeAdminRequests,
    listFields: ["id", "reference", "type", "subtype", "title", "status", "priority", "requesterId", "assignedToId", "validatorId", "departmentId", "deadline", "companyId", "createdAt"],
    searchFields: ["reference", "title", "description"],
    referenceField: "reference",
    statusField: "status",
    entityType: "ADMIN_REQUEST",
    related: { approvals: "approvals", missions: "missions", budgetExpenses: "budgetExpenses" },
    orderBy: { createdAt: "desc" },
    workflow: "validation",
  },
  {
    name: "sponsoring",
    model: "SponsoringRequest",
    module: "SPONSORING",
    label: "Demande de sponsoring",
    description: "Demande de parrainage instruite par le circuit Ad & Pro (National Sales → Direction Marketing → Direction), avec ses postes de dépense et son ordre de paiement.",
    scope: moduleOnly,
    listFields: ["id", "reference", "institution", "doctor", "type", "status", "amountRequested", "amountGranted", "companyId", "requestDate", "createdAt"],
    searchFields: ["reference", "institution", "doctor", "description", "comments"],
    referenceField: "reference",
    statusField: "status",
    entityType: "SPONSORING",
    related: { items: "items" },
    orderBy: { createdAt: "desc" },
    workflow: "adpro",
  },
  {
    name: "congress_international",
    model: "CongressInternational",
    module: "CONGRESS_INTERNATIONAL",
    label: "Congrès international",
    description: "Participation à un congrès à l'étranger : circuit de validation, inscrits, postes de dépense.",
    scope: moduleOnly,
    listFields: ["id", "name", "country", "city", "startDate", "endDate", "status", "requestStatus", "estimatedBudget", "companyId"],
    searchFields: ["name", "country", "city", "specialty"],
    statusField: "status",
    entityType: "CONGRESS_INTERNATIONAL",
    related: { items: "items" },
    orderBy: { startDate: "desc" },
    workflow: "adpro",
  },
  {
    name: "congress_national",
    model: "CongressNational",
    module: "CONGRESS_NATIONAL",
    label: "Congrès national",
    description: "Participation à un congrès en Algérie, même circuit que l'international.",
    scope: moduleOnly,
    listFields: ["id", "name", "city", "hostInstitution", "date", "status", "requestStatus", "estimatedBudget", "companyId"],
    searchFields: ["name", "city", "hostInstitution", "specialty"],
    statusField: "status",
    entityType: "CONGRESS_NATIONAL",
    related: { items: "items" },
    orderBy: { date: "desc" },
    workflow: "adpro",
  },
  {
    name: "event",
    model: "Event",
    module: "EVENTS",
    label: "Événement",
    description: "Événement organisé par l'entreprise (soirée scientifique, atelier…), avec son circuit de validation selon l'origine de la demande.",
    scope: moduleOnly,
    listFields: ["id", "name", "type", "scope", "status", "requestStatus", "startDate", "endDate", "city", "estimatedBudget", "companyId"],
    searchFields: ["name", "location", "city", "description"],
    statusField: "status",
    entityType: "EVENT",
    related: { items: "items", registrations: "registrations" },
    orderBy: { startDate: "desc" },
    workflow: "adpro",
  },
  {
    name: "consulting_contract",
    model: "ConsultingContract",
    module: "CONSULTING",
    label: "Contrat de consulting",
    description: "Engagement passé avec un consultant ou un cabinet : objet de la mission, période, rémunération et son rythme, tâches attendues, pièces signées. Cycle de vie propre — brouillon, en validation, actif, expiré, annulé. Suivi par Ad & Pro ou par les RH (pôle).",
    // LE PÔLE PAR LIGNE (§118.150) : le module suffisait tant que tout contrat relevait d'Ad & Pro.
    // Un contrat passé aux RH n'est plus lisible par la promotion — sa rémunération comprise — et
    // la porte générique ne doit pas le rendre là où l'écran le cache (§118.71). La lecture du
    // pôle est celle de l'écran et de la garde d'accès : `polesLisibles`, une fois.
    scope: (user) => ({ pole: { in: polesLisibles((m) => userCan(user, m, "VIEW")) } }),
    // Les RH ouvrent l'objet aussi — pour leurs lignes à eux, que la portée ci-dessus borne.
    lisiblePar: ["RH"],
    listFields: ["id", "reference", "title", "counterparty", "status", "amount", "billing", "startDate", "endDate", "companyId", "requesterId", "createdAt"],
    searchFields: ["reference", "title", "counterparty", "scope", "notes"],
    referenceField: "reference",
    statusField: "status",
    entityType: "CONSULTING_CONTRACT",
    related: { tasks: "tasks" },
    orderBy: { createdAt: "desc" },
  },
  {
    name: "ad_pro_other",
    model: "AdProOtherRequest",
    module: "AD_PRO_OTHER",
    label: "Demande Ad & Pro — autre",
    description: "Demande de promotion qui n'entre dans aucune autre nature. Circuit court : un demandeur, une description, une décision. Elle existe pour qu'une dépense inhabituelle ne se déclare pas sous une étiquette fausse.",
    scope: moduleOnly,
    listFields: ["id", "reference", "title", "beneficiary", "status", "amount", "companyId", "requesterId", "createdAt"],
    searchFields: ["reference", "title", "description", "beneficiary"],
    referenceField: "reference",
    statusField: "status",
    entityType: "AD_PRO_OTHER",
    orderBy: { createdAt: "desc" },
  },
  {
    name: "expense_order",
    model: "ExpenseOrder",
    module: "FINANCES",
    label: "Ordre de dépense",
    description: "Engagement de paiement émis par un module métier (bon de virement Regulatory, poste Ad & Pro…) et réglé par les finances.",
    scope: moduleOnly,
    listFields: ["id", "reference", "label", "beneficiary", "amount", "category", "status", "dueDate", "sourceType", "sourceId", "companyId", "createdAt"],
    searchFields: ["reference", "label", "beneficiary", "notes"],
    referenceField: "reference",
    statusField: "status",
    entityType: "EXPENSE_ORDER",
    orderBy: { createdAt: "desc" },
  },
  {
    name: "department_budget",
    model: "DepartmentBudget",
    module: "BUDGETS",
    label: "Budget de département",
    description: "Enveloppe annuelle d'un département pour une nature donnée : moyens généraux, masse salariale, budget métier, formation.",
    scope: moduleOnly,
    listFields: ["id", "departmentId", "year", "kind", "amount", "updatedAt"],
    searchFields: [],
    orderBy: { year: "desc" },
  },
  {
    name: "department_expense",
    model: "DepartmentBudgetExpense",
    module: "BUDGETS",
    label: "Dépense imputée",
    description: "Achat imputé à un budget départemental, avec son justificatif obligatoire et le détail des articles du ticket.",
    scope: moduleOnly,
    listFields: ["id", "departmentId", "year", "kind", "label", "amount", "date", "pettyCashId", "adminRequestId"],
    searchFields: ["label", "notes"],
    entityType: "DEPARTMENT_EXPENSE",
    related: { lines: "lines" },
    orderBy: { date: "desc" },
  },
  {
    name: "stock_snapshot",
    model: "StockSnapshot",
    module: "STOCKS",
    label: "État de stock daté",
    description: "Relevé « à cette date, il reste X » pour un produit sur un lieu (PCH centrale, direction régionale de la PCH, hôpital, annexe).",
    scope: moduleOnly,
    listFields: ["id", "productId", "date", "quantity", "scope", "annexId", "drCode", "companyId"],
    searchFields: [],
    orderBy: { date: "desc" },
  },
  {
    name: "pch_tender",
    model: "PchTender",
    module: "PCH",
    label: "Appel d'offres PCH",
    description: "Appel d'offres de la Pharmacie Centrale des Hôpitaux, ses lignes de produits et l'analyse de marché associée.",
    scope: moduleOnly,
    listFields: ["id", "reference", "title", "client", "supplier", "value", "awardDate", "status", "companyId"],
    searchFields: ["reference", "title", "client", "supplier", "notes"],
    referenceField: "reference",
    statusField: "status",
    related: { lines: "lines" },
    orderBy: { awardDate: "desc" },
  },
  {
    name: "doctor",
    model: "MedicalDoctor",
    module: "MEDICAL",
    label: "Médecin",
    description: "Praticien du fichier médical, visité par les délégués.",
    scope: scopeMedicalDoctors,
    listFields: ["id", "name", "title", "specialty", "sector", "institution", "city", "region", "delegateId", "companyId"],
    searchFields: ["name", "specialty", "institution", "city", "comments"],
    entityType: "DOCTOR",
    related: { visits: "visits", fieldReports: "fieldReports" },
    orderBy: { name: "asc" },
  },
  {
    name: "medical_visit",
    model: "MedicalVisit",
    module: "MEDICAL",
    label: "Visite médicale",
    description: "Visite d'un délégué chez un praticien, avec son compte rendu.",
    scope: scopeMedicalVisits,
    listFields: ["id", "doctorId", "delegateId", "date", "status", "objective", "region", "createdAt"],
    searchFields: ["report", "objective", "doctorFeedback"],
    statusField: "status",
    orderBy: { date: "desc" },
  },
  {
    name: "medical_info_declaration",
    model: "MedicalInfoDeclaration",
    module: "MEDICAL_INFO",
    label: "Déclaration d'information médicale (PRIM)",
    description: "Déclaration soumise au pharmacien responsable puis à l'autorité : prise en charge, don, prestation — avec son circuit de validation et son ordre de paiement.",
    scope: scopeMedicalInfo,
    listFields: ["id", "reference", "sourceType", "sourceId", "label", "beneficiary", "amount", "status", "requesterId", "companyId", "createdAt"],
    searchFields: ["reference", "label", "beneficiary", "authorityNotes"],
    referenceField: "reference",
    statusField: "status",
    orderBy: { createdAt: "desc" },
  },
  {
    name: "mail_entry",
    model: "MailEntry",
    module: "MAIL_REGISTER",
    label: "Courrier",
    description:
      "Un pli entrant ou sortant du registre de l'assistante de direction : objet, parties, départ (avec l'heure), "
      + "arrivée, accusé de réception, porteur — et ses pièces jointes (scan du pli, accusé signé).",
    scope: moduleOnly,
    listFields: ["id", "reference", "title", "direction", "sender", "recipient", "sentAt", "receivedAt", "acknowledgedAt", "carrier", "companyId", "createdAt"],
    searchFields: ["reference", "title", "sender", "recipient", "carrier", "notes"],
    referenceField: "reference",
    entityType: "MAIL_ENTRY",
    orderBy: { createdAt: "desc" },
  },
  {
    name: "sale",
    model: "Sale",
    module: "SALES",
    label: "Vente",
    description: "Vente de produit ou de service enregistrée par la force de vente.",
    scope: scopeSales,
    listFields: ["id", "date", "saleType", "product", "client", "institution", "quantity", "unitPrice", "revenue", "paymentStatus", "deliveryStatus", "salesUserId", "companyId"],
    searchFields: ["product", "client", "institution", "dci", "comment"],
    statusField: "paymentStatus",
    orderBy: { date: "desc" },
  },
  {
    name: "dossier",
    model: "Dossier",
    module: "DOSSIERS",
    label: "Dossier transverse",
    description: "Dossier de travail transverse (sujet suivi à plusieurs) avec ses participants, son fil de discussion et ses pièces.",
    scope: moduleOnly,
    listFields: ["id", "reference", "title", "category", "priority", "status", "createdById", "assignedToId", "dueDate", "companyId"],
    searchFields: ["reference", "title", "description"],
    statusField: "status",
    referenceField: "reference",
    related: { messages: "messages" },
    orderBy: { createdAt: "desc" },
  },
  {
    name: "task",
    model: "Task",
    module: "WORKSPACE",
    label: "Tâche",
    description: "Tâche assignée à une personne, éventuellement rattachée à un projet ou à un objet métier.",
    // Le CERCLE de la tâche — le module WORKSPACE, que tout le monde a, ne suffit pas. La clause est
    // celle du domaine `tasks` : posée par `portee.ts` (une façade), le socle ne connaît pas les domaines.
    scope: moduleOnly,
    listFields: ["id", "title", "status", "priority", "assignedToId", "createdById", "dueDate", "module", "relatedEntityType", "relatedEntityId", "createdAt"],
    searchFields: ["title", "description"],
    statusField: "status",
    entityType: "TASK",
    orderBy: { dueDate: "asc" },
  },
  {
    name: "document",
    model: "Document",
    module: "DOCUMENTS",
    label: "Document",
    description: "Pièce jointe rattachée à un objet métier (facture, scan, rapport). Le contenu se télécharge par un point d'accès dédié, jamais par un chemin de fichier.",
    scope: moduleOnly,
    listFields: ["id", "name", "category", "entityType", "entityId", "stepKey", "mimeType", "sizeBytes", "version", "confidentiality", "uploadedById", "createdAt"],
    searchFields: ["name"],
    orderBy: { createdAt: "desc" },
  },
  {
    name: "user",
    model: "User",
    module: "ADMIN",
    label: "Compte utilisateur",
    description: "Compte de connexion, son rôle et ses droits. Objet d'administration : l'exposer demande la portée `erp.admin`.",
    scope: moduleOnly,
    porteeRequise: "erp.admin",
    listFields: ["id", "name", "email", "role", "secondaryRole", "isActive", "departmentId", "title", "lastLoginAt", "createdAt"],
    searchFields: ["name", "email"],
    entityType: "USER",
    orderBy: { name: "asc" },
  },
  {
    name: "audit_log",
    model: "AuditLog",
    module: "ADMIN",
    label: "Entrée du journal d'audit",
    description: "Trace d'une action humaine dans l'ERP : qui, quoi, sur quel objet, quand. Objet d'administration : l'exposer demande la portée `erp.admin`.",
    scope: moduleOnly,
    porteeRequise: "erp.admin",
    listFields: ["id", "actorId", "action", "module", "entityType", "entityId", "field", "oldValue", "newValue", "summary", "createdAt"],
    searchFields: ["summary"],
    orderBy: { createdAt: "desc" },
  },
  {
    name: "notification",
    model: "Notification",
    module: "NOTIFICATIONS",
    label: "Notification",
    description: "Alerte adressée à une personne (assignation, validation attendue, échéance).",
    // Une notification n'est lue que par son destinataire — jamais par « qui a le module ».
    scope: (user) => ({ userId: user.id }),
    listFields: ["id", "userId", "type", "title", "body", "link", "isRead", "createdAt"],
    searchFields: ["title", "body"],
    orderBy: { createdAt: "desc" },
  },
];

const BY_NAME = new Map(ENTITIES.map((e) => [e.name, e]));

export function getEntity(name: string): EntityDef | null {
  return BY_NAME.get(name) ?? null;
}

export function entityNames(): string[] {
  return ENTITIES.map((e) => e.name);
}

/**
 * L'utilisateur peut-il lire cet objet ? La question est posée au RBAC de l'ERP, pas à l'API.
 * Un objet d'administration exige en plus une portée du CLIENT (`porteeManquante`) côté route.
 */
export function canReadEntity(user: SessionUser, def: EntityDef): boolean {
  return [def.module, ...(def.lisiblePar ?? [])].some((m) => userCan(user, m, "VIEW"));
}

/** La portée d'API que l'objet exige et que le client ne porte pas — `null` quand rien ne manque (SA-15). */
export function porteeManquante(def: EntityDef, portees: readonly string[]): Scope | null {
  return def.porteeRequise && !hasScope(portees, def.porteeRequise) ? def.porteeRequise : null;
}

/** Filtre Prisma correspondant à la portée de l'utilisateur sur cet objet. */
export function entityScopeWhere(user: SessionUser, def: EntityDef): Record<string, unknown> {
  return def.scope ? def.scope(user) : {};
}
