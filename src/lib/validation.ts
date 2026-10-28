import { randomUUID } from "crypto";
import type { EntityType, Prisma, Priority, UserRole, ValidationRule } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveFile, validateUpload } from "@/lib/storage";
import { notifyUser } from "@/lib/notify";
import { createWithRetry, enSerie, referenceDeSerie } from "@/lib/refs";
import { lienDemandeDeValidation, lienEtapeAValider } from "@/lib/chemins/validations";

/**
 * Moteur de validation transversal. Le Super Admin définit des règles
 * (ValidationRule) ; à chaque demande on cherche la règle active la plus
 * spécifique qui correspond au contexte, puis on crée la demande de validation
 * et ses étapes (1 ou 2 validateurs, en séquentiel ou parallèle).
 */

export interface ValidationContext {
  module: string;
  objectType?: string | null;
  amount?: number | null;
  department?: string | null;
  requesterRole?: UserRole | null;
  priority?: Priority | null;
  category?: string | null;
}

/** Nombre de conditions non nulles → mesure de spécificité d'une règle. */
function specificity(r: ValidationRule): number {
  return [r.module, r.objectType, r.requesterRole, r.priority, r.category, r.department, r.minAmount, r.maxAmount]
    .filter((x) => x !== null && x !== undefined).length;
}

export async function findMatchingRule(ctx: ValidationContext): Promise<ValidationRule | null> {
  const rules = await prisma.validationRule.findMany({ where: { active: true } });
  const amt = ctx.amount ?? null;
  const matches = rules.filter((r) => {
    if (r.module && r.module !== ctx.module) return false;
    if (r.objectType && r.objectType !== (ctx.objectType ?? null)) return false;
    if (r.requesterRole && r.requesterRole !== (ctx.requesterRole ?? null)) return false;
    if (r.priority && r.priority !== (ctx.priority ?? null)) return false;
    if (r.category && r.category !== (ctx.category ?? null)) return false;
    if (r.department && r.department !== (ctx.department ?? null)) return false;
    if (r.minAmount !== null && (amt === null || amt < Number(r.minAmount))) return false;
    if (r.maxAmount !== null && (amt === null || amt > Number(r.maxAmount))) return false;
    return true;
  });
  matches.sort((a, b) => specificity(b) - specificity(a) || a.sortOrder - b.sortOrder);
  return matches[0] ?? null;
}

export interface CreateValidationInput {
  module: string;
  objectType?: string | null;
  title: string;
  description?: string | null;
  amount?: number | null;
  department?: string | null;
  priority?: Priority;
  category?: string | null;
  link?: string | null;
  entityType?: EntityType | null;
  entityId?: string | null;
  requesterId: string;
  requesterRole?: UserRole | null;
  deadline?: Date | null;
}

export interface CreateValidationResult {
  ok: boolean;
  matched: boolean;
  requestId?: string;
  reference?: string;
  error?: string;
}

/**
 * LA SÉRIE DES RÉFÉRENCES `VAL-AAAA-NNN` — une création à la fois dans ce processus (`enSerie`).
 * Chaque bon de commande pose désormais sa demande de validation (§118.148), et une mission en
 * émet vingt-cinq d'un coup : la référence dérivée du maximum ne tient pas cette charge sans file.
 */
const SERIE_VALIDATION = "ValidationRequest.reference";

async function nextReference(): Promise<string> {
  const year = new Date().getFullYear();
  // Dérivée du maximum réel (robuste aux suppressions) — voir src/lib/refs.ts.
  return referenceDeSerie({
    modele: "ValidationRequest", prefixe: "VAL", annee: year,
    existantes: async () => (await prisma.validationRequest.findMany({ where: { reference: { startsWith: `VAL-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

/**
 * Prévient un validateur — le lien mène à SA carte de décision (`?focus=<étape>`), pas en haut d'une
 * liste où il faudrait la chercher : la fiche `/validations/<id>` n'a pas les boutons.
 */
export async function notifyValidator(userId: string, req: { id: string; reference: string; title: string }, stepId?: string | null) {
  await notifyUser({
    userId,
    type: "VALIDATION_REQUIRED",
    title: "Validation demandée",
    body: `${req.reference} — ${req.title}`,
    link: stepId ? lienEtapeAValider(stepId) : lienDemandeDeValidation(req.id),
  });
}

/**
 * Crée une demande de validation à partir des règles. Si aucune règle ne
 * correspond, renvoie `{ matched: false }` — l'appelant décide du repli.
 */
export async function createValidationFromRules(input: CreateValidationInput): Promise<CreateValidationResult> {
  const rule = await findMatchingRule({
    module: input.module,
    objectType: input.objectType,
    amount: input.amount,
    department: input.department,
    requesterRole: input.requesterRole,
    priority: input.priority,
    category: input.category,
  });
  if (!rule) return { ok: false, matched: false, error: "Aucune règle de validation ne correspond à cette demande." };

  const validators = [rule.validator1Id, rule.validator2Id].filter((v): v is string => Boolean(v));
  if (validators.length === 0) return { ok: false, matched: true, error: "La règle correspondante n'a aucun validateur configuré." };

  // Référence recalculée à chaque tentative (robuste aux collisions concurrentes).
  const req = await enSerie(SERIE_VALIDATION, () => createWithRetry(async () => {
    const reference = await nextReference();
    return prisma.validationRequest.create({
      data: {
        reference,
        ruleId: rule.id,
        module: input.module,
        objectType: input.objectType ?? null,
        title: input.title,
        description: input.description ?? null,
        amount: input.amount ?? null,
        department: input.department ?? null,
        priority: input.priority ?? "MEDIUM",
        category: input.category ?? null,
        link: input.link ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requesterId: input.requesterId,
        mode: rule.mode,
        status: "PENDING",
        currentOrder: 1,
        deadline: input.deadline ?? null,
        steps: { create: validators.map((vid, i) => ({ order: i + 1, validatorId: vid, status: "PENDING" })) },
      },
      include: { steps: true },
    });
  }));

  const toNotify = rule.mode === "PARALLEL" ? req.steps : req.steps.filter((s) => s.order === 1);
  for (const s of toNotify) await notifyValidator(s.validatorId, req, s.id);

  return { ok: true, matched: true, requestId: req.id, reference: req.reference };
}

/**
 * Demande de validation **directe** : le demandeur choisit lui-même un ou deux
 * validateurs (sans règle préconfigurée). Permet à n'importe quel collaborateur
 * autorisé de demander une validation professionnelle (ex. l'assistante de
 * direction avant l'envoi d'un courrier). Circuit séquentiel par défaut.
 */
export async function createDirectValidation(input: {
  requesterId: string;
  title: string;
  description?: string | null;
  link?: string | null;
  module?: string | null;
  priority?: Priority;
  deadline?: Date | null;
  validatorIds: string[];
  entityType?: EntityType | null;
  entityId?: string | null;
  /** Pièce jointe précise visée (une validation de pièce ne pilote pas l'objet parent). */
  documentId?: string | null;
  /** PARALLEL : tous les validateurs sont saisis (et notifiés) EN MÊME TEMPS. Défaut : séquentiel. */
  mode?: "SEQUENTIAL" | "PARALLEL";
  /** Montant en jeu (DZD) — affiché aux validateurs ; sert à l'ordre de dépense post-approbation. */
  amount?: number | null;
  /** Catégorie de finance pressentie (FinanceCategory) — reprise par l'ordre de dépense. */
  category?: string | null;
  /**
   * LA NATURE DE L'OBJET VALIDÉ, quand un lecteur doit reconnaître SES demandes sans deviner.
   *
   * La porte d'un bon de commande (`bons-de-commande/aiguillage.ts`) vit dans une demande de
   * validation sur `LEGAL_DOCUMENT` ; d'autres validations peuvent viser le même document (un
   * avis sur un contrat). Les distinguer par le TITRE serait une ressemblance de mots, pas un lien
   * (§118.36) : le type d'objet le dit, et il est déjà une colonne de la table.
   */
  objectType?: string | null;
  /**
   * Autorise le demandeur à être SON PROPRE validateur. Par défaut on l'écarte (un circuit
   * d'approbation classique ne s'auto-valide pas), mais la validation de PIÈCE JOINTE est un
   * avis qu'on peut vouloir se réserver — sans ce drapeau, se choisir soi-même vidait la liste
   * et l'écran répondait « indiquez au moins un validateur », incompréhensible.
   */
  allowSelf?: boolean;
}): Promise<CreateValidationResult> {
  const validators = [...new Set(input.validatorIds.filter(Boolean))].filter((v) => input.allowSelf || v !== input.requesterId);
  if (validators.length === 0) return { ok: false, matched: false, error: "Indiquez au moins un validateur." };

  const req = await enSerie(SERIE_VALIDATION, () => createWithRetry(async () => {
    const reference = await nextReference();
    return prisma.validationRequest.create({
      data: {
        reference,
        module: input.module || "Demandes de validations",
        objectType: input.objectType ?? null,
        title: input.title,
        description: input.description ?? null,
        link: input.link ?? null,
        priority: input.priority ?? "MEDIUM",
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requesterId: input.requesterId,
        documentId: input.documentId ?? null,
        amount: input.amount ?? null,
        category: input.category ?? null,
        mode: input.mode ?? "SEQUENTIAL",
        status: "PENDING",
        currentOrder: 1,
        deadline: input.deadline ?? null,
        // En parallèle, l'ordre ne commande rien : tout le monde est à l'étape 1.
        steps: { create: validators.map((vid, i) => ({ order: input.mode === "PARALLEL" ? 1 : i + 1, validatorId: vid, status: "PENDING" })) },
      },
      include: { steps: true },
    });
  }));

  if ((input.mode ?? "SEQUENTIAL") === "PARALLEL") {
    for (const s of req.steps) await notifyValidator(s.validatorId, req, s.id);
  } else {
    const first = req.steps.find((s) => s.order === 1);
    if (first) await notifyValidator(first.validatorId, req, first.id);
  }
  return { ok: true, matched: true, requestId: req.id, reference: req.reference };
}

/**
 * RETIRE une demande de validation qu'on vient de créer et qui n'a plus d'objet — tant que personne
 * ne l'a tranchée (écriture CONDITIONNELLE : une décision déjà prise reste, c'est de l'histoire).
 *
 * Elle sert la compensation d'une écriture conditionnelle perdue (§118.187) : la demande du
 * secrétariat a été annulée entre la lecture et l'écriture, l'annulation a retiré les validations
 * qu'elle VOYAIT, et celle-ci, née après, resterait en file pour rien.
 *
 * Pourquoi un module et pas une ligne dans l'action : la dérivation des contrats lit les modèles que
 * le CORPS d'une action écrit pour dire ce que désigne son `id` ; une action qui écrit deux tables
 * en direct renonce à le dire (§118.150g), et le chemin générique ne saurait plus traduire « la
 * demande DEM-2026-012 » en identifiant. Le corps de l'action n'écrit que sa demande.
 */
export async function retirerValidationSansObjet(requestId: string): Promise<number> {
  // Pour Prisma, `id: undefined` ne filtre RIEN : l'écriture retirerait TOUTES les validations en
  // attente de la base. Le type l'interdit à l'appel ; la garde tient si un `as` le contournait.
  if (!requestId) return 0;
  const r = await prisma.validationRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: new Date() },
  });
  return r.count;
}

/**
 * LES PIÈCES JOINTES D'UNE DEMANDE DE VALIDATION — un seul écrivain pour le dépôt et pour la
 * resoumission (audit 360°, R08) : deux boucles recopiées finiraient par ne pas appliquer la même
 * limite de taille, et c'est la seconde, la moins regardée, qui laisserait passer un fichier de trop.
 *
 * `verifierPiecesValidation` refuse AVANT toute écriture (rend le motif, `null` si tout passe) ;
 * `joindrePiecesValidation` dépose. Une écriture de stockage qui échoue garde la ligne : la pièce
 * reste nommée dans la demande, et le défaut se lit au journal du serveur.
 */
export function verifierPiecesValidation(files: readonly File[], maxMb: number): string | null {
  for (const file of files) {
    const invalide = validateUpload(file.name, file.size, maxMb);
    if (invalide) return invalide;
  }
  return null;
}

export async function joindrePiecesValidation(requestId: string, files: readonly File[], auteurId: string): Promise<number> {
  for (const file of files) {
    const key = `VALIDATION_REQUEST/${requestId}/${randomUUID()}__${file.name}`;
    try {
      await saveFile(key, Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      console.error("[validations] storage write failed, recording metadata only", err);
    }
    await prisma.document.create({
      data: {
        name: file.name, category: "OTHER", entityType: "VALIDATION_REQUEST", entityId: requestId,
        fileKey: key, mimeType: file.type || null, sizeBytes: file.size, confidentiality: "INTERNAL", uploadedById: auteurId,
      },
    });
  }
  return files.length;
}

/**
 * LA REPRISE D'UNE DEMANDE RENVOYÉE, côté étapes et historique (audit 360°, R08) — appelée DANS la
 * transaction de la resoumission, sous le verrou de la demande.
 *
 * Les étapes qui repartent perdent leur motif ; il est donc ARCHIVÉ dans le fil de la demande au
 * moment même où il s'efface de l'étape — pas avant (deux copies vivantes du même motif finiraient
 * par se contredire), pas après (il n'existerait plus nulle part). Le fil garde ainsi, version par
 * version, qui a renvoyé, pourquoi, et ce qui a été corrigé.
 */
export async function reprendreEtapesRenvoyees(
  tx: Prisma.TransactionClient,
  i: { requestId: string; etapes: readonly string[]; auteurId: string; histoire: string },
): Promise<void> {
  if (i.etapes.length > 0) {
    await tx.validationStep.updateMany({
      where: { id: { in: [...i.etapes] }, requestId: i.requestId },
      data: { status: "PENDING", reason: null, decidedAt: null },
    });
  }
  await tx.comment.create({ data: { entityType: "VALIDATION_REQUEST", entityId: i.requestId, authorId: i.auteurId, body: i.histoire } });
}
