"use server";

import { randomUUID } from "crypto";
import { effectiveTherapeuticSegments } from "@/lib/labels";
import { revalidatePath } from "next/cache";
import type { Priority, ProductChannel, ProductType, RegulatoryCategory, RegulatoryStatus, StepStatus, ManufacturingStatus, VariationStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan, isRegulatorySupervisor, holdsRegulatoryLock, seesLockedRegulatory, getAccess, type SessionUser } from "@/lib/rbac";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import {
  dciKey, duplicateNotice, needsAccessRequest,
  type DciDuplicate,
} from "@/lib/regulatory/dci-duplicate";
import { assignmentNotice, assignmentWarning } from "@/lib/regulatory/assignment";
import {
  canSetStructural, structuralChanges, structuralRefusal, structuralNotice, STRUCTURAL_LABELS,
  type StructuralChange,
} from "@/lib/regulatory/structural-fields";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { reposerWilayaCode } from "@/modules/lieux/api";
import { projetsBdVisibles } from "@/lib/queries/bd";
import { createWithRetry, enSerie, referenceDeSerie } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { doubleEcrireOrganisation } from "@/modules/referentiels/api";
import { ensureProduitDuDossier } from "@/lib/products/canonique";
import { phraseProduitDuDossier } from "@/lib/products/produit-du-dossier";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/modules/finances/api";
import { categorieBvPourOrdre } from "@/lib/queries/budget-regulatory";
import { natureDuLibelle } from "@/lib/budget-regulatory/bv";
import { bloqueUneNouvelleDemande, etatDeLOrdreBv, ETAT_BV } from "@/lib/regulatory/bv-circuit";
import { saveFile, validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { REGULATORY_STEP_ORDER, LOCAL_MANUFACTURING_VARIATIONS, VARIATION_TARGETS, MANUFACTURING_STATUS } from "@/lib/labels";
import {
  isRegStepKey, isRegStepState, isRegChecklistKey, isRegPresubOutcome,
  REG_STEPS, REG_CHECKLIST, REG_PRESUB_OUTCOME, PRESUB_ANSWER_STEP,
  REG_STATUS_MILESTONE, completeStepsThrough, BV_REQUEST_STEPS,
  type RegWorkflowState, type RegChecklistState,
} from "@/lib/regulatory-workflow";
import { creerDossierDriveProduit, synchroniserDossierDrive } from "@/lib/regulatory-drive-dossier";
import { emit } from "@/platform/events";
import { syncStatusFromWorkflow, regSupervisorRoles } from "@/lib/regulatory/sync-status";

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** Réussite ASSORTIE d'une réserve — « c'est fait, mais voilà ce que vous devez savoir ».
   *  Ex. : un dossier confié alors qu'il est encore verrouillé. Une réussite muette laisserait
   *  croire que la personne y a accès. */
  message?: string;
}

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  return v ? String(v) : null;
}

/** Canal produit (Ville / Hôpital / les deux). undefined si absent → laisse la valeur en place. */
function parseProductChannel(v: string | null): ProductChannel | undefined {
  return v === "RETAIL" || v === "HOSPITAL" || v === "BOTH" ? v : undefined;
}

/** Uniformise la casse des DCI : MAJUSCULES, espaces normalisés autour des « + ». */
function normalizeDci(value: string): string {
  return value.trim().toUpperCase().replace(/\s*\+\s*/g, " + ").replace(/\s+/g, " ");
}
const upperMolecules = (list: string[]): string[] => list.map((m) => m.trim().toUpperCase()).filter(Boolean);

/** L'utilisateur courant est-il superviseur Regulatory (fixe priorité/dates, demande des MàJ) ? */
async function ensureRegSupervisor(user: Awaited<ReturnType<typeof requireUser>>): Promise<boolean> {
  const settings = await getAppSettings();
  return isRegulatorySupervisor(user, settings.regulatorySupervisorRoles);
}

/**
 * LES DOSSIERS QUI PORTENT DÉJÀ CETTE DCI — ceux qu'on peut nommer, et ceux qu'on compte.
 *
 * Deux lectures, et la différence entre elles EST le renseignement :
 *
 *   • sans portée, pour SAVOIR qu'un homonyme existe. Aucun nom n'en sort — seulement des
 *     identifiants qui servent à filtrer la seconde requête, puis un décompte ;
 *   • avec `regulatoryVisibleWhere`, la clause UNIQUE que l'écran Regulatory applique déjà
 *     (verrou du pipeline, portée par ligne, cloisonnement par entité, gamme), pour savoir
 *     lesquels cette personne a le droit de VOIR — ceux-là seulement seront nommés.
 *
 * Reprendre la clause de l'écran plutôt que d'en réécrire une ici n'est pas de l'élégance : une
 * seconde clause dériverait au premier droit ajouté, et c'est ce jour-là qu'un avertissement
 * nommerait un dossier confidentiel.
 *
 * La comparaison se fait en mémoire parce qu'elle ne s'exprime PAS en SQL : « A + B » et
 * « B + A » sont la même association, et un `equals` les manquerait — précisément le doublon
 * qu'on cherche.
 */
async function dciDuplicatesFor(user: SessionUser, dci: string): Promise<DciDuplicate> {
  const cle = dciKey(dci);
  if (!cle) return { visible: [], hidden: 0 };

  const tous = await prisma.regulatoryProduct.findMany({ select: { id: true, dci: true } });
  const ids = tous.filter((p) => dciKey(p.dci) === cle).map((p) => p.id);
  if (ids.length === 0) return { visible: [], hidden: 0 };

  const visible = await prisma.regulatoryProduct.findMany({
    where: { AND: [await regulatoryVisibleWhere(user), { id: { in: ids } }] },
    select: { id: true, reference: true, brandName: true, dosage: true, pharmaceuticalForm: true },
    orderBy: { reference: "asc" },
  });
  return { visible, hidden: ids.length - visible.length };
}

/**
 * CE QU'ON DIT PENDANT LA SAISIE — appelée par le formulaire quand la DCI change.
 *
 * L'avertissement doit arriver AVANT le clic sur « Créer », pas après : découvrir le doublon
 * dans un message d'erreur oblige à relire un formulaire qu'on croyait fini, et c'est là qu'on
 * force le passage plutôt que d'aller vérifier.
 */
export interface ExistantDeLaMolecule {
  /** DOSSIER = un dossier réglementaire visible ; PRODUIT = un produit du référentiel canonique. */
  nature: "DOSSIER" | "PRODUIT";
  id: string;
  libelle: string;
  detail: string;
  /** Pour un PRODUIT : de quoi pré-remplir le formulaire si l'on part de lui. */
  identite?: { dosage: string | null; dosageUnit: string | null; form: string | null; packaging: string | null; brandName: string | null };
}

export async function checkDciDuplicate(dci: string): Promise<{ notice: string | null; canRequestAccess: boolean; existants: ExistantDeLaMolecule[] }> {
  const user = await enLecture(requireUser);
  // Le même droit que la création : ce que cette réponse révèle (« cette DCI est déjà suivie »)
  // n'a pas à sortir pour qui n'ouvre pas de dossier. Au suivi OU au pipeline (Direction, 08/10) : on y crée aussi.
  if (!userCan(user, "REGULATORY", "CREATE") && !userCan(user, "REGULATORY_PIPELINE", "CREATE")) {
    return { notice: null, canRequestAccess: false, existants: [] };
  }
  const propre = normalizeDci(dci ?? "");
  if (propre.length < 3) return { notice: null, canRequestAccess: false, existants: [] };
  const doublons = await dciDuplicatesFor(user, propre);
  // CE QUI EXISTE DÉJÀ, PROPOSÉ (Direction, 06/10) : les dossiers VISIBLES de cette molécule (on les ouvre), et les
  // produits du référentiel canonique qui la portent (on part de l'un d'eux, ou l'on crée un nouveau produit).
  const cle = dciKey(propre);
  const produits = (await prisma.product.findMany({
    where: { isActive: true, dci: { contains: propre.split(" + ")[0], mode: "insensitive" } },
    select: { id: true, code: true, canonicalName: true, dci: true, dosage: true, dosageUnit: true, form: true, packaging: true },
    take: 40,
  })).filter((p) => dciKey(p.dci) === cle);
  const existants: ExistantDeLaMolecule[] = [
    ...doublons.visible.map((d) => ({
      nature: "DOSSIER" as const, id: d.id, libelle: `${d.reference}${d.brandName ? ` — ${d.brandName}` : ""}`,
      detail: [d.dosage, d.pharmaceuticalForm].filter(Boolean).join(" · ") || "dossier existant",
    })),
    ...produits.map((p) => ({
      nature: "PRODUIT" as const, id: p.id, libelle: p.canonicalName, detail: [p.code, p.dosage ? `${p.dosage} ${p.dosageUnit ?? ""}`.trim() : null, p.form, p.packaging].filter(Boolean).join(" · "),
      identite: { dosage: p.dosage, dosageUnit: p.dosageUnit, form: p.form, packaging: p.packaging, brandName: null },
    })),
  ];
  const notice = duplicateNotice(propre, doublons) ?? (produits.length ? `« ${propre} » existe déjà dans le référentiel produits (${produits.length} produit${produits.length > 1 ? "s" : ""}).` : null);
  return { notice, canRequestAccess: needsAccessRequest(doublons), existants };
}

/**
 * METTRE AU PIPELINE TOUS LES DOSSIERS NON ENTAMÉS (Direction, 06/10) — un geste du SUPER ADMIN seul. « Non entamé » :
 * dossier visible (non verrouillé) dont AUCUNE étape n'a commencé. Ils repassent à l'étude (verrouillés), invisibles de
 * l'équipe jusqu'à ce que le cadenas s'ouvre. `compterDossiersNonEntames` en donne le nombre avant.
 */
/** « Non entamé » : visible (non verrouillé), et aucune étape commencée. */
const NON_ENTAMES: Prisma.RegulatoryProductWhereInput = { isLocked: false, steps: { none: { status: { not: "NOT_STARTED" } } } };

/** Combien de dossiers non entamés — l'aperçu que le bouton montre avant de confirmer. */
export async function compterDossiersNonEntames(): Promise<ActionResult & { nombre?: number }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  return { ok: true, nombre: await prisma.regulatoryProduct.count({ where: NON_ENTAMES }) };
}

export async function mettreAuPipelineNonEntames(): Promise<ActionResult & { nombre?: number }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const where = NON_ENTAMES;
  const res = await prisma.regulatoryProduct.updateMany({ where, data: { isLocked: true, updatedById: user.id } });
  if (res.count > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT",
      entityId: "*", field: "isLocked", newValue: "true",
      summary: `${res.count} dossier(s) non entamé(s) mis au pipeline en une fois (verrouillés, à l'étude)`,
    });
  }
  revalidatePath("/regulatory");
  revalidatePath("/regulatory/pipeline");
  return { ok: true, nombre: res.count, message: `${res.count} dossier(s) non entamé(s) mis au pipeline.` };
}

/**
 * « JE NE LE VOIS PAS SUR MON ÉCRAN » — le geste qui débloque.
 *
 * On ne crée AUCUN registre de demandes d'accès (§118-5) : la demande est une notification aux
 * personnes qui distribuent réellement cet accès — la supervision Regulatory et le Super Admin —
 * et une ligne d'audit. Une table de demandes en attente exigerait un écran, des relances et un
 * cycle de vie, pour un geste qui se règle en deux clics dans la console.
 *
 * La demande porte sur la DCI, jamais sur un identifiant de dossier : nommer le dossier caché
 * dans la demande le révélerait à celui-là même à qui on le cache.
 */
export async function requestRegulatoryDossierAccess(dci: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "REGULATORY", "VIEW")) return { ok: false, error: "Accès non autorisé." };
  const propre = normalizeDci(dci ?? "");
  if (!propre) return { ok: false, error: "La DCI est obligatoire." };

  // ON NE DEMANDE PAS UN ACCÈS QU'ON A DÉJÀ. Sans cette garde le bouton devient une sonnette
  // qu'on presse par réflexe, et la demande qui compte se noie dans celles qui ne coûtaient rien.
  const doublons = await dciDuplicatesFor(user, propre);
  if (!needsAccessRequest(doublons)) {
    return { ok: false, error: "Aucun dossier caché ne porte cette DCI : tout ce qui existe vous est déjà visible." };
  }

  await notifyRoles(await regSupervisorRoles(), {
    type: "GENERIC",
    title: "Demande d'accès à un dossier réglementaire",
    body: `${user.name} ouvre un dossier « ${propre} » et ${doublons.hidden > 1 ? `${doublons.hidden} dossiers portant cette DCI ne lui sont pas visibles` : "un dossier portant cette DCI ne lui est pas visible"}.`,
    link: "/admin/access",
  });
  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Regulatory",
    summary: `Demande d'accès aux dossiers de DCI « ${propre} » (${doublons.hidden} hors de portée)`,
  });
  return { ok: true, message: "Demande transmise à la supervision Regulatory." };
}

/**
 * Création d'un fournisseur depuis le module Regulatory (par les Responsables
 * réglementaires). Le fournisseur alimente le menu déroulant des dossiers. Aucun
 * compte de portail n'est créé ici — l'accès externe reste piloté à part.
 */
export async function createRegulatorySupplier(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "REGULATORY", "CREATE")) return { ok: false, error: "Création non autorisée." };
  const name = str(formData, "name");
  if (!name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  const created = await prisma.supplier.create({
    data: {
      name,
      country: str(formData, "country"),
      contactEmail: str(formData, "contactEmail"),
      notes: str(formData, "notes"),
      createdById: user.id,
    },
    select: { id: true },
  });
  await reposerWilayaCode("Supplier", created.id); // double écriture des lieux (refonte V2-D)
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Regulatory", entityType: "SUPPLIER", entityId: created.id, summary: `Fournisseur « ${name} »` });
  await doubleEcrireOrganisation("SUPPLIER", created.id, user.id);
  revalidatePath("/regulatory");
  return { ok: true, id: created.id };
}

export async function createRegulatoryProduct(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  // CRÉÉ DIRECTEMENT DANS LE PIPELINE. Le formulaire du pipeline envoie `lock=1` : le dossier
  // naît verrouillé, donc à l'étude, invisible de l'équipe tant que le cadenas n'est pas ouvert.
  // Le droit reste celui du cadenas — le Super Admin, et lui seul : sans cette garde, n'importe
  // qui pourrait créer un dossier que personne d'autre ne verrait.
  const lockOnCreate = str(formData, "lock") === "1" && user.role === "SUPER_ADMIN";
  // LE GESTE SE LIT SUR L'ÉCRAN OÙ NAÎT LE DOSSIER (Direction, 08/10) : « Créer » du pipeline pour un dossier verrouillé,
  // « Créer » de Regulatory (suivi des dossiers) pour un dossier ouvert.
  if (!(lockOnCreate ? userCan(user, "REGULATORY_PIPELINE", "CREATE") : userCan(user, "REGULATORY", "CREATE"))) {
    return { ok: false, error: "Création non autorisée." };
  }

  // DCI : molécule unique OU association (double/triple…). Le formulaire envoie une
  // ou plusieurs entrées « molecule » ; la DCI canonique est leur concaténation.
  // Casse uniformisée en MAJUSCULES pour tout le référentiel.
  const molecules = upperMolecules(formData.getAll("molecule").map((m) => String(m)));
  const rawDci = molecules.length ? molecules.join(" + ") : str(formData, "dci");
  if (!rawDci) return { ok: false, error: "La DCI est obligatoire." };
  const dci = normalizeDci(rawDci);

  // UNE DCI DÉJÀ SUIVIE : ON LE DIT, ON NE REFUSE PAS. Un second dossier est souvent légitime
  // (autre dosage, autre forme, autre partenaire) — mais il doit être VOULU. Interdire ferait
  // chercher un contournement, et l'on créerait le doublon sous une DCI mal orthographiée : plus
  // rapprochable du premier, donc pire. Le formulaire renvoie `confirmDuplicate=1` quand la
  // personne a LU l'avis et maintient sa création.
  //
  // La garde vit ICI et pas seulement à l'écran (§118-7) : une action serveur s'appelle depuis
  // le navigateur sans passer par le formulaire.
  if (str(formData, "confirmDuplicate") !== "1") {
    const avis = duplicateNotice(dci, await dciDuplicatesFor(user, dci));
    if (avis) return { ok: false, error: avis };
  }

  // L'ENTITÉ est obligatoire : c'est elle qui détermine qui a le droit de voir ce dossier. Un
  // produit sans entité apparaît dans la vue « toutes les entités » de TOUT LE MONDE — la
  // laisser facultative revenait à publier le dossier au groupe entier par défaut.
  const companyId = str(formData, "companyId");
  if (!companyId) return { ok: false, error: "L'entité est obligatoire : elle détermine qui verra ce dossier." };
  const okCompany = await prisma.company.count({ where: { id: companyId, isActive: true } });
  if (!okCompany) return { ok: false, error: "Entité inconnue ou désactivée." };

  const year = new Date().getFullYear();

  const responsibleId = str(formData, "responsibleId");
  const assistantId = str(formData, "assistantId");
  const targetDateRaw = str(formData, "targetDate");
  const targetSubmissionDateRaw = str(formData, "targetSubmissionDate");

  // Variation d'enregistrement : une fabrication locale exige le fabricant.
  const manufacturingVariation = str(formData, "manufacturingVariation");
  const manufacturer = str(formData, "manufacturer");
  if (manufacturingVariation && LOCAL_MANUFACTURING_VARIATIONS.includes(manufacturingVariation) && !manufacturer) {
    return { ok: false, error: "Le Fabricant est obligatoire pour une fabrication locale (packaging secondaire, primaire ou full process)." };
  }
  const variationDateRaw = str(formData, "variationDate");

  // Connect responsible + assistant as assigned users so row-level scope works.
  const assignIds = Array.from(new Set([responsibleId, assistantId].filter(Boolean))) as string[];

  // LA CTD INITIALE EST OBLIGATOIRE dans le suivi de dossiers (Direction, 06/10) — pas au pipeline, où un dossier
  // naît à l'étude, avant d'avoir sa CTD. Les fichiers partent APRÈS la création (envoi en arrière-plan vers
  // l'étape 1) : le formulaire dit combien il en a choisis, et un dossier du suivi sans CTD ne se crée pas.
  if (!lockOnCreate && !(Number(str(formData, "ctdFichiers") ?? "0") > 0)) {
    return { ok: false, error: "Joignez la CTD initiale : un dossier du suivi se crée avec elle (le pipeline, lui, l'accepte plus tard)." };
  }

  // LA RÉFÉRENCE SE CALCULE SOUS LA FILE (§118.175, §118.178). Deux créations simultanées lisaient
  // le même maximum et la seconde tombait sur l'unicité de `reference` — une erreur brute après un
  // formulaire de trente champs. Une création à la fois dans ce processus, un réessai entre deux.
  const product = await enSerie("REG", () => createWithRetry(async () => prisma.regulatoryProduct.create({
    data: {
      reference: await referenceDeSerie({ modele: "RegulatoryProduct", prefixe: "REG", annee: year,
        existantes: async () => (await prisma.regulatoryProduct.findMany({ where: { reference: { startsWith: `REG-${year}-` } }, select: { reference: true } })).map((r) => r.reference) }),
      dci,
      molecules: molecules.length > 1 ? (molecules as unknown as Prisma.InputJsonValue) : undefined,
      brandName: str(formData, "brandName"),
      dosage: str(formData, "dosage"),
      dosageUnit: str(formData, "dosageUnit"),
      pharmaceuticalForm: str(formData, "pharmaceuticalForm"),
      packaging: str(formData, "packaging"),
      therapeuticClass: str(formData, "therapeuticClass"),
      partnerLab: str(formData, "partnerLab"),
      supplierId: str(formData, "supplierId"),
      countryOfOrigin: str(formData, "countryOfOrigin"),
      category: (str(formData, "category") as RegulatoryCategory) ?? "MEDICINE",
      channel: parseProductChannel(str(formData, "channel")) ?? "BOTH",
      productType: (str(formData, "productType") as ProductType) ?? "IMPORTED",
      manufacturingStatus: (str(formData, "manufacturingStatus") as ManufacturingStatus) ?? "IMPORTATION",
      status: (str(formData, "status") as RegulatoryStatus) ?? "PRE_SUBMISSION",
      priority: (str(formData, "priority") as Priority) ?? "MEDIUM",
      companyId,
      isLocked: lockOnCreate,
      targetSubmissionDate: targetSubmissionDateRaw ? new Date(targetSubmissionDateRaw) : null,
      targetDate: targetDateRaw ? new Date(targetDateRaw) : null,
      comments: str(formData, "comments"),
      deHolder: str(formData, "deHolder"),
      manufacturingVariation: manufacturingVariation === "NONE" ? null : manufacturingVariation,
      manufacturer,
      variationDate: variationDateRaw ? new Date(variationDateRaw) : null,
      responsibleId,
      assistantId,
      createdById: user.id,
      updatedById: user.id,
      assignedUsers: assignIds.length ? { connect: assignIds.map((id) => ({ id })) } : undefined,
      // Seed the configurable 17-step regulatory workflow.
      steps: {
        create: REGULATORY_STEP_ORDER.map((type, idx) => ({
          type: type as never,
          order: idx + 1,
          status: "NOT_STARTED" as StepStatus,
        })),
      },
    },
  })));
  const reference = product.reference;

  await recordAudit({
    actorId: user.id,
    action: "CREATE",
    module: "Regulatory",
    entityType: "REGULATORY_PRODUCT",
    entityId: product.id,
    summary: `Nouveau dossier ${reference} — ${dci}${lockOnCreate ? " (créé verrouillé, dans le pipeline)" : ""}`,
  });

  // LE DOSSIER DRIVE DU PRODUIT (Direction, 06/10) : un dossier du SUIVI naît avec son dossier dans la
  // catégorie « Regulatory », organisé comme le modèle. En arrière-plan et sans jamais faire échouer la
  // création ; la file par produit fait attendre le dépôt de la CTD qui suit. Un dossier du pipeline
  // (verrouillé) l'aura à l'ouverture du cadenas.
  if (!lockOnCreate) {
    void creerDossierDriveProduit(product.id, user.id)
      .catch((e) => console.error("[drive regulatory] dossier Drive non créé (non bloquant)", e));
  }

  // PRODUIT = DOSSIER (Direction, 08/10) : le dossier EST un produit dès sa naissance, identité
  // complète ou non (ce qui manque devient une indication sur la fiche). Un dossier verrouillé le
  // reçoit à l'ouverture du cadenas. Le dossier est créé quoi qu'il arrive : un incident se DIT dans
  // le message, il ne défait pas une création réussie, et le bilan du démarrage le rattrapera.
  const lien = await ensureProduitDuDossier(product.id, { acteurId: user.id }).catch((e) => {
    console.error("[produits] produit du dossier à la création", e);
    return null;
  });
  const messageProduit = lien
    ? phraseProduitDuDossier(lien)
    : "La fiche produit n'a pas pu être créée maintenant : elle le sera au prochain démarrage.";

  // UN DOSSIER VERROUILLÉ NE PRÉVIENT PERSONNE. Il n'existe que pour le Super Admin
  // (`lockGate`) : annoncer sa création à l'équipe reviendrait à lui envoyer un lien qui
  // s'ouvre sur un 404, tout en révélant qu'un dossier confidentiel vient d'entrer. Les
  // notifications reprennent à l'ouverture du cadenas, quand le dossier devient un travail.
  if (!lockOnCreate) {
    if (assistantId && assistantId !== user.id) {
      await notifyUser({
        userId: assistantId,
        type: "ASSIGNMENT",
        title: "Nouveau dossier assigné",
        body: `${reference} — ${dci}`,
        link: `/regulatory/${product.id}`,
      });
    }

    // Supervision : prévenir les superviseurs Regulatory (Super Admin + rôles configurés)
    // qu'un nouveau dossier attend une priorité et une date cible de dépôt.
    await notifyRoles(await regSupervisorRoles(), {
      type: "GENERIC",
      title: "Nouveau dossier Regulatory à prioriser",
      body: `${reference} — ${dci} · définir la priorité et la date cible de dépôt.`,
      link: `/regulatory/${product.id}`,
    });
  }

  revalidatePath("/regulatory");
  // Le pipeline est l'écran des dossiers verrouillés : un dossier qui y naît doit s'y voir
  // tout de suite, sans attendre l'expiration du cache de navigation.
  revalidatePath("/regulatory/pipeline");
  return { ok: true, id: product.id, message: messageProduit ?? undefined };
}

/**
 * Modifie les informations descriptives d'un dossier réglementaire (DCI, marque,
 * dosage, classe, laboratoire, pays, type, responsables…). La casse des DCI est
 * uniformisée en MAJUSCULES. Le statut/priorité ont leur propre action dédiée mais
 * sont aussi acceptés ici pour une édition complète depuis la fiche.
 */
/**
 * LES TROIS CHAMPS STRUCTURELS — comparés, refusés à qui n'y a pas droit, et ANNONCÉS.
 *
 * Un même verrou sert quatre écrans (la fiche, les deux menus du tableau, la promotion par
 * variation). Le poser une fois évite qu'une correction ne s'applique qu'à trois d'entre eux.
 *
 * Rend les changements RETENUS (vides si l'on n'a pas le droit) et le refus à afficher. Le refus
 * est une réserve, pas une erreur : le reste de la fiche s'enregistre. Perdre un formulaire de
 * trente champs parce qu'une liste déroulante a bougé serait une punition, pas une protection.
 */
async function guardStructural(
  user: { id: string; role: string },
  before: { manufacturingStatus: string | null; responsibleId: string | null; companyId: string | null },
  after: Partial<{ manufacturingStatus: string | null; responsibleId: string | null; companyId: string | null }>,
): Promise<{ changes: StructuralChange[]; refusal: string | null }> {
  // Les valeurs s'affichent LISIBLES : un identifiant `cmxyz…` dans une notification n'apprend
  // rien à qui la reçoit.
  const ids = [after.responsibleId, before.responsibleId].filter(Boolean) as string[];
  const companyIds = [after.companyId, before.companyId].filter(Boolean) as string[];
  const [people, companies] = await Promise.all([
    ids.length ? prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
    companyIds.length ? prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, shortName: true } }) : [],
  ]);
  const display = (field: string, value: string | null): string => {
    if (!value) return "—";
    if (field === "manufacturingStatus") return MANUFACTURING_STATUS[value] ?? value;
    if (field === "responsibleId") return people.find((p) => p.id === value)?.name ?? "—";
    const c = companies.find((x) => x.id === value);
    return c ? c.shortName || c.name : "—";
  };

  const changes = structuralChanges(before, after, display as never);
  if (changes.length === 0) return { changes: [], refusal: null };
  if (!canSetStructural(user)) return { changes: [], refusal: structuralRefusal(changes) };
  return { changes, refusal: null };
}

/**
 * PRÉVENIR LE CHARGÉ DU DOSSIER qu'un champ structurel a bougé.
 *
 * C'est lui qui répondra à l'agence sur le statut de fabrication : l'apprendre trois semaines
 * plus tard, en rouvrant la fiche par hasard, n'est pas acceptable. On ne se notifie pas
 * soi-même — le Super Admin sait ce qu'il vient de faire.
 */
async function notifyCarrierOfStructural(
  productId: string,
  carrierId: string | null,
  actorId: string,
  reference: string,
  dci: string,
  changes: readonly StructuralChange[],
): Promise<void> {
  if (!carrierId || carrierId === actorId) return;
  const notice = structuralNotice(reference, dci, changes);
  if (!notice) return;
  await notifyUser({ userId: carrierId, type: "ASSIGNMENT", ...notice, link: `/regulatory/${productId}` });
}

export async function updateRegulatoryProduct(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }
  const before = await prisma.regulatoryProduct.findUnique({ where: { id }, include: { assignedUsers: { select: { id: true } } } });
  if (!before) return { ok: false, error: "Dossier introuvable." };

  // DCI : recompose depuis les molécules saisies, sinon depuis le champ libre.
  const molecules = upperMolecules(formData.getAll("molecule").map((m) => String(m)));
  const rawDci = molecules.length ? molecules.join(" + ") : str(formData, "dci");
  if (!rawDci) return { ok: false, error: "La DCI est obligatoire." };
  const dci = normalizeDci(rawDci);

  const responsibleId = str(formData, "responsibleId");
  const assistantId = str(formData, "assistantId");
  const targetDateRaw = str(formData, "targetDate");
  const targetSubmissionDateRaw = str(formData, "targetSubmissionDate");
  // Préserve les participants déjà rattachés (collaboration) + garantit l'accès du
  // responsable et de l'assistant. La modification d'un dossier ne doit JAMAIS retirer
  // les collaborateurs ajoutés via le panneau « Participants ».
  const assignIds = Array.from(new Set([...before.assignedUsers.map((u) => u.id), responsibleId, assistantId].filter(Boolean))) as string[];

  // Fabricant courant (les variations de fabrication ont leur propre cycle de vie).
  const manufacturer = str(formData, "manufacturer");

  // L'ENTITÉ est obligatoire : c'est elle qui détermine qui a le droit de voir ce dossier.
  // Un produit sans entité apparaît dans la vue « toutes les entités » de TOUT LE MONDE — la
  // rendre facultative revenait à publier le dossier au groupe entier par défaut.
  // On tolère un dossier ancien qui n'en a pas encore, tant qu'on ne cherche pas à la retirer.
  const rawCompanyId = str(formData, "companyId");
  if (formData.has("companyId") && !rawCompanyId && before.companyId) {
    return { ok: false, error: "L'entité est obligatoire : un dossier ne peut pas être détaché de son entité." };
  }
  const updatedCompanyId = rawCompanyId || before.companyId;
  if (rawCompanyId) {
    const okCompany = await prisma.company.count({ where: { id: rawCompanyId, isActive: true } });
    if (!okCompany) return { ok: false, error: "Entité inconnue ou désactivée." };
  }

  // ── LES TROIS CHAMPS DU SUPER ADMIN ─────────────────────────────────────────
  // On ne compare QUE les champs réellement transmis : l'écran n'envoie pas ceux qu'il n'affiche
  // pas, et « non transmis » ne veut pas dire « effacé ». Un utilisateur ordinaire qui corrige un
  // dosage ne touche donc à rien de structurel et ne voit aucun refus.
  const wanted = {
    ...(formData.has("manufacturingStatus") ? { manufacturingStatus: str(formData, "manufacturingStatus") } : {}),
    ...(formData.has("responsibleId") ? { responsibleId } : {}),
    ...(formData.has("companyId") ? { companyId: updatedCompanyId } : {}),
  };
  const structural = await guardStructural(user, before, wanted);
  const keep = structural.refusal === null;

  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      dci,
      molecules: molecules.length > 1 ? (molecules as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      brandName: str(formData, "brandName"),
      dosage: str(formData, "dosage"),
      dosageUnit: str(formData, "dosageUnit"),
      pharmaceuticalForm: str(formData, "pharmaceuticalForm"),
      packaging: str(formData, "packaging"),
      therapeuticClass: str(formData, "therapeuticClass"),
      partnerLab: str(formData, "partnerLab"),
      supplierId: str(formData, "supplierId"),
      countryOfOrigin: str(formData, "countryOfOrigin"),
      companyId: keep ? updatedCompanyId : before.companyId,
      category: (str(formData, "category") as RegulatoryCategory) ?? before.category,
      channel: parseProductChannel(str(formData, "channel")) ?? before.channel,
      productType: (str(formData, "productType") as ProductType) ?? before.productType,
      // Refusé à qui n'est pas Super Admin : on repose la valeur d'avant plutôt que de rejeter
      // tout l'enregistrement.
      manufacturingStatus: keep
        ? (str(formData, "manufacturingStatus") as ManufacturingStatus) ?? before.manufacturingStatus
        : before.manufacturingStatus,
      // LE NIVEAU DE PROCESS N'EST PLUS UN CHAMP DE FORMULAIRE : il est déduit des étapes du
      // processus d'enregistrement. Le laisser modifiable ici rouvrirait la divergence qu'on
      // vient de fermer — l'en-tête disant une chose, les étapes une autre.
      status: before.status,
      priority: (str(formData, "priority") as Priority) ?? before.priority,
      // CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c, audit 360° I15) : la fiche de
      // modification n'a pas de « date cible de dépôt » — elle se règle par la supervision — et chaque
      // enregistrement l'effaçait. Une date ABSENTE garde sa valeur ; une date envoyée VIDE l'efface.
      ...(formData.has("targetSubmissionDate") ? { targetSubmissionDate: targetSubmissionDateRaw ? new Date(targetSubmissionDateRaw) : null } : {}),
      ...(formData.has("targetDate") ? { targetDate: targetDateRaw ? new Date(targetDateRaw) : null } : {}),
      comments: str(formData, "comments"),
      deHolder: str(formData, "deHolder"),
      manufacturer,
      responsibleId: keep ? responsibleId : before.responsibleId,
      assistantId,
      updatedById: user.id,
      assignedUsers: assignIds.length ? { set: assignIds.map((aid) => ({ id: aid })) } : { set: [] },
    },
  });

  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Regulatory",
    entityType: "REGULATORY_PRODUCT",
    entityId: id,
    // Un champ structurel qui bouge se relit DANS le journal : « modifié » ne dit pas lequel.
    summary: structural.changes.length
      ? `Dossier ${before.reference} — ${structural.changes.map((c) => `${c.label} : ${c.from} → ${c.to}`).join(" · ")}`
      : `Dossier ${before.reference} modifié — ${dci}`,
  });

  // LE PRODUIT SUIT SON DOSSIER : une identité complétée ou corrigée met à jour LE MÊME produit ; un
  // champ vidé ne le vide pas. Appelé à CHAQUE enregistrement — idempotent, il n'écrit que si
  // quelque chose a changé. Son état se LIT sur la fiche : le message de cette action est réservé
  // aux réserves, qui gardent la fenêtre ouverte.
  await ensureProduitDuDossier(id, { acteurId: user.id }).catch((e) => {
    console.error("[produits] produit du dossier à la modification", e);
  });

  // Le chargé du dossier apprend le changement — celui d'AVANT si la personne a changé : c'est
  // lui qui portait le dossier au moment de la décision, et c'est à lui qu'on la doit.
  await notifyCarrierOfStructural(id, before.responsibleId, user.id, before.reference, dci, structural.changes);

  if (assistantId && assistantId !== user.id && assistantId !== before.assistantId) {
    await notifyUser({
      userId: assistantId,
      type: "ASSIGNMENT",
      title: "Dossier réglementaire assigné",
      body: `${before.reference} — ${dci}`,
      link: `/regulatory/${id}`,
    });
  }

  revalidatePath(`/regulatory/${id}`);
  revalidatePath("/regulatory");
  return { ok: true, id, message: structural.refusal ?? undefined };
}

/**
 * Participants du dossier : collaborateurs qui peuvent VOIR et travailler le dossier
 * (accès ligne via `assignedUsers`, cf. scopeRegulatory). Le responsable et l'assistant
 * y sont toujours inclus. Ouvre la collaboration à plusieurs, dossiers actuels ET nouveaux.
 */
export async function setRegulatoryParticipants(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE"))) return { ok: false, error: "Non autorisé." };
  const product = await prisma.regulatoryProduct.findUnique({ where: { id }, select: { responsibleId: true, assistantId: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };
  const participantIds = formData.getAll("participantIds").map(String).filter(Boolean);
  const ids = Array.from(new Set([product.responsibleId, product.assistantId, ...participantIds].filter(Boolean))) as string[];
  await prisma.regulatoryProduct.update({ where: { id }, data: { assignedUsers: { set: ids.map((uid) => ({ id: uid })) } } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: id, summary: `Participants du dossier — ${ids.length} collaborateur(s)` });
  revalidatePath(`/regulatory/${id}`);
  return { ok: true };
}

/** Modifier la priorité d'un dossier (Direction / équipe Regulatory) depuis le tableau. */
/** La priorité est fixée par la SUPERVISION (Super Admin + rôles configurés en Administration). */
export async function setRegulatoryPriority(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  const priority = str(formData, "priority");
  if (!id || !priority) return { ok: false, error: "Paramètres manquants." };
  if (!(await ensureRegSupervisor(user))) return { ok: false, error: "Réservé à la supervision Regulatory." };
  await prisma.regulatoryProduct.update({ where: { id }, data: { priority: priority as Priority } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: id, field: "priority", newValue: priority, summary: "Priorité du dossier modifiée" });
  revalidatePath("/regulatory");
  revalidatePath(`/regulatory/${id}`);
  return { ok: true };
}

/**
 * VERROUILLER / DÉVERROUILLER un dossier — le cadenas.
 *
 * Un dossier verrouillé n'existe pour personne d'autre : ni la Direction, ni son responsable,
 * ni une autorisation nominative ne l'ouvrent (`scopeRegulatory` → `lockGate`). C'est ce qui
 * permet de charger un portefeuille encore confidentiel dans l'outil sans le publier à l'équipe.
 *
 * Le droit ne se vérifie PAS sur le module : « qui peut modifier un dossier » est une question
 * bien plus large que « qui décide de ce qui est confidentiel ». Il se règle en Administration —
 * le Super Admin, et ceux à qui il confie le cadenas (`lib/regulatory/pipeline-access.ts`).
 */
export async function setRegulatoryLock(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!holdsRegulatoryLock(user)) {
    return { ok: false, error: "Vous ne tenez pas le cadenas des dossiers réglementaires." };
  }
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  const locked = str(formData, "locked") === "1";
  const before = await prisma.regulatoryProduct.findUnique({ where: { id }, select: { reference: true, dci: true, isLocked: true } });
  if (!before) return { ok: false, error: "Dossier introuvable." };
  if (before.isLocked === locked) return { ok: true, id };

  await prisma.regulatoryProduct.update({ where: { id }, data: { isLocked: locked, updatedById: user.id } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT",
    entityId: id, field: "isLocked", newValue: locked ? "true" : "false",
    summary: `${before.reference} — dossier ${locked ? "verrouillé (invisible pour l'équipe)" : "déverrouillé (visible par l'équipe)"}`,
  });
  // ENTRÉ AU SUIVI : il reçoit son dossier Drive (catégorie « Regulatory »), pièces déjà déposées comprises.
  if (!locked) {
    void synchroniserDossierDrive(id, user.id)
      .catch((e) => console.error("[drive regulatory] dossier Drive non synchronisé (non bloquant)", e));
    // …et entre au catalogue : un dossier visible EST un produit (Direction, 08/10).
    await ensureProduitDuDossier(id, { acteurId: user.id })
      .catch((e) => console.error("[produits] produit du dossier au déverrouillage", e));
  }
  revalidatePath("/regulatory");
  revalidatePath(`/regulatory/${id}`);
  // LE PIPELINE AUSSI — c'est l'écran d'où l'on déverrouille, et le seul dont le contenu CHANGE
  // du fait de ce geste. Sans cette ligne, le dossier ouvert restait affiché parmi les verrouillés
  // jusqu'à expiration du cache de navigation : on croyait que le déverrouillage n'avait rien fait.
  revalidatePath("/regulatory/pipeline");
  return { ok: true, id };
}

/**
 * OUVRIR LE CADENAS SUR TOUT ce qui est verrouillé — un portefeuille se publie d'un geste, pas
 * ligne par ligne sur 69 dossiers. Réservé à qui tient le cadenas, audité avec le nombre réel de
 * dossiers ouverts : rendre visible un portefeuille entier est une décision.
 *
 * Volontairement à SENS UNIQUE. Un « tout verrouiller » symétrique ferait disparaître le
 * catalogue Regulatory entier pour toute l'entreprise d'un seul clic — le verrouillage se
 * décide donc dossier par dossier, où l'on voit ce que l'on ferme.
 */
export async function unlockAllRegulatory(): Promise<ActionResult> {
  const user = await requireUser();
  if (!holdsRegulatoryLock(user)) {
    return { ok: false, error: "Vous ne tenez pas le cadenas des dossiers réglementaires." };
  }
  const ouverts = await prisma.regulatoryProduct.findMany({ where: { isLocked: true }, select: { id: true } });
  const res = await prisma.regulatoryProduct.updateMany({
    where: { id: { in: ouverts.map((p) => p.id) }, isLocked: true },
    data: { isLocked: false, updatedById: user.id },
  });
  if (res.count === 0) return { ok: true };
  // Entrés au suivi : chacun reçoit son dossier Drive, l'un après l'autre, en arrière-plan.
  void (async () => {
    for (const p of ouverts) {
      await synchroniserDossierDrive(p.id, user.id)
        .catch((e) => console.error("[drive regulatory] dossier Drive non synchronisé (non bloquant)", { id: p.id }, e));
    }
  })();
  // Entrés au catalogue : chaque dossier ouvert EST un produit (Direction, 08/10).
  for (const p of ouverts) {
    await ensureProduitDuDossier(p.id, { acteurId: user.id })
      .catch((e) => console.error("[produits] produit du dossier au déverrouillage", { id: p.id }, e));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT",
    entityId: "*", field: "isLocked", newValue: "false",
    summary: `${res.count} dossier(s) déverrouillés en une fois — désormais visibles par l'équipe`,
  });
  revalidatePath("/regulatory");
  // Le pipeline se vide d'un coup : c'est précisément ce qu'on doit voir après ce bouton.
  revalidatePath("/regulatory/pipeline");
  return { ok: true };
}

/**
 * LA PERSONNE CHARGÉE DU DOSSIER, choisie directement dans le tableau Regulatory.
 *
 * Assigner, c'est aussi DONNER L'ACCÈS : `scopeRegulatory` filtre les dossiers sur les
 * participants, donc le nouveau responsable est rattaché aux participants — sans quoi il
 * porterait un dossier qu'il ne verrait pas. L'ancien responsable, lui, n'est pas retiré :
 * il a travaillé dessus, et lui couper la vue en cours de route ferait perdre l'historique
 * à la seule personne qui le connaît. Le panneau « Participants » reste le lieu du retrait.
 *
 * Un choix vide libère le dossier — c'est une décision valable (personne n'est encore désigné).
 */
export async function setRegulatoryResponsible(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  // CONFIER UN DOSSIER EST UN ENGAGEMENT PRIS AU NOM DE QUELQU'UN : c'est l'un des trois champs
  // réservés au Super Admin (voir `lib/regulatory/structural-fields.ts`).
  if (!canSetStructural(user)) {
    return { ok: false, error: "Seul le Super Admin désigne le chargé d'un dossier." };
  }
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }
  const before = await prisma.regulatoryProduct.findUnique({
    where: { id },
    select: { reference: true, dci: true, responsibleId: true, isLocked: true },
  });
  if (!before) return { ok: false, error: "Dossier introuvable." };

  const responsibleId = str(formData, "responsibleId");
  if (responsibleId) {
    const ok = await prisma.user.count({ where: { id: responsibleId, isActive: true } });
    if (!ok) return { ok: false, error: "Personne inconnue ou compte désactivé." };
  }
  if (responsibleId === before.responsibleId) return { ok: true, id };

  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      responsibleId,
      updatedById: user.id,
      ...(responsibleId ? { assignedUsers: { connect: { id: responsibleId } } } : {}),
    },
  });

  const target = responsibleId
    ? await prisma.user.findUnique({ where: { id: responsibleId }, select: { name: true, role: true, secondaryRole: true } })
    : null;
  const named = responsibleId ? target?.name ?? "—" : null;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT",
    entityId: id, field: "responsibleId", newValue: responsibleId ?? "",
    summary: named ? `Dossier confié à ${named}` : "Dossier sans personne chargée",
  });
  // Annoncé à la frontière : Adam apprend le changement sans relire le portefeuille.
  emit({
    type: "regulatory.owner-changed",
    subject: { type: "regulatory_product", id },
    actorId: user.id,
    data: { ownerId: responsibleId ?? null, ownerName: named },
  });

  // LE CADENAS NE CÈDE PAS DEVANT UN RESPONSABLE NOMMÉ — mais on ne fait pas semblant. Désigner
  // qui portera un produit encore à l'étude est légitime (on prépare l'équipe avant d'ouvrir) ;
  // envoyer pour autant un lien qui s'ouvre sur un 404 ne l'est pas. On dit donc les deux : à la
  // personne, que le dossier n'apparaîtra qu'à l'ouverture du cadenas ; et à celui qui vient de
  // le confier, la même chose, tout de suite.
  // Les DEUX clés du pipeline (Direction, 08/10) : la confidence ET le module « Pipeline réglementaire » de la console.
  const seesLocked = target
    ? seesLockedRegulatory({
        id: responsibleId as string, role: target.role, secondaryRole: target.secondaryRole,
        access: await getAccess(responsibleId as string, target.role),
      })
    : false;

  if (responsibleId && responsibleId !== user.id) {
    const notice = assignmentNotice({
      reference: before.reference, dci: before.dci, locked: before.isLocked, seesLocked,
    });
    await notifyUser({ userId: responsibleId, type: "ASSIGNMENT", ...notice, link: `/regulatory/${id}` });
  }

  revalidatePath("/regulatory");
  revalidatePath(`/regulatory/${id}`);
  return { ok: true, id, message: assignmentWarning({ locked: before.isLocked, seesLocked }) ?? undefined };
}

/** Dates cibles (dépôt + enregistrement) — fixées par la supervision Regulatory. */
export async function setRegulatoryTargetDates(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await ensureRegSupervisor(user))) return { ok: false, error: "Réservé à la supervision Regulatory." };
  const subRaw = str(formData, "targetSubmissionDate");
  const regRaw = str(formData, "targetDate");
  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      targetSubmissionDate: subRaw ? new Date(subRaw) : null,
      targetDate: regRaw ? new Date(regRaw) : null,
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: id, summary: "Dates cibles (dépôt / enregistrement) mises à jour" });
  revalidatePath("/regulatory");
  revalidatePath(`/regulatory/${id}`);
  return { ok: true };
}

/**
 * La supervision (Super Admin / rôle configuré) DEMANDE une mise à jour de statut sur
 * l'enregistrement d'un produit : notifie le responsable, l'assistant et les participants
 * du dossier. N'écrit pas le statut — c'est une relance traçable.
 */
export async function requestRegulatoryStatusUpdate(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await ensureRegSupervisor(user))) return { ok: false, error: "Réservé à la supervision Regulatory." };
  const product = await prisma.regulatoryProduct.findUnique({
    where: { id },
    select: { reference: true, dci: true, responsibleId: true, assistantId: true, assignedUsers: { select: { id: true } } },
  });
  if (!product) return { ok: false, error: "Dossier introuvable." };
  const note = str(formData, "note");
  const targets = Array.from(new Set([
    product.responsibleId, product.assistantId, ...product.assignedUsers.map((u) => u.id),
  ].filter((x): x is string => Boolean(x) && x !== user.id)));
  await Promise.all(targets.map((userId) => notifyUser({
    userId,
    type: "GENERIC",
    title: "Mise à jour de statut demandée",
    body: `${product.reference} — ${product.dci}${note ? ` · ${note}` : ""}`,
    link: `/regulatory/${id}`,
  })));
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: id, summary: `Demande de mise à jour de statut (${targets.length} destinataire(s))` });
  return { ok: true };
}

export async function updateRegulatoryStep(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const stepId = str(formData, "stepId");
  if (!stepId) return { ok: false, error: "Étape introuvable." };

  const step = await prisma.regulatoryStep.findUnique({
    where: { id: stepId },
    include: { product: { select: { id: true, reference: true } } },
  });
  if (!step) return { ok: false, error: "Étape introuvable." };

  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", step.productId, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }

  const status = (str(formData, "status") as StepStatus) ?? step.status;
  const plannedDate = str(formData, "plannedDate");
  const actualDate = str(formData, "actualDate");
  const comment = str(formData, "comment");
  const missingDocs = str(formData, "missingDocs");

  await prisma.regulatoryStep.update({
    where: { id: stepId },
    data: {
      status,
      plannedDate: plannedDate ? new Date(plannedDate) : null,
      actualDate: actualDate ? new Date(actualDate) : null,
      comment,
      missingDocs,
      responsible: str(formData, "responsible"),
    },
  });

  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Regulatory",
    entityType: "REGULATORY_STEP",
    entityId: stepId,
    field: "status",
    oldValue: step.status,
    newValue: status,
    summary: `Étape mise à jour sur ${step.product.reference}`,
  });

  revalidatePath(`/regulatory/${step.productId}`);
  return { ok: true };
}

export async function updateRegulatoryStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }
  const before = await prisma.regulatoryProduct.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Dossier introuvable." };

  const priority = (str(formData, "priority") as Priority) ?? before.priority;

  /**
   * LE NIVEAU DE PROCESS NE SE POSE PLUS À LA MAIN.
   *
   * Cette action n'écrit plus que la PRIORITÉ. Le niveau — « Déposé », « Attente ANPP »… — est
   * DÉDUIT des étapes cochées (`syncStatusFromWorkflow`) : deux endroits pour dire où en est un
   * dossier finissaient toujours par se contredire, et c'est la version fausse qu'on lisait dans
   * le tableau de suivi.
   *
   * Un `status` envoyé par un appelant qui l'ignore encore n'est pas une erreur : on le lit
   * comme une DEMANDE D'AVANCEMENT, et l'on coche les étapes jusqu'à son jalon — le niveau
   * suivra tout seul, par la seule route qui existe désormais.
   */
  const asked = str(formData, "status") as RegulatoryStatus | null;
  const milestone = asked && asked !== before.status ? REG_STATUS_MILESTONE[asked] : undefined;
  let wf = (before.workflow as RegWorkflowState | null) ?? {};
  let autoSteps = 0;
  if (milestone) {
    const sync = completeStepsThrough(wf, milestone);
    if (sync.changed > 0) { wf = sync.state; autoSteps = sync.changed; }
  }

  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      priority, updatedById: user.id,
      ...(autoSteps > 0 ? { workflow: wf as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  if (autoSteps > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory",
      entityType: "REGULATORY_PRODUCT", entityId: id, field: "workflow",
      summary: `${autoSteps} étape·s du processus comptée·s pour amener ${before.reference} à « ${asked} »`,
    });
  }
  // Le niveau suit les étapes — y compris celles qu'on vient de compter.
  await syncStatusFromWorkflow(id, wf, before.status, before.reference, user.id);

  revalidatePath(`/regulatory/${id}`);
  revalidatePath("/regulatory");
  return { ok: true };
}

export async function addRegulatoryComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  const body = str(formData, "body");
  if (!productId || !body) return { ok: false, error: "Commentaire vide." };

  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "VIEW"))) {
    return { ok: false, error: "Action non autorisée." };
  }

  await prisma.comment.create({
    data: { entityType: "REGULATORY_PRODUCT", entityId: productId, body, authorId: user.id },
  });
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

// ───────────────────────── Processus officiel ANPP (workflow + checklist) ─────────────────────────

// `syncStatusFromWorkflow` — le seul écrivain du niveau de process — vit dans `lib/regulatory/sync-status.ts` :
// le règlement d'un BV par les Finances (qui coche « Paiement du BV ») l'appelle aussi.

/** Met à jour l'état d'une étape du processus ANPP (statut + date + note) sur un produit. */
export async function setRegulatoryStepState(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  const stepKey = str(formData, "stepKey");
  const status = str(formData, "status");
  if (!productId || !stepKey || !status) return { ok: false, error: "Paramètres manquants." };
  if (!isRegStepKey(stepKey) || !isRegStepState(status)) return { ok: false, error: "Étape ou statut invalide." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { workflow: true, status: true, reference: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  const wf = { ...((product.workflow as RegWorkflowState | null) ?? {}) };
  const date = str(formData, "date");
  const note = str(formData, "note");
  wf[stepKey] = {
    status,
    date: date && date.trim() ? date.trim() : (status === "DONE" ? new Date().toISOString().slice(0, 10) : wf[stepKey]?.date),
    note: note !== null ? (note.trim() || undefined) : wf[stepKey]?.note,
  };

  await prisma.regulatoryProduct.update({ where: { id: productId }, data: { workflow: wf as unknown as Prisma.InputJsonValue } });
  const stepLabel = REG_STEPS.find((s) => s.key === stepKey)?.label ?? stepKey;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId, field: "workflow", newValue: status, summary: `Étape ANPP « ${stepLabel} » → ${status}` });
  await syncStatusFromWorkflow(productId, wf, product.status, product.reference, user.id);
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

/**
 * AVIS de la réponse de présoumission (étape « presub_ans ») : Favorable → le processus
 * CONTINUE (étape « Fait ») ; Défavorable → étape « Bloqué » (à corriger et redemander) ;
 * En attente → étape « En cours ». Le statut d'étape est dérivé de l'avis (source unique).
 */
export async function setRegulatoryPresubOutcome(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  const outcome = str(formData, "outcome");
  if (!productId || !outcome) return { ok: false, error: "Paramètres manquants." };
  if (!isRegPresubOutcome(outcome)) return { ok: false, error: "Avis invalide." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { workflow: true, status: true, reference: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  const wf = { ...((product.workflow as RegWorkflowState | null) ?? {}) };
  const mapped = REG_PRESUB_OUTCOME[outcome];
  const note = str(formData, "note");
  wf[PRESUB_ANSWER_STEP] = {
    status: mapped.status,
    outcome,
    date: mapped.status === "DONE" ? new Date().toISOString().slice(0, 10) : wf[PRESUB_ANSWER_STEP]?.date,
    note: note !== null ? (note.trim() || undefined) : wf[PRESUB_ANSWER_STEP]?.note,
  };

  await prisma.regulatoryProduct.update({ where: { id: productId }, data: { workflow: wf as unknown as Prisma.InputJsonValue } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId, field: "workflow", newValue: outcome, summary: `Présoumission → ${mapped.label}` });
  // L'avis de présoumission est le VERROU du dossier : il change son niveau de process à lui
  // seul (défavorable → bloqué, favorable → le dossier est engagé).
  await syncStatusFromWorkflow(productId, wf, product.status, product.reference, user.id);
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

/** Enregistre uniquement le commentaire d'une étape ANPP (sans changer son statut). */
export async function setRegulatoryStepNote(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  const stepKey = str(formData, "stepKey");
  if (!productId || !stepKey) return { ok: false, error: "Paramètres manquants." };
  if (!isRegStepKey(stepKey)) return { ok: false, error: "Étape invalide." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { workflow: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  const note = str(formData, "note");
  const wf = { ...((product.workflow as RegWorkflowState | null) ?? {}) };
  wf[stepKey] = { ...(wf[stepKey] ?? {}), status: wf[stepKey]?.status ?? "TODO", note: note && note.trim() ? note.trim() : undefined };

  await prisma.regulatoryProduct.update({ where: { id: productId }, data: { workflow: wf as unknown as Prisma.InputJsonValue } });
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

/**
 * « Demande de BV » : émet un ordre de dépense (envoyé à l'espace comptable) avec
 * montant + échéance, et joint éventuellement un justificatif (proforma BV). Le
 * comptable le voit dans les ordres de dépense / Finances.
 */
export async function requestBV(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  if (!productId) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { reference: true, dci: true, workflow: true, status: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  // LA NATURE DU BV EST CELLE DE L'ÉTAPE d'où l'on part (« Demande du BV 25 % » → BV 25 %) : un
  // `bvType` envoyé à côté ne la contredit pas. Sans étape (assistant, ancien appel), le libellé libre.
  const stepKey = str(formData, "stepKey");
  const etapeValide = stepKey && isRegStepKey(stepKey) ? stepKey : null;
  const bvType = (etapeValide && BV_REQUEST_STEPS[etapeValide]) || str(formData, "bvType") || "BV";
  const nature = natureDuLibelle(bvType);
  const amount = Number(str(formData, "amount"));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Montant invalide." };
  const dueRaw = str(formData, "dueDate");
  const note = str(formData, "note");

  // LES PIÈCES SE JUGENT AVANT L'ORDRE (§118.202) : un fichier refusé après la création laissait un
  // ordre au centre de paiement — sans pièce, et qu'une seconde tentative doublait.
  const files = [...formData.getAll("files"), formData.get("file")]
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 0) {
    const maxMb = (await getAppSettings()).maxUploadMb;
    for (const file of files) {
      const err = validateUpload(file.name, file.size, maxMb);
      if (err) return { ok: false, error: err };
    }
  }

  // L'ORDRE NAÎT EN ATTENTE DU CENTRE DE PAIEMENT (`initialCentralStatus`, aucune exemption de
  // module) ; les Finances ne le voient qu'une fois autorisé. Son entité est celle du DOSSIER.
  const label = `${bvType} — ${product.reference} ${product.dci}`;
  const emettre = async () => createExpenseOrder({
    label,
    amount,
    category: "IMPOT",
    beneficiary: "ANPP",
    sourceType: "REGULATORY_PRODUCT",
    sourceId: productId,
    requestedById: user.id,
    notes: note,
    dueDate: dueRaw ? new Date(dueRaw) : null,
    // BUDGET REGULATORY (08/10) : le BV naît rangé dans la catégorie de SA part (25 % ou 75 %) de l'enveloppe
    // Regulatory active — il s'y imputera à son règlement. Aucune enveloppe → le chemin ordinaire.
    budgetCategoryId: await categorieBvPourOrdre(label),
  });

  // UN BV DE CETTE NATURE À LA FOIS, PAR DOSSIER. Un double clic (ou deux personnes sur le même
  // dossier) émettait deux ordres — deux paiements du même bon à l'ANPP au centre. Le contrôle et
  // l'émission se font SOUS UN VERROU propre au couple (dossier, nature) : la seconde demande attend
  // la première, puis lit son ordre et s'arrête. Seuls un refus du centre ou une annulation rendent
  // la main — redemander un BV refusé est le geste prévu (`bloqueUneNouvelleDemande`).
  let order: Awaited<ReturnType<typeof emettre>>;
  if (nature) {
    const issue = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bv-demande'), hashtext(${`${productId}:${nature}`}))`;
      const existants = await tx.expenseOrder.findMany({
        where: { sourceType: "REGULATORY_PRODUCT", sourceId: productId, status: { not: "CANCELLED" } },
        select: { reference: true, label: true, status: true, centralStatus: true },
        orderBy: { createdAt: "desc" },
      });
      const vivant = existants.find((o) => natureDuLibelle(o.label) === nature && bloqueUneNouvelleDemande(o));
      if (vivant) return { deja: vivant, cree: null };
      return { deja: null, cree: await emettre() };
    }, { maxWait: 10_000, timeout: 30_000 });
    if (issue.deja) {
      const etat = etatDeLOrdreBv(issue.deja) ?? "DEMANDE";
      return {
        ok: false,
        error: `Le ${bvType} de ce dossier est déjà demandé (${issue.deja.reference} — ${ETAT_BV[etat].label.toLowerCase()}, ${ETAT_BV[etat].detail}). Une seconde demande ferait payer deux fois le même bon ; on ne redemande qu'un BV refusé par le centre de paiement.`,
      };
    }
    if (!issue.cree) return { ok: false, error: "La demande n'a pas pu être émise : réessayez." };
    order = issue.cree;
  } else {
    order = await emettre();
  }

  // JUSTIFICATIFS — UNE OU PLUSIEURS PIÈCES. Un BV arrive rarement seul : proforma, courrier
  // de l'agence, calcul du montant. N'en accepter qu'une obligeait à choisir laquelle compte,
  // puis à déposer le reste ailleurs — c'est-à-dire nulle part.
  if (files.length > 0) {
    for (const file of files) {
      const key = `EXPENSE_ORDER/${order.id}/${randomUUID()}__${file.name}`;
      try {
        await saveFile(key, Buffer.from(await file.arrayBuffer()));
      } catch (e) {
        console.error("[requestBV] storage write failed", e);
      }
      await prisma.document.create({
        data: {
          name: file.name, category: "PROFORMA", entityType: "EXPENSE_ORDER", entityId: order.id,
          fileKey: key, mimeType: file.type || null, sizeBytes: file.size, confidentiality: "INTERNAL", uploadedById: user.id,
        },
      });
    }
  }

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId,
    summary: `Demande de ${bvType} (${amount.toLocaleString("fr-FR")} DZD)${files.length ? ` · ${files.length} pièce·s` : ""} → ordre ${order.reference}`,
  });

  // DEMANDÉ DEPUIS LE PROCESSUS : l'étape « Demande du BV … » est faite — la demande EST
  // l'étape. La cocher à part serait redire d'un second geste ce que le premier a prouvé.
  if (etapeValide) {
    const wf = { ...((product.workflow as RegWorkflowState | null) ?? {}) };
    if (wf[etapeValide]?.status !== "DONE") {
      wf[etapeValide] = { ...wf[etapeValide], status: "DONE", date: wf[etapeValide]?.date ?? new Date().toISOString().slice(0, 10) };
      await prisma.regulatoryProduct.update({ where: { id: productId }, data: { workflow: wf as unknown as Prisma.InputJsonValue } });
      await syncStatusFromWorkflow(productId, wf, product.status, product.reference, user.id);
    }
  }

  revalidatePath(`/regulatory/${productId}`);
  revalidatePath("/finances");
  revalidatePath("/centre-de-paiement");
  return { ok: true, message: `Demande de ${bvType} envoyée au centre de paiement (${order.reference}) : les Finances la régleront une fois autorisée.` };
}

/** Coche / décoche un document de la checklist de présoumission (avec note facultative). */
export async function setRegulatoryChecklistItem(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  const itemKey = str(formData, "itemKey");
  if (!productId || !itemKey) return { ok: false, error: "Paramètres manquants." };
  if (!isRegChecklistKey(itemKey)) return { ok: false, error: "Document invalide." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { checklist: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  const checked = str(formData, "checked") === "true";
  const note = str(formData, "note");
  const cl = { ...((product.checklist as RegChecklistState | null) ?? {}) };
  cl[itemKey] = { checked, note: note !== null ? (note.trim() || undefined) : cl[itemKey]?.note };

  await prisma.regulatoryProduct.update({ where: { id: productId }, data: { checklist: cl as unknown as Prisma.InputJsonValue } });
  const itemLabel = REG_CHECKLIST.flatMap((g) => g.items).find((i) => i.key === itemKey)?.label ?? itemKey;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId, field: "checklist", newValue: checked ? "coché" : "décoché", summary: `Document présoumission « ${itemLabel} » ${checked ? "fourni" : "retiré"}` });
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

// ─────────────────────────── Variations de fabrication ───────────────────────────
// Après la DE d'un produit, on peut demander une variation vers un packaging local
// (secondaire / primaire / full process). Chaîne possible dans le temps ; à l'obtention,
// le statut de fabrication du produit est mis à jour.

/** Ouvre une variation (dépôt) vers un statut de fabrication supérieur. */
export async function createVariation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = str(formData, "productId");
  if (!productId) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const toStatus = str(formData, "toStatus");
  if (!toStatus || !VARIATION_TARGETS.includes(toStatus)) {
    return { ok: false, error: "Statut de fabrication de variation invalide." };
  }
  const depotRaw = str(formData, "depotDate");
  await prisma.regulatoryVariation.create({
    data: {
      productId,
      toStatus: toStatus as ManufacturingStatus,
      status: "EN_ATTENTE",
      depotDate: depotRaw ? new Date(depotRaw) : null,
      manufacturer: str(formData, "manufacturer"),
      note: str(formData, "note"),
      createdById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId, summary: `Variation déposée → ${toStatus}` });
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

/** Met à jour le statut d'une variation ; si « DE obtenue », promeut le statut de fabrication du produit. */
export async function setVariationStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  const status = str(formData, "status");
  if (!id || !status || !["EN_ATTENTE", "OBTENUE", "ANNULE"].includes(status)) {
    return { ok: false, error: "Paramètres invalides." };
  }
  const variation = await prisma.regulatoryVariation.findUnique({ where: { id }, select: { id: true, productId: true, toStatus: true, manufacturer: true } });
  if (!variation) return { ok: false, error: "Variation introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", variation.productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };
  // « OBTENUE » PROMEUT LE STATUT DE FABRICATION du produit — c'est la porte dérobée du verrou :
  // sans cette garde, on changerait le statut réservé au Super Admin en déclarant une variation
  // obtenue. Déposer une variation, la mettre en attente ou l'annuler restent ouverts : ce sont
  // des faits du dossier, pas la décision industrielle.
  if (status === "OBTENUE" && !canSetStructural(user)) {
    return { ok: false, error: "Seul le Super Admin acte une variation obtenue : elle fait évoluer le statut de fabrication." };
  }

  const decisionRaw = str(formData, "decisionDate");
  const decisionDate = decisionRaw ? new Date(decisionRaw) : status === "OBTENUE" ? new Date() : null;
  await prisma.regulatoryVariation.update({
    where: { id },
    data: { status: status as VariationStatus, decisionDate },
  });

  // À l'obtention, le statut de fabrication du produit devient la cible de la variation.
  if (status === "OBTENUE") {
    const product = await prisma.regulatoryProduct.findUnique({
      where: { id: variation.productId },
      select: { reference: true, dci: true, manufacturingStatus: true, responsibleId: true },
    });
    await prisma.regulatoryProduct.update({
      where: { id: variation.productId },
      data: {
        manufacturingStatus: variation.toStatus,
        ...(variation.manufacturer ? { manufacturer: variation.manufacturer } : {}),
        variationDate: decisionDate,
        updatedById: user.id,
      },
    });
    // MÊME CHANGEMENT, MÊME ANNONCE. Que le statut bouge par la fiche ou par une variation
    // obtenue, c'est la même décision industrielle : le chargé du dossier l'apprend.
    if (product && product.manufacturingStatus !== variation.toStatus) {
      await notifyCarrierOfStructural(
        variation.productId, product.responsibleId, user.id, product.reference, product.dci,
        [{
          field: "manufacturingStatus",
          label: STRUCTURAL_LABELS.manufacturingStatus,
          from: MANUFACTURING_STATUS[product.manufacturingStatus] ?? product.manufacturingStatus,
          to: MANUFACTURING_STATUS[variation.toStatus] ?? variation.toStatus,
        }],
      );
    }
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: variation.productId, summary: `Variation → ${variation.toStatus} : ${status}` });
  revalidatePath(`/regulatory/${variation.productId}`);
  return { ok: true };
}

/** Supprime une variation (responsable / privilégié). */
export async function deleteVariation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Variation introuvable." };
  const variation = await prisma.regulatoryVariation.findUnique({ where: { id }, select: { productId: true } });
  if (!variation) return { ok: false, error: "Variation introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", variation.productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };
  await prisma.regulatoryVariation.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: variation.productId, summary: "Variation supprimée" });
  revalidatePath(`/regulatory/${variation.productId}`);
  return { ok: true };
}

/**
 * L'ENTITÉ et les SEGMENTS THÉRAPEUTIQUES, changés depuis le tableau.
 *
 * Les deux se corrigent à la volée parce qu'on s'en aperçoit EN LISANT la liste — « celui-là
 * n'est pas chez Pharmagène », « celui-là sert aussi la gynéco ». Ouvrir la fiche, corriger,
 * revenir, retrouver sa ligne : c'est ce parcours-là qui fait qu'on ne corrige pas.
 *
 * L'entité gouverne QUI VOIT le dossier : la changer est un acte de cloisonnement, pas un
 * détail de saisie — d'où le même droit que la modification de la fiche, et l'audit.
 */
export async function setRegulatoryClassification(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }
  const before = await prisma.regulatoryProduct.findUnique({
    where: { id }, select: { reference: true, companyId: true, therapeuticSegments: true },
  });
  if (!before) return { ok: false, error: "Dossier introuvable." };

  const data: {
    companyId?: string | null; therapeuticSegments?: string[]; bdProjectId?: string | null; updatedById: string;
  } = { updatedById: user.id };

  // L'ENTITÉ décide de QUI voit le dossier : la changer, c'est le déplacer d'une société à une
  // autre. Réservée au Super Admin. Les SEGMENTS, eux, restent ouverts — ce sont des étiquettes
  // de classement, elles n'ouvrent ni ne ferment rien.
  if (formData.has("companyId")) {
    const companyId = str(formData, "companyId");
    if ((companyId || null) !== before.companyId && !canSetStructural(user)) {
      return { ok: false, error: "Seul le Super Admin change l'entité d'un dossier." };
    }
    if (companyId) {
      const known = await prisma.company.count({ where: { id: companyId } });
      if (!known) return { ok: false, error: "Entité inconnue." };
    }
    data.companyId = companyId || null;
  }

  if (formData.has("segments")) {
    // Liste blanche : un segment inventé ne se compte avec rien, et c'est le comptage qu'on
    // vient chercher. La liste effective est celle réglée par l'administrateur (sinon la liste
    // par défaut) ; un segment DÉJÀ posé sur la fiche reste accepté même s'il a depuis quitté le
    // référentiel — sinon on ne pourrait plus le retirer.
    const settings = await getAppSettings();
    const allowed = new Set([
      ...effectiveTherapeuticSegments(settings.regulatoryTherapeuticSegments),
      ...(before.therapeuticSegments ?? []),
    ]);
    const picked = formData.getAll("segments").map(String).filter((v) => allowed.has(v));
    data.therapeuticSegments = [...new Set(picked)];
  }

  // LE PROJET BD — une ÉTIQUETTE de classement, comme les segments : elle n'ouvre ni ne ferme
  // aucun accès (contrairement à l'entité), donc elle suit le droit de MODIFIER le dossier et
  // non le privilège structurel. Le projet est vérifié VISIBLE, par la clause même du menu qui le
  // propose (`projetsBdVisibles`, §118.163) : un identifiant que le menu ne donne pas — inconnu,
  // ou d'un projet que la personne ne voit pas — rangerait le dossier dans un projet qu'elle ne
  // pourrait plus retrouver, et le tableau afficherait une case vide sans rien dire.
  if (formData.has("bdProjectId")) {
    const projectId = str(formData, "bdProjectId");
    if (projectId) {
      const visible = await prisma.bdProject.count({ where: { AND: [{ id: projectId }, await projetsBdVisibles(user)] } });
      if (!visible) return { ok: false, error: "Projet inconnu, ou que vous ne voyez pas (module « Projets », ou autre entité)." };
    }
    data.bdProjectId = projectId || null;
  }

  await prisma.regulatoryProduct.update({ where: { id }, data });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Regulatory",
    entityType: "REGULATORY_PRODUCT", entityId: id,
    summary: `Classement mis à jour — ${before.reference}`,
  });
  revalidatePath("/regulatory");
  revalidatePath("/regulatory/pipeline");
  // Le sous-module « Projets » de Business Development LIT ce classement : sans cette ligne, on
  // range un dossier dans un projet et son tableau ne le montre pas avant la prochaine visite.
  revalidatePath("/business-development/projets");
  return { ok: true, id };
}
