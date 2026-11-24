import { prisma } from "@/lib/prisma";
import {
  autorisateursDeFormation, departementsDirigesPar, directeursDesOperationsDeLaSociete, type DepartementOrganigramme,
} from "../domaine/directeurs";

/**
 * LES DIRECTEURS, LUS DANS L'ORGANIGRAMME — la règle pure est `domaine/directeurs.ts` ; ici, on ne fait que lui porter
 * les départements et leurs responsables (compte de la fiche `head`, actif). Un compte désactivé ne dirige plus rien :
 * un pouvoir ne survit pas à la fermeture du compte.
 */
async function chargerOrganigrammeDesDirecteurs(): Promise<DepartementOrganigramme[]> {
  const deps = await prisma.department.findMany({
    select: { id: true, name: true, code: true, companyId: true, head: { select: { userId: true, user: { select: { isActive: true } } } } },
  });
  return deps.map((d) => ({
    id: d.id, name: d.name, code: d.code, companyId: d.companyId,
    headUserId: d.head?.userId && d.head.user?.isActive !== false ? d.head.userId : null,
  }));
}

/** Les départements que cette personne dirige (responsable, jamais adjoint). */
export async function departementsDiriges(userId: string): Promise<DepartementOrganigramme[]> {
  return departementsDirigesPar(userId, await chargerOrganigrammeDesDirecteurs());
}

async function faitsDesAutorisateurs() {
  const [organigramme, parRole, superAdmins] = await Promise.all([
    chargerOrganigrammeDesDirecteurs(),
    prisma.user.findMany({
      where: { isActive: true, OR: [{ role: "OPERATIONS_DIRECTOR" }, { secondaryRole: "OPERATIONS_DIRECTOR" }] },
      select: { id: true }, orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({ where: { isActive: true, role: "SUPER_ADMIN" }, select: { id: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return { organigramme, parRole: parRole.map((u) => u.id), superAdmins: superAdmins.map((u) => u.id) };
}

/**
 * QUI AUTORISE UNE FORMATION de cette société — le Directeur des opérations selon l'organigramme, à défaut le rôle, à
 * défaut le Super Admin (`autorisateursDeFormation`). Rôles lus en principal OU secondaire pour le Directeur des
 * opérations (comme l'information médicale) ; le Super Admin, lui, est un COMPTE : le rôle principal seul.
 */
export async function autorisateursDeLaFormation(companyId: string | null, requesterId: string | null): Promise<{ userIds: string[]; repli: boolean }> {
  const f = await faitsDesAutorisateurs();
  return autorisateursDeFormation({
    parOrganigramme: directeursDesOperationsDeLaSociete(f.organigramme, companyId), parRole: f.parRole, superAdmins: f.superAdmins, requesterId,
  });
}

/**
 * LES SOCIÉTÉS OÙ CETTE PERSONNE AUTORISE LES FORMATIONS (`null` = formations sans société) — pour que le Directeur des
 * opérations VOIE ce qu'il doit autoriser (liste des formations, « Aujourd'hui »), et rien de plus.
 */
export async function societesOuJAutoriseLesFormations(userId: string): Promise<(string | null)[]> {
  const [f, societes] = await Promise.all([faitsDesAutorisateurs(), prisma.company.findMany({ select: { id: true } })]);
  return [...societes.map((c) => c.id), null].filter((companyId) => autorisateursDeFormation({
    parOrganigramme: directeursDesOperationsDeLaSociete(f.organigramme, companyId), parRole: f.parRole, superAdmins: f.superAdmins, requesterId: null,
  }).userIds.includes(userId));
}
