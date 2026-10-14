import type { EntityType } from "@prisma/client";
import { buildRef } from "@/lib/refs";
import { prisma } from "./prisma";
import { anyRoleFilter, type SessionUser } from "./rbac";
import { getDeclaration, canViewDeclaration } from "./queries/medical-info";
import { PRISE_DU_BON } from "./medical-info/slips";
import { notifyRoles, notifyUser } from "./notify";
import { produitDeLaSource } from "./medical-info/produits";
import { decideursInfoMed, ROLE_DECIDEUR_INFO_MED, type DecideursInfoMed } from "./medical-info/decideur";

/**
 * QUI TRANCHE, MAINTENANT — les Directeurs des Opérations actifs, à défaut les Super Admins actifs,
 * jamais le demandeur (`medical-info/decideur.ts`). Lu à chaque demande, pas figé : un directeur
 * nommé demain reçoit les demandes de demain.
 */
export async function decideursInfoMedActifs(requesterId: string | null): Promise<DecideursInfoMed> {
  const [directeurs, superAdmins] = await Promise.all([
    prisma.user.findMany({
      where: { ...anyRoleFilter([ROLE_DECIDEUR_INFO_MED]), isActive: true },
      select: { id: true }, orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({ where: { role: "SUPER_ADMIN", isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return decideursInfoMed({ directeurs: directeurs.map((u) => u.id), superAdmins: superAdmins.map((u) => u.id), requesterId });
}

export async function nextDeclarationRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.medicalInfoDeclaration.findMany({ where: { reference: { startsWith: `DIM-${year}-` } }, select: { reference: true } });
  return buildRef("DIM", year, refs.map((r) => r.reference));
}

interface CreateDeclarationInput {
  sourceType: EntityType; // SPONSORING | CONGRESS_INTERNATIONAL | CONGRESS_NATIONAL
  sourceId: string;
  label: string;
  beneficiary?: string | null;
  amount?: number | null;
  requesterId?: string | null;
  /** (Sous-)catégorie budgétaire choisie par la Direction à la validation définitive. */
  budgetCategoryId?: string | null;
  /**
   * LA NATURE, quand la source ne la dit pas (§118.152). Le paiement d'un matériel promotionnel
   * part avec une demande de visa publicitaire OU une déclaration au ministère : la source (une
   * facture) ne décrit pas le chemin, c'est le choix du demandeur qui le décide. `null` = la
   * source décide, comme avant.
   */
  declarationKind?: "MIP" | "AD_VISA" | null;
  /**
   * L'ORDRE DE DÉPENSE DÉJÀ ÉMIS — la déclaration née APRÈS un ordre parti sans pharmacien (aucun PRIM
   * actif). La validation finale ne le double pas (`ordreGlobalALaValidation`).
   */
  expenseOrderId?: string | null;
}

/**
 * UNE DEMANDE DE PAIEMENT RATTACHÉE À UNE DÉCLARATION — la preuve, ou le motif du refus (`null` = prouvée).
 *
 * Ce rattachement exempte la demande de facture (`finance/payment-dossier.ts` : un bon de versement n'en
 * a pas). Il ne vaut donc que s'il est VRAI : la déclaration existe, le demandeur la voit, et la demande
 * naît d'un de ses bons — le bon porte, au moment de la création, le jeton de prise que
 * `requestSlipPayment` vient d'y écrire et transmet avec le formulaire.
 */
export async function bonDeVersementRattache(user: SessionUser, declarationId: string | null, jeton: string | null): Promise<string | null> {
  const refus = "Une demande de paiement ne se rattache à une déclaration d'information médicale — et ne se dispense de facture — que depuis un bon de versement de ce dossier.";
  if (!declarationId || !jeton || !jeton.startsWith(PRISE_DU_BON)) return refus;
  const decl = await getDeclaration(declarationId);
  if (!decl || !canViewDeclaration(user, decl)) return refus;
  const bon = await prisma.medicalInfoSlip.count({ where: { declarationId, requestId: jeton } });
  return bon === 1 ? null : refus;
}

/**
 * LE PHARMACIEN ASSIGNÉ — le PLUS ANCIEN pharmacien responsable actif (rôle principal ou secondaire).
 *
 * `findFirst` sans tri rendait les comptes dans l'ordre PHYSIQUE de la table : un PRIM créé hier
 * pouvait recevoir les dossiers à la place du titulaire, au gré des nettoyages (la panne du siège du
 * centre, §118.148h). L'ordre de création, puis l'identifiant, départagent toujours.
 */
export async function pharmacienAssigne(): Promise<string | null> {
  const p = await prisma.user.findFirst({
    where: { ...anyRoleFilter(["MEDICAL_INFO_PHARMACIST"]), isActive: true },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return p?.id ?? null;
}

/** Le titre de la notification du PRIM — il dit ce qu'on lui demande, pas « un événement » quand c'est un visa. */
const TITRE_PAR_NATURE: Record<"MIP" | "AD_VISA", string> = {
  AD_VISA: "Information médicale — visa publicitaire à demander",
  MIP: "Information médicale — déclaration au ministère à faire",
};

/**
 * Intercale l'étape « information médicale » juste après la validation définitive de
 * la Direction. Crée (idempotent) la déclaration et notifie le pharmacien responsable.
 * L'ordre de dépense ne sera émis qu'une fois la déclaration validée par le pharmacien
 * (voir `validateDeclaration`).
 */
export async function createMedicalInfoDeclaration(input: CreateDeclarationInput) {
  // Une seule déclaration par événement source (clé unique sourceType+sourceId).
  const existing = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } },
  });
  if (existing) return existing;

  // Assignation au pharmacien responsable désigné (le plus ancien actif), s'il y en a un. Sans
  // pharmacien, la déclaration naît QUAND MÊME, non assignée : visible de tout PRIM et du Directeur
  // des Opérations (portée ALL), elle attend qu'on la prenne au lieu de ne jamais exister.
  const pharmacistId = await pharmacienAssigne();

  const decl = await prisma.medicalInfoDeclaration.create({
    data: {
      reference: await nextDeclarationRef(),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      label: input.label,
      beneficiary: input.beneficiary ?? null,
      amount: input.amount ?? null,
      requesterId: input.requesterId ?? null,
      budgetCategoryId: input.budgetCategoryId ?? null,
      pharmacistId,
      declarationKind: input.declarationKind ?? null,
      expenseOrderId: input.expenseOrderId ?? null,
      // LE PRODUIT, repris de la source (sponsoring, congrès, événement, matériel promotionnel) — corrigeable dans la déclaration.
      productId: await produitDeLaSource(input.sourceType, input.sourceId),
    },
  });

  // LE SEUL ASSIGNÉ est prévenu — prévenir tous les porteurs du rôle faisait traiter le même dossier
  // par deux personnes, ou par aucune (chacune croyant l'autre dessus). Sans assigné : la file « non
  // assignée » se signale aux pharmaciens et au Directeur des Opérations.
  const titre = input.declarationKind ? TITRE_PAR_NATURE[input.declarationKind] : "Information médicale — événement à déclarer";
  const lien = `/information-medicale/${decl.id}`;
  if (pharmacistId) {
    await notifyUser({ userId: pharmacistId, type: "VALIDATION_REQUIRED", title: titre, body: `${decl.reference} — ${input.label}`, link: lien });
  } else {
    await notifyRoles(["MEDICAL_INFO_PHARMACIST", "OPERATIONS_DIRECTOR"], {
      type: "VALIDATION_REQUIRED",
      title: `${titre} (non assignée — aucun pharmacien responsable actif)`,
      body: `${decl.reference} — ${input.label}`,
      link: lien,
    });
  }
  return decl;
}

/**
 * LE MONTANT D'UNE DÉCLARATION SUIT LE BUDGET ACCORDÉ de sa demande, tant qu'elle n'est pas validée
 * (le pharmacien n'a pas encore déposé). Rend l'ordre de dépense de la déclaration, s'il en a un : c'est
 * lui que la révision fait suivre ensuite (§118.191).
 */
export async function repercuterMontantSurDeclaration(sourceType: EntityType, sourceId: string, amount: number): Promise<{ expenseOrderId: string | null }> {
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } }, select: { id: true, status: true, expenseOrderId: true },
  });
  if (!decl) return { expenseOrderId: null };
  if (decl.status !== "VALIDATED") await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { amount } });
  return { expenseOrderId: decl.expenseOrderId };
}
