import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { A_DECLARER_PV } from "@/lib/pharmacovigilance/regles";
import { etatEcheancePv, viseursDuCasPv } from "@/lib/pharmacovigilance/declaration";
import { lireReglagesPv, societeDuCasPv } from "@/lib/pharmacovigilance/reglages";
import { declarantDuCasPv, lienCasPvRegulatory } from "@/lib/pharmacovigilance/alertes";
import type { ActionItem } from "./action-center";

/**
 * « AUJOURD'HUI » — LA PHARMACOVIGILANCE QUI M'ATTEND (déclaration à l'autorité, Super Admin 24/11/2026).
 *
 *   - Les déclarations dont l'échéance est à cinq jours ou moins, ou dépassée (rouge) : au Responsable réglementaire et
 *     au déclarant (la personne de Regulatory qui porte le cas) — les mêmes que les alertes (`alertes.ts`).
 *   - Les déclarations enregistrées qui attendent le visa du pharmacien responsable désigné : à lui.
 * La ligne sort d'elle-même quand la déclaration est enregistrée (ou le visa donné).
 */
export async function lignesPharmacovigilance(user: SessionUser, maintenant: Date = new Date()): Promise<ActionItem[]> {
  const responsable = hasRole(user, "HEAD_OF_REGULATORY");
  const reglages = await lireReglagesPv();
  const pharmacien = Object.values(reglages.pharmaciens).includes(user.id);
  const out: ActionItem[] = [];

  const aDeclarer = await prisma.pharmacovigilanceCase.findMany({
    where: {
      declareLe: null, status: { in: [...A_DECLARER_PV] },
      ...(responsable ? {} : { OR: [{ evalueParId: user.id }, { evalueParId: null, investigationOpenedById: user.id }] }),
    },
    select: {
      id: true, reference: true, status: true, productLabel: true, institutionName: true, declareLe: true, dateConnaissance: true,
      evalGrave: true, severity: true, evalueParId: true, investigationOpenedById: true,
    },
    orderBy: { dateConnaissance: "asc" },
    take: 200,
  });
  for (const c of aDeclarer) {
    if (!responsable && declarantDuCasPv(c) !== user.id) continue;
    const e = etatEcheancePv(c, reglages.delais, maintenant);
    if (!e?.palier) continue;
    const enRetard = e.palier === "DEPASSE";
    out.push({
      key: `pv-decl-${c.id}`, objet: `PHARMACOVIGILANCE_CASE:${c.id}`,
      title: `${c.reference} — déclarer à l'autorité`,
      subtitle: `${e.libelle} · ${c.productLabel} · ${c.institutionName}`,
      module: "Pharmacovigilance", href: lienCasPvRegulatory(c.id), kind: "regulatory",
      priority: enRetard || e.palier === "J0" ? "CRITICAL" : "HIGH",
      // La fin du jour d'échéance, heure d'Alger : « en retard » dès le lendemain, pas dès minuit UTC.
      deadline: `${e.jour}T23:59:59+01:00`, depuis: c.dateConnaissance.toISOString(), owner: "",
      statusLabel: enRetard ? "Délai dépassé" : "À déclarer", statusTone: enRetard || e.palier === "J0" ? "danger" : "warning",
    });
  }

  if (pharmacien) {
    const aViser = await prisma.pharmacovigilanceCase.findMany({
      where: { declareLe: { not: null }, visaPharmacienLe: null, status: { in: ["DECLARE", "SUIVI"] } },
      select: { id: true, reference: true, productLabel: true, productId: true, promoProductId: true, declarationEnregistreeLe: true },
      orderBy: { declareLe: "asc" },
      take: 100,
    });
    for (const c of aViser) {
      if (!viseursDuCasPv(reglages.pharmaciens, await societeDuCasPv(c)).includes(user.id)) continue;
      out.push({
        key: `pv-visa-${c.id}`, objet: `PHARMACOVIGILANCE_VISA:${c.id}`,
        title: `${c.reference} — déclaration à viser`, subtitle: c.productLabel,
        module: "Pharmacovigilance", href: lienCasPvRegulatory(c.id), kind: "validation", priority: "HIGH",
        deadline: null, depuis: c.declarationEnregistreeLe?.toISOString() ?? null, owner: "",
        statusLabel: "Visa attendu", statusTone: "warning",
      });
    }
  }
  return out;
}
