import type { LegalDocKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SourceEcheances } from "@/lib/echeances/regles";
import { natureLegale } from "@/lib/labels";
import { estTermine } from "./lifecycle";

/**
 * LES ÉCHÉANCES LEGAL DANS « AUJOURD'HUI » (échéances intégrées, 24/11/2026) — les engagements qui arrivent à terme :
 * contrats, avenants, accords, baux, licences, agréments, assurances, cautions (rangées en « autre »).
 * Les pièces d'achat (devis, BC, factures, avoirs) n'en sont pas : leur date est un délai de paiement, que le
 * circuit de paiement porte déjà. Statuts et PV n'ont pas de terme.
 *
 * Les RAPPELS (notifications à J-90, J-30, au dépassement) restent ceux du balayage (`expiry-sweep.ts`) ; ici, la
 * ligne qui reste sous les yeux tant que l'échéance n'est pas traitée — 90 jours au plus après le terme : au-delà,
 * la pièce est « arrivée à terme » au registre et c'est là qu'on la solde.
 *
 * UN ENGAGEMENT PONCTUEL TERMINÉ n'a pas de ligne (Super Admin, 25/11/2026 — `lifecycle.estTermine`) : une convention
 * d'orateur d'un jour, passée, a eu lieu ; il n'y a rien à traiter. Avant sa fin, il garde sa ligne comme les autres.
 */
const NATURES_A_ECHEANCE: LegalDocKind[] = [
  "CONTRACT", "AMENDMENT", "AGREEMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "APPROVAL", "MARKETING_AUTHORIZATION", "OTHER",
];
const RETARD_MAX_JOURS = 90;

export const echeancesLegal: SourceEcheances = {
  cle: "legal",
  async lire({ maintenant, jusquau }) {
    const docs = await prisma.legalDocument.findMany({
      where: {
        kind: { in: NATURES_A_ECHEANCE },
        status: { in: ["ACTIVE", "EXPIRED"] },
        endDate: { gte: new Date(maintenant.getTime() - RETARD_MAX_JOURS * 86_400_000), lte: jusquau },
      },
      select: {
        id: true, title: true, kind: true, counterparty: true, status: true, startDate: true, endDate: true, companyId: true, createdById: true,
        readers: { select: { userId: true } },
      },
      orderBy: { endDate: "asc" },
    });
    return docs.filter((d) => !estTermine(d, maintenant)).map((d) => ({
      source: "legal.document", id: d.id, module: "Legal",
      libelle: `Échéance — ${d.title.trim() || "Document sans titre"}`,
      detail: [natureLegale(d.kind), d.counterparty].filter(Boolean).join(" · "),
      date: d.endDate as Date,
      href: `/legal/${d.id}`, liste: "/legal?echeances=1", companyId: d.companyId,
      responsables: d.createdById ? [d.createdById] : [],
      droit: { module: "LEGAL", action: "UPDATE" as const },
      lecteurs: d.readers.map((r) => r.userId),
    }));
  },
};
