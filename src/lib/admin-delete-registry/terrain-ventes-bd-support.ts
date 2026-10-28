/**
 * Registre des suppressions — les entrées : le rapport terrain, la vente, le praticien, l'opportunité et le projet BD, la directive,
 * la demande de support.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { prisma } from "@/lib/prisma";
import { refusSuppressionRapport } from "@/lib/promo/remises-visite";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_TERRAIN_VENTES_BD_SUPPORT = {
  FIELD_REPORT: {
    label: "rapport terrain",
    module: "Promotion médicale",
    redirect: CHEMIN_RAPPORTS_TERRAIN,
    model: "fieldReport",
    searchFields: ["doctorName", "institution"],
    async describe(id) {
      const r = await prisma.fieldReport.findUnique({ where: { id }, select: { doctorName: true, institution: true, visitDate: true, delegate: { select: { name: true } } } });
      // L'auteur est dans le nom : la corbeille liste des rapports de tout le monde, et « Médecin non
      // précisé — 05/10/2026 » ne dit pas lequel restaurer (§118.212).
      return r ? `${r.doctorName || r.institution || "Rapport"} — ${r.visitDate.toLocaleDateString("fr-FR")}${r.delegate?.name ? ` (${r.delegate.name})` : ""}` : null;
    },
    // Le MÊME refus que l'action de suppression (§118.204) : un compte rendu qui porte du matériel
    // remis justifie des sorties du stock, il ne passe pas à la corbeille. Et, depuis §118.212, un
    // compte rendu qui est le seul rapport d'une visite de l'emploi du temps.
    refuse: (id) => refusSuppressionRapport(id),
    // UN LOT (§118.212) : le rapport ET ses pièces jointes (`FieldReportAttachment`, supprimées en
    // cascade par la base) partent ensemble et reviennent ensemble. Avant, la restauration rendait
    // le rapport SANS ses pièces — alors que la phrase de la corbeille disait « restaurable ». Les
    // fichiers (pièces, audio) restent au stockage tant que l'entrée existe : seule la destruction
    // réelle depuis la corbeille les libère.
    lot: true,
    async remove(id) {
      await prisma.fieldReport.delete({ where: { id } });
    },
  },
  SALE: {
    label: "vente",
    module: "Ventes",
    redirect: "/sales/historique",
    model: "sale",
    entityType: "SALE",
    searchFields: ["product", "client"],
    async describe(id) {
      const r = await prisma.sale.findUnique({ where: { id }, select: { product: true, client: true } });
      return r ? `${r.product} — ${r.client}` : null;
    },
    async remove(id) {
      await prisma.sale.delete({ where: { id } });
    },
  },
  DOCTOR: {
    label: "médecin",
    module: "Médical",
    redirect: "/medical/annuaire",
    model: "medicalDoctor",
    entityType: "DOCTOR",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.medicalDoctor.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.medicalDoctor.delete({ where: { id } });
    },
  },
  BD_OPPORTUNITY: {
    label: "opportunité (Business Development)",
    module: "Business Development",
    redirect: "/business-development",
    model: "businessDevelopmentOpportunity",
    entityType: "BD_OPPORTUNITY",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.businessDevelopmentOpportunity.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.businessDevelopmentOpportunity.delete({ where: { id } });
    },
  },
  BD_PROJECT: {
    label: "projet",
    module: "Projets",
    // L'écran « Projets » (module `BD_PROJECTS`, §118.163) — et non plus la racine de Market
    // Intelligence, retirée : un retour après suppression vers une page qui ne s'ouvre pas.
    redirect: "/business-development/projets",
    model: "bdProject",
    entityType: "BD_PROJECT",
    // Ses gammes et ses produits partent en cascade, et chaque dossier réglementaire classé perd
    // son projet : un lot les instantane tous, et tout revient ensemble à la restauration.
    lot: true,
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.bdProject.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.bdProject.delete({ where: { id } });
    },
  },
  DIRECTIVE: {
    label: "directive",
    module: "Directives",
    redirect: "/directives",
    model: "directive",
    entityType: "DIRECTIVE",
    searchFields: ["reference", "title"],
    async describe(id) {
      const r = await prisma.directive.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async remove(id) {
      await prisma.directive.delete({ where: { id } });
    },
  },
  SUPPORT_REQUEST: {
    label: "demande de support",
    module: "Support",
    redirect: "/support",
    model: "supportRequest",
    entityType: "SUPPORT_REQUEST",
    searchFields: ["reference", "subject"],
    async describe(id) {
      const r = await prisma.supportRequest.findUnique({ where: { id }, select: { reference: true, subject: true } });
      return r ? `${r.reference} — ${r.subject}` : null;
    },
    async remove(id) {
      await prisma.supportRequest.delete({ where: { id } });
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
