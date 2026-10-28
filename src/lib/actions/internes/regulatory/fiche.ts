/**
 * REGULATORY — les CORPS des gestes sur la fiche d'un dossier : la création (et son annonce), la modification, le
 * chargé, le classement, une étape, le niveau demandé, la relance de statut, une variation (déposée, actée), la
 * demande de BV.
 *
 * Sortis de `actions/regulatory-actions.ts` (lot V4). Chaque action garde sa porte (session, droits, dossier),
 * sa trace d'audit et ses annonces ; elle passe le FORMULAIRE à son corps, qui lit, contrôle et écrit. Pour le
 * contrat des actions, ce corps est celui du fichier d'actions (`contrat/internes.ts`) : ses champs, ses
 * écritures et ses écrivains importés comptent pour l'action.
 */
import { randomUUID } from "crypto";
import type {
  ManufacturingStatus, Priority, ProductType, RegulatoryCategory, RegulatoryProduct, RegulatoryStatus, StepStatus,
  VariationStatus,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/lib/actions/types";
import { projetsBdVisibles } from "@/lib/queries/bd";
import { buildRef, createWithRetry, enSerie } from "@/lib/refs";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { ensureProduitDuDossier } from "@/lib/products/canonique";
import { phraseProduitDuDossier } from "@/lib/products/produit-du-dossier";
import { creerDossierDriveProduit } from "@/lib/regulatory-drive-dossier";
import { regSupervisorRoles } from "@/lib/regulatory/sync-status";
import { createExpenseOrder } from "@/lib/expense-orders";
import { categorieBvPourOrdre } from "@/lib/queries/budget-regulatory";
import { natureDuLibelle } from "@/lib/budget-regulatory/bv";
import { saveFile } from "@/lib/storage";
import { REGULATORY_STEP_ORDER, VARIATION_TARGETS } from "@/lib/labels";
import { BV_REQUEST_STEPS } from "@/lib/regulatory-workflow";
import { parseProductChannel, upperMolecules, normalizeDci } from "@/lib/actions/internes/regulatory/dossier";
import { annoncerLaFabrication, guardStructural } from "@/lib/actions/internes/regulatory/structurel";
import {
  avancerJusquAuJalon, emettreSousVerrou, refusBvDejaDemande, refusDesPieces, segmentsAdmis,
} from "@/lib/actions/internes/regulatory/processus";

/** L'arrêt de l'action, avec ce qu'elle rend — un type nommé, pour que `"fini" in …` le distingue de la suite. */
const arret = (r: ActionResult): { fini: ActionResult } => ({ fini: r });

/** Le lecteur du fichier d'actions — même règle : une valeur vide vaut `null`. */
function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  return v ? String(v) : null;
}

type Refus = { ok: false; error: string };

/**
 * `createRegulatoryProduct`, une fois la saisie contrôlée : la référence calculée sous la file, le dossier et
 * ses dix-sept étapes, ses responsables rattachés comme participants.
 */
export async function creerLeDossier(
  formData: FormData,
  ctx: {
    user: SessionUser; dci: string; molecules: string[]; companyId: string; lockOnCreate: boolean;
    manufacturingVariation: string | null; manufacturer: string | null;
  },
) {
  const { user, dci, molecules, companyId, lockOnCreate, manufacturingVariation, manufacturer } = ctx;
  const year = new Date().getFullYear();

  const responsibleId = str(formData, "responsibleId");
  const assistantId = str(formData, "assistantId");
  const targetDateRaw = str(formData, "targetDate");
  const targetSubmissionDateRaw = str(formData, "targetSubmissionDate");
  const variationDateRaw = str(formData, "variationDate");

  // Connect responsible + assistant as assigned users so row-level scope works.
  const assignIds = Array.from(new Set([responsibleId, assistantId].filter(Boolean))) as string[];

  // LA RÉFÉRENCE SE CALCULE SOUS LA FILE (§118.175, §118.178). Deux créations simultanées lisaient
  // le même maximum et la seconde tombait sur l'unicité de `reference` — une erreur brute après un
  // formulaire de trente champs. Une création à la fois dans ce processus, un réessai entre deux.
  return enSerie("REG", () => createWithRetry(async () => prisma.regulatoryProduct.create({
    data: {
      reference: buildRef("REG", year, (await prisma.regulatoryProduct.findMany({
        where: { reference: { startsWith: `REG-${year}-` } },
        select: { reference: true },
      })).map((r) => r.reference)),
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
}

/**
 * `createRegulatoryProduct`, une fois le dossier créé et tracé : son dossier Drive, son produit, et l'annonce à
 * l'assistant et à la supervision — sauf pour un dossier né verrouillé. Rend la phrase du produit.
 */
export async function annoncerLeDossier(
  formData: FormData, ctx: { user: SessionUser; product: { id: string; reference: string }; dci: string; lockOnCreate: boolean },
): Promise<string | null> {
  const { user, product, dci, lockOnCreate } = ctx;
  const assistantId = str(formData, "assistantId");
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
        body: `${product.reference} — ${dci}`,
        link: `/regulatory/${product.id}`,
      });
    }

    // Supervision : prévenir les superviseurs Regulatory (Super Admin + rôles configurés)
    // qu'un nouveau dossier attend une priorité et une date cible de dépôt.
    await notifyRoles(await regSupervisorRoles(), {
      type: "GENERIC",
      title: "Nouveau dossier Regulatory à prioriser",
      body: `${product.reference} — ${dci} · définir la priorité et la date cible de dépôt.`,
      link: `/regulatory/${product.id}`,
    });
  }
  return messageProduit;
}

/**
 * `updateRegulatoryProduct`, après la porte : la DCI recomposée, l'entité, les trois champs du Super Admin
 * (`guardStructural`), puis l'écriture de la fiche. L'action garde l'audit et les annonces.
 */
export async function ecrireLaFiche(formData: FormData, ctx: { user: SessionUser; id: string }) {
  const { user, id } = ctx;
  const before = await prisma.regulatoryProduct.findUnique({ where: { id }, include: { assignedUsers: { select: { id: true } } } });
  if (!before) return { ok: false, error: "Dossier introuvable." } as Refus;

  // DCI : recompose depuis les molécules saisies, sinon depuis le champ libre.
  const molecules = upperMolecules(formData.getAll("molecule").map((m) => String(m)));
  const rawDci = molecules.length ? molecules.join(" + ") : str(formData, "dci");
  if (!rawDci) return { ok: false, error: "La DCI est obligatoire." } as Refus;
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
    return { ok: false, error: "L'entité est obligatoire : un dossier ne peut pas être détaché de son entité." } as Refus;
  }
  const updatedCompanyId = rawCompanyId || before.companyId;
  if (rawCompanyId) {
    const okCompany = await prisma.company.count({ where: { id: rawCompanyId, isActive: true } });
    if (!okCompany) return { ok: false, error: "Entité inconnue ou désactivée." } as Refus;
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
  return { ok: true as const, before, dci, structural, assistantId };
}

/**
 * `setRegulatoryResponsible`, après la porte : la personne désignée vérifiée, puis le dossier confié (et la
 * personne rattachée aux participants). `fini` : l'action s'arrête là, sur ce résultat.
 */
export async function confierLeDossier(formData: FormData, ctx: { user: SessionUser; id: string }) {
  const { user, id } = ctx;
  const before = await prisma.regulatoryProduct.findUnique({
    where: { id },
    select: { reference: true, dci: true, responsibleId: true, isLocked: true },
  });
  if (!before) return arret({ ok: false, error: "Dossier introuvable." });

  const responsibleId = str(formData, "responsibleId");
  if (responsibleId) {
    const ok = await prisma.user.count({ where: { id: responsibleId, isActive: true } });
    if (!ok) return arret({ ok: false, error: "Personne inconnue ou compte désactivé." });
  }
  if (responsibleId === before.responsibleId) return arret({ ok: true, id });

  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      responsibleId,
      updatedById: user.id,
      ...(responsibleId ? { assignedUsers: { connect: { id: responsibleId } } } : {}),
    },
  });
  return { before, responsibleId };
}

/**
 * `setRegulatoryClassification` — les deux ÉTIQUETTES (segments, projet BD), posées dans `data`. Le refus se dit
 * en clair ; `null` = rien à refuser.
 */
export async function etiquettesDuClassement(
  formData: FormData,
  ctx: { user: SessionUser; before: { therapeuticSegments: string[] | null }; data: { therapeuticSegments?: string[]; bdProjectId?: string | null } },
): Promise<string | null> {
  const { user, before, data } = ctx;
  if (formData.has("segments")) {
    // Liste blanche : un segment inventé ne se compte avec rien, et c'est le comptage qu'on
    // vient chercher. La liste effective est celle réglée par l'administrateur (sinon la liste
    // par défaut) ; un segment DÉJÀ posé sur la fiche reste accepté même s'il a depuis quitté le
    // référentiel — sinon on ne pourrait plus le retirer.
    data.therapeuticSegments = await segmentsAdmis(before.therapeuticSegments, formData.getAll("segments"));
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
      if (!visible) return "Projet inconnu, ou que vous ne voyez pas (module « Projets », ou autre entité).";
    }
    data.bdProjectId = projectId || null;
  }
  return null;
}

/** `updateRegulatoryStep`, après la porte : l'étape réécrite. Rend son nouveau statut (pour l'audit). */
export async function ecrireLEtape(formData: FormData, ctx: { stepId: string; step: { status: StepStatus } }): Promise<StepStatus> {
  const { stepId, step } = ctx;
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
  return status;
}

/** `updateRegulatoryStatus`, après la porte : la priorité, et le niveau demandé lu comme un avancement. */
export async function ecrireLaPriorite(formData: FormData, ctx: { user: SessionUser; id: string; before: RegulatoryProduct }) {
  const { user, id, before } = ctx;
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
  const { wf, autoSteps } = avancerJusquAuJalon(before, asked);

  await prisma.regulatoryProduct.update({
    where: { id },
    data: {
      priority, updatedById: user.id,
      ...(autoSteps > 0 ? { workflow: wf as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  return { wf, autoSteps, asked };
}

/** `requestRegulatoryStatusUpdate`, après la porte : la relance envoyée aux personnes du dossier. */
export async function relancerLeDossier(formData: FormData, ctx: { user: SessionUser; id: string }) {
  const { user, id } = ctx;
  const product = await prisma.regulatoryProduct.findUnique({
    where: { id },
    select: { reference: true, dci: true, responsibleId: true, assistantId: true, assignedUsers: { select: { id: true } } },
  });
  if (!product) return null;
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
  return targets.length;
}

/** `createVariation`, après la porte : la cible contrôlée, puis la variation déposée. */
export async function deposerLaVariation(formData: FormData, ctx: { user: SessionUser; productId: string }) {
  const { user, productId } = ctx;
  const toStatus = str(formData, "toStatus");
  if (!toStatus || !VARIATION_TARGETS.includes(toStatus)) {
    return { ok: false, error: "Statut de fabrication de variation invalide." } as Refus;
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
  return { ok: true as const, toStatus };
}

/**
 * `requestBV`, après la porte : la nature et le montant du BV, les pièces jugées AVANT l'ordre, l'ordre émis
 * (sous verrou pour une nature connue), puis les justificatifs. L'action garde l'audit et l'étape cochée.
 */
export async function emettreLeBv(
  formData: FormData, ctx: { user: SessionUser; productId: string; product: { reference: string; dci: string }; etapeValide: string | null },
) {
  const { user, productId, product, etapeValide } = ctx;
  const bvType = (etapeValide && BV_REQUEST_STEPS[etapeValide]) || str(formData, "bvType") || "BV";
  const nature = natureDuLibelle(bvType);
  const amount = Number(str(formData, "amount"));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Montant invalide." } as Refus;
  const dueRaw = str(formData, "dueDate");
  const note = str(formData, "note");

  // LES PIÈCES SE JUGENT AVANT L'ORDRE (§118.202) : un fichier refusé après la création laissait un
  // ordre au centre de paiement — sans pièce, et qu'une seconde tentative doublait.
  const files = [...formData.getAll("files"), formData.get("file")]
    .filter((f): f is File => f instanceof File && f.size > 0);
  const refusPiece = await refusDesPieces(files);
  if (refusPiece) return { ok: false, error: refusPiece } as Refus;

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
    const issue = await emettreSousVerrou(productId, nature, emettre);
    if (issue.deja) return { ok: false, error: refusBvDejaDemande(bvType, issue.deja) } as Refus;
    if (!issue.cree) return { ok: false, error: "La demande n'a pas pu être émise : réessayez." } as Refus;
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
  return { ok: true as const, order, bvType, amount, pieces: files.length };
}

/** `setVariationStatus`, après la porte : la décision datée et, à l'obtention, le statut de fabrication promu. */
export async function acterLaVariation(
  formData: FormData,
  ctx: {
    user: SessionUser; id: string; status: VariationStatus;
    variation: { id: string; productId: string; toStatus: ManufacturingStatus; manufacturer: string | null };
  },
): Promise<void> {
  const { user, id, status, variation } = ctx;
  const decisionRaw = str(formData, "decisionDate");
  const decisionDate = decisionRaw ? new Date(decisionRaw) : status === "OBTENUE" ? new Date() : null;
  await prisma.regulatoryVariation.update({
    where: { id },
    data: { status, decisionDate },
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
    if (product && product.manufacturingStatus !== variation.toStatus) await annoncerLaFabrication(variation, product, user.id);
  }
}
