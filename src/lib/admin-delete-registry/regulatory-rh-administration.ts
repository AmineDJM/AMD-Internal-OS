/**
 * Registre des suppressions — les entrées : le dossier réglementaire, le sponsoring, l'événement, les RH (employé, congé, demande RH),
 * le dossier de suivi, la demande administrative, la réunion.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { prisma } from "@/lib/prisma";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_REGULATORY_RH_ADMINISTRATION = {
  REGULATORY_PRODUCT: {
    label: "dossier réglementaire",
    module: "Regulatory",
    redirect: "/regulatory",
    model: "regulatoryProduct",
    entityType: "REGULATORY_PRODUCT",
    searchFields: ["reference", "dci"],
    async describe(id) {
      const r = await prisma.regulatoryProduct.findUnique({ where: { id }, select: { reference: true, dci: true } });
      return r ? `${r.reference} — ${r.dci}` : null;
    },
    async remove(id) {
      await prisma.regulatoryProduct.delete({ where: { id } });
    },
  },
  SPONSORING: {
    label: "demande de congrès / sponsoring",
    module: "Sponsoring",
    redirect: "/sponsoring",
    model: "sponsoringRequest",
    entityType: "SPONSORING",
    lot: true,
    searchFields: ["reference", "institution"],
    async describe(id) {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id }, select: { reference: true, institution: true } });
      return r ? `${r.reference} — ${r.institution}` : null;
    },
    async remove(id) {
      await prisma.sponsoringRequest.delete({ where: { id } });
    },
  },
  EVENT: {
    label: "événement",
    module: "Événements",
    redirect: "/events",
    model: "event",
    // Il manquait : les pièces jointes et commentaires d'un événement supprimé restaient en base,
    // rattachés à rien — et la restauration ne les rendait pas.
    entityType: "EVENT",
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.event.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.event.delete({ where: { id } });
    },
  },
  EMPLOYEE: {
    label: "employé",
    module: "RH",
    redirect: "/rh",
    model: "employee",
    entityType: "EMPLOYEE",
    searchFields: ["fullName"],
    async describe(id) {
      const r = await prisma.employee.findUnique({ where: { id }, select: { fullName: true } });
      return r ? r.fullName : null;
    },
    async remove(id) {
      await prisma.employee.delete({ where: { id } });
    },
  },
  /**
   * UNE DEMANDE DE CONGÉ — jamais l'employé, jamais son solde par accident.
   *
   * Supprimer une demande ACCORDÉE, c'est effacer une ligne qui a déjà débité le compteur de
   * jours : si l'on se contentait du `delete`, la personne perdrait ses jours pour une demande
   * qui n'existe plus, et personne ne saurait retrouver pourquoi. On RESTITUE donc le solde
   * dans le même geste — et seulement pour ce qui l'avait entamé (congé annuel accordé).
   */
  LEAVE_REQUEST: {
    label: "demande de congé",
    module: "RH",
    redirect: "/rh/conges",
    model: "leaveRequest",
    entityType: "LEAVE_REQUEST",
    searchFields: ["reason"],
    async describe(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { startDate: true, endDate: true, days: true, employee: { select: { fullName: true } } },
      });
      if (!r) return null;
      const p = `${r.startDate.toLocaleDateString("fr-FR")} → ${r.endDate.toLocaleDateString("fr-FR")}`;
      return `${r.employee.fullName} — ${p} (${Number(r.days)} j)`;
    },
    async remove(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { employeeId: true, days: true, type: true, status: true },
      });
      if (!r) return;
      await prisma.$transaction(async (tx) => {
        if (r.status === "APPROVED" && r.type === "ANNUAL") {
          await tx.employee.update({
            where: { id: r.employeeId },
            data: { leaveBalanceDays: { increment: Number(r.days) } },
          });
        }
        await tx.leaveRequest.delete({ where: { id } });
      });
    },
    /** Restaurer un congé accordé, c'est le rendre — donc reprendre les jours restitués. */
    async restored(id) {
      const r = await prisma.leaveRequest.findUnique({
        where: { id },
        select: { employeeId: true, days: true, type: true, status: true },
      });
      if (!r || r.status !== "APPROVED" || r.type !== "ANNUAL") return;
      await prisma.employee.update({
        where: { id: r.employeeId },
        data: { leaveBalanceDays: { decrement: Number(r.days) } },
      });
    },
  },
  // Une SEULE demande RH (attestation, note de frais, entrevue…) — jamais l'employé.
  HR_REQUEST: {
    label: "demande RH",
    module: "RH",
    redirect: "/rh",
    model: "hrDocumentRequest",
    entityType: "HR_REQUEST",
    async describe(id) {
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { type: true, employee: { select: { fullName: true } } },
      });
      return r ? `Demande ${r.type} — ${r.employee.fullName}` : null;
    },
    async remove(id) {
      // Une demande de congé annuel APPROUVÉE a débité le solde (verrou balanceAppliedAt) :
      // la supprimer rend les jours — même geste que LEAVE_REQUEST, même raison.
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { employeeId: true, balanceAppliedAt: true, periodDays: true },
      });
      if (!r) return;
      const jours = r.balanceAppliedAt && Number(r.periodDays ?? 0) > 0 ? Number(r.periodDays) : 0;
      await prisma.$transaction(async (tx) => {
        if (jours > 0) {
          await tx.employee.update({ where: { id: r.employeeId }, data: { leaveBalanceDays: { increment: jours } } });
        }
        await tx.hrDocumentRequest.delete({ where: { id } });
      });
    },
    /** Restaurer une demande dont le solde avait été rendu = reprendre les jours restitués. */
    async restored(id) {
      const r = await prisma.hrDocumentRequest.findUnique({
        where: { id },
        select: { employeeId: true, balanceAppliedAt: true, periodDays: true },
      });
      if (!r || !r.balanceAppliedAt || !(Number(r.periodDays ?? 0) > 0)) return;
      await prisma.employee.update({
        where: { id: r.employeeId },
        data: { leaveBalanceDays: { decrement: Number(r.periodDays) } },
      });
    },
  },
  DOSSIER: {
    label: "sujet",
    module: "Sujets",
    redirect: "/dossiers",
    model: "dossier",
    entityType: "DOSSIER",
    searchFields: ["title"],
    async describe(id) {
      const r = await prisma.dossier.findUnique({ where: { id }, select: { title: true } });
      return r ? r.title : null;
    },
    async remove(id) {
      await prisma.dossier.delete({ where: { id } });
    },
  },
  ADMIN_REQUEST: {
    label: "demande administrative",
    module: "Demandes",
    redirect: "/demandes",
    model: "administrativeRequest",
    entityType: "ADMIN_REQUEST",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.administrativeRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.administrativeRequest.delete({ where: { id } });
    },
  },
  MEETING: {
    label: "réunion",
    module: "Réunions",
    redirect: "/meetings",
    model: "meeting",
    searchFields: ["title"],
    async describe(id) {
      const r = await prisma.meeting.findUnique({ where: { id }, select: { title: true } });
      return r ? r.title : null;
    },
    async remove(id) {
      await prisma.meeting.delete({ where: { id } });
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
