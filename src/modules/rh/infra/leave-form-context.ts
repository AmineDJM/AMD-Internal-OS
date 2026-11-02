import { prisma } from "@/lib/prisma";
import { splitFullName } from "../domaine/leave-sheet";

/**
 * CE QUE LE FORMULAIRE DE CONGÉ SAIT DÉJÀ DE VOUS.
 *
 * Les deux portes — « Mon espace » et « Mon dossier RH » — servent le MÊME formulaire ; elles
 * doivent donc lui donner le même contexte, sinon la fiche serait complète d'un côté et vide de
 * l'autre. Ce module est ce contexte, résolu une fois.
 *
 * L'identité est LUE de la fiche employé et jamais recopiée dans la demande : voir
 * `leave-sheet.ts` pour la raison (une seconde vérité vieillit mal).
 *
 * Module SERVEUR (prisma) : jamais importé par un composant client.
 */
export async function leaveFormContext(userId: string) {
  const employee = await prisma.employee.findUnique({
    where: { userId },
    select: {
      id: true, fullName: true, position: true, phone: true, hireDate: true,
      department: true, departmentRef: { select: { name: true } },
    },
  });
  if (!employee) return null;

  const { nom, prenom } = splitFullName(employee.fullName);
  // Qui peut tenir la place : les comptes actifs, soi excepté — on ne se remplace pas soi-même.
  const colleagues = await prisma.user.findMany({
    where: { isActive: true, id: { not: userId } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return {
    identity: {
      nom, prenom,
      position: employee.position,
      // Le département STRUCTURÉ fait foi ; le libellé dénormalisé sert de repli historique.
      department: employee.departmentRef?.name ?? employee.department,
      hireDate: employee.hireDate ? employee.hireDate.toLocaleDateString("fr-FR") : null,
      phone: employee.phone,
    },
    colleagues,
  };
}
