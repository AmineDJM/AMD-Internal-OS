/**
 * Moteur de workflow — LES MONTANTS : postes qui portent la dépense, montant à déclarer, report
 * des postes sur la déclaration d'information médicale, estimation des postes.
 */
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { AD_PRO_PARENTS, PARENT_COLONNE, type AdProParent } from "@/modules/ad-pro/partage";

/**
 * LES POSTES QUI PORTENT LA DÉPENSE D'UNE OPÉRATION — la seule lecture, partagée (§118.151).
 *
 * Un poste refusé ne compte pas : il ne paiera jamais rien. Deux questions en dépendent et elles
 * ne vivent pas au même endroit : « faut-il un ordre GLOBAL en plus ? » (ici, et à la validation
 * d'une déclaration d'information médicale, `validateDeclarationByDirection`) et « quelle
 * estimation déclarer pour une tenue pré-validée ? ». Deux comptages écrits à part finiraient par
 * ne plus compter les mêmes postes, et le symptôme serait un ordre global émis À CÔTÉ des postes :
 * la même dépense payée deux fois (§118.5).
 *
 * La colonne du parent vient de `PARENT_COLONNE`, la table que la garde d'accès d'un poste lit
 * déjà — pas d'une cascade de ternaires recopiée.
 *
 * Elle ne rattrape PAS ses erreurs : c'est à l'appelant de dire dans quel sens il se trompe.
 */
export async function postesPortantLaDepense(
  entityType: EntityType, entityId: string,
): Promise<{ nombre: number; montantEstime: number }> {
  if (!(AD_PRO_PARENTS as readonly string[]).includes(entityType)) return { nombre: 0, montantEstime: 0 };
  const colonne = PARENT_COLONNE[entityType as AdProParent];
  const lignes = await prisma.adProItem.findMany({
    where: { [colonne]: entityId, status: { not: "REJECTED" } },
    select: { amountEstimated: true, amountGranted: true },
  });
  return {
    nombre: lignes.length,
    // Le montant ACCORDÉ quand il existe, sinon l'estimation du demandeur.
    montantEstime: lignes.reduce((t, l) => t + (l.amountGranted != null ? toNumber(l.amountGranted) : toNumber(l.amountEstimated)), 0),
  };
}

/** Combien de postes portent la dépense — une panne de comptage ne bloque pas la validation en cours. */
export async function countAdProItems(entityType: EntityType, entityId: string): Promise<number> {
  try {
    return (await postesPortantLaDepense(entityType, entityId)).nombre;
  } catch {
    return 0; // une panne de comptage ne doit pas bloquer la validation en cours
  }
}

/**
 * LE MONTANT QU'UNE DÉCLARATION D'INFORMATION MÉDICALE PORTE (§118.151).
 *
 * Le montant FIXÉ par le circuit quand il y en a un ; sinon — une tenue pré-validée, dont l'argent
 * se décide après — l'estimation que portent ses postes ; `null` s'ils ne portent rien. Exportée
 * pour être éprouvée par la base réelle : la branche qui l'appelle n'existe que lorsqu'un
 * pharmacien est actif, ce qu'un banc ne peut pas poser sans troubler les bancs voisins.
 */
export async function montantADeclarer(entityType: EntityType, entityId: string, montantFixe: number): Promise<number | null> {
  return montantFixe > 0 ? montantFixe : montantEstimeDesPostes(entityType, entityId);
}

/**
 * UNE RÉVISION DE POSTE SE RÉPERCUTE SUR LA DÉCLARATION (§118.191, audit 10/2026).
 *
 * `repercuterMontantSurDeclaration` ne suivait que l'ancien chemin des congrès (le montant accordé
 * révisé) : un poste Ad & Pro ajouté, réestimé, accordé, refusé ou retiré laissait la déclaration
 * d'information médicale sur l'estimation de sa naissance. Quand des postes portent la dépense, le
 * montant déclaré EST leur estimation — la même lecture que `postesPortantLaDepense` (§118.5).
 *
 * Seulement tant que la déclaration n'est pas validée et qu'aucun ordre n'en est né — écriture
 * CONDITIONNELLE : une validation passée entre la lecture et l'écriture garde son montant.
 *
 * SANS POSTE (le dernier refusé ou retiré), le montant redevient celui que le CIRCUIT a fixé
 * (`montantADeclarer` sur `WorkflowInstance.amount`) — `null` pour une prévalidation, qui n'en fixe pas
 * (27/10/2026). Le laisser sur la dernière estimation faisait naître, à la validation finale de la
 * déclaration, un ORDRE GLOBAL du montant de postes refusés : aucun poste n'y portait plus la dépense,
 * donc rien ne l'empêchait (audit du 27/10/2026, ADPRO-03).
 */
export async function reporterLesPostesSurLaDeclaration(entityType: EntityType, entityId: string): Promise<void> {
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: entityType, sourceId: entityId } },
    select: { id: true, status: true, expenseOrderId: true },
  });
  if (!decl || decl.status === "VALIDATED" || decl.expenseOrderId) return;
  const { nombre, montantEstime } = await postesPortantLaDepense(entityType, entityId);
  let amount: number | null;
  if (nombre > 0) {
    amount = montantEstime > 0 ? montantEstime : null;
  } else {
    const instance = await prisma.workflowInstance.findUnique({
      where: { entityType_entityId: { entityType, entityId } }, select: { amount: true },
    });
    // Sans circuit (une déclaration saisie à la main), rien ne dit ce qu'elle devrait porter : on n'y touche pas.
    if (!instance) return;
    const fixe = instance.amount != null ? toNumber(instance.amount) : 0;
    amount = fixe > 0 ? fixe : null;
  }
  await prisma.medicalInfoDeclaration.updateMany({
    where: { id: decl.id, status: { not: "VALIDATED" }, expenseOrderId: null },
    data: { amount },
  });
}

/** L'estimation déclarée d'une tenue pré-validée : ce que portent ses postes, `null` s'ils ne portent rien. */
async function montantEstimeDesPostes(entityType: EntityType, entityId: string): Promise<number | null> {
  try {
    const { montantEstime } = await postesPortantLaDepense(entityType, entityId);
    return montantEstime > 0 ? montantEstime : null;
  } catch {
    // Une déclaration sans montant reste une déclaration : le pharmacien déclare l'événement, et
    // aucun ordre ne peut en naître (`validateDeclarationByDirection` n'émet rien sur un montant nul).
    return null;
  }
}
