import type { EntityType } from "@prisma/client";
import { buildRef } from "@/lib/refs";
import { prisma } from "./prisma";
import { anyRoleFilter } from "./rbac";
import { notifyRoles } from "./notify";
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

  // Assignation par défaut au premier pharmacien responsable actif (le cas échéant),
  // que le rôle soit porté en principal OU en secondaire.
  const pharmacist = await prisma.user.findFirst({
    where: { ...anyRoleFilter(["MEDICAL_INFO_PHARMACIST"]), isActive: true },
    select: { id: true },
  });

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
      pharmacistId: pharmacist?.id ?? null,
      declarationKind: input.declarationKind ?? null,
      // LE PRODUIT, repris de la source (sponsoring, congrès, événement, matériel promotionnel) — corrigeable dans la déclaration.
      productId: await produitDeLaSource(input.sourceType, input.sourceId),
    },
  });

  await notifyRoles(["MEDICAL_INFO_PHARMACIST", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: input.declarationKind ? TITRE_PAR_NATURE[input.declarationKind] : "Information médicale — événement à déclarer",
    body: `${decl.reference} — ${input.label}`,
    link: `/information-medicale/${decl.id}`,
  });
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
