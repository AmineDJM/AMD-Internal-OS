"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan } from "@/lib/rbac";
import { loadReportingLine } from "@/lib/departments";
import { subtreeOf, flattenTree } from "@/modules/rh/partage";
import { getTeamMemberKpis, type TeamMemberKpis } from "@/lib/queries/team-kpis";

/**
 * LES INDICATEURS D'UNE PERSONNE DE MON ÉQUIPE — et la porte qui les garde.
 *
 * ── LE DROIT EST LA HIÉRARCHIE, ET RIEN D'AUTRE ─────────────────────────────────────────────
 *
 * Il ne suffit pas d'avoir le module « Mon Équipe » : tout le monde l'a, et c'est voulu — un
 * encadrant ne se déclare pas, il se déduit. Ce qui borne ces chiffres est donc l'ARBRE :
 * je vois les indicateurs de qui est SOUS MOI, à n'importe quelle profondeur, et de personne
 * d'autre. Le même arbre que celui de l'écran, calculé ici de nouveau — parce qu'une action
 * serveur s'appelle depuis le navigateur sans passer par l'écran (§118-7), et qu'un identifiant
 * d'employé se devine en trois essais.
 *
 * ── POURQUOI CE N'EST PAS UNE PORTE SUR LES RH ──────────────────────────────────────────────
 *
 * Ce qui sort d'ici, ce sont des compteurs d'ACTIVITÉ : des visites, des dossiers, des tâches,
 * des jours de congé pris. Rien du dossier RH — ni salaire, ni évaluation, ni pièce. Un
 * encadrant qui voit « 12 tâches ouvertes dont 5 en retard » lit ce qu'il verrait en ouvrant
 * les écrans métier un par un ; on lui épargne les vingt clics, on ne lui ouvre rien de neuf.
 */
export async function teamMemberKpis(employeeId: string): Promise<
  { ok: true; kpis: TeamMemberKpis } | { ok: false; error: string }
> {
  const user = await enLecture(requireUser);
  if (!userCan(user, "MY_TEAM", "VIEW")) return { ok: false, error: "Accès non autorisé." };

  const moi = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!moi) return { ok: false, error: "Aucune fiche employé n'est rattachée à votre compte." };

  const { employees, departments } = await loadReportingLine();
  const sousMoi = flattenTree(subtreeOf(moi.id, employees, departments));
  const cible = sousMoi.find((n) => n.employeeId === employeeId);
  // LE MÊME REFUS POUR « HORS DE MON ÉQUIPE » ET POUR « N'EXISTE PAS » : distinguer les deux
  // dirait, par le seul message, si tel identifiant correspond à un salarié.
  if (!cible) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };

  const compte = cible.userId
    ? await prisma.user.findUnique({ where: { id: cible.userId }, select: { role: true } })
    : null;

  // QUI REGARDE (§118.196, lot E3) : le cadenas Regulatory et les liens des chiffres dépendent du lecteur, et
  // l'organigramme déjà chargé sert à rejouer la garde du plan de tournée sans le relire.
  return {
    ok: true,
    kpis: await getTeamMemberKpis(cible.employeeId, cible.fullName, cible.userId, compte?.role ?? null, { user, employees, departments }),
  };
}
