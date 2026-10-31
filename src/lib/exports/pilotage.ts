import * as XLSX from "xlsx";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { resolveRepScope } from "@/lib/sfe";
import { recordAudit } from "@/lib/audit";
import { busDuPerimetre, chargerPilotage } from "@/lib/queries/force-de-vente";
import { ETAT_PLAN_LABELS, nomDuMois } from "@/lib/force-de-vente/calculs";
import { plier } from "@/lib/exports/filtres";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * L'EXPORT DU PILOTAGE (Force de vente, Direction 07/10) — le tableau des délégués tel que l'écran le montre, pour la
 * portée de la personne : délégué, BU, secteur, couverture H · A · B, réalisé, requis, attendu, plan, rapports en
 * retard. Partagé par `/api/planning/export` et l'Assistant IA (lot K7, décision 0037).
 */
export interface OptionsExportPilotage {
  annee?: number | null;
  mois?: number | null;
  /** La BU : identifiant (l'écran) ou nom (l'assistant) — hors périmètre, elle est ignorée (toutes les BU visibles). */
  bu?: string | null;
}

export async function exporterPilotage(user: CurrentUser, o: OptionsExportPilotage = {}): Promise<ResultatExport> {
  if (!userCan(user, "SALES_PLANNING", "VIEW")) return refusExport(403, "Non autorisé.");
  const maintenant = new Date();
  const year = o.annee && o.annee > 2000 ? o.annee : maintenant.getFullYear();
  const month = o.mois && o.mois >= 1 && o.mois <= 12 ? o.mois : maintenant.getMonth() + 1;
  const scope = await resolveRepScope(user);
  const bus = await busDuPerimetre(scope, user.id);
  const q = o.bu ? plier(o.bu) : "";
  const buId = q ? (bus.find((b) => b.id === o.bu) ?? bus.find((b) => plier(b.nom) === q) ?? bus.find((b) => plier(b.nom).includes(q)))?.id ?? null : null;
  const { lignes, jour, total } = await chargerPilotage({ scope, userId: user.id, buId, year, month });

  const feuille: (string | number | null)[][] = [
    ["Délégué", "BU", "Secteur", "Cibles H·A·B", "Vues à fréquence", "Couverture %", "Réalisé", "Requis", `Attendu à J${jour}/${total}`, "Plan", "Rapports en retard"],
    ...lignes.map((l) => [
      l.nom, l.buNom ?? "", l.secteurNom ?? "",
      l.couverture.cibles, l.couverture.vues, l.couverture.pct,
      l.realise, l.requis, l.attendu, ETAT_PLAN_LABELS[l.plan.etat], l.rapportsEnRetard,
    ]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(feuille), "Délégués");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const bu = buId ? bus.find((b) => b.id === buId)?.nom ?? "" : "toutes-bu";
  const periode = nomDuMois(year, month, new Date(0));
  const nom = `force-de-vente-${periode.replace(/\s+/g, "-")}-${bu.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.xlsx`;
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Force de vente", summary: `Export du pilotage — ${periode}, ${lignes.length} délégué(s)` });
  return exporte(buffer, nom, MIME_XLSX, `le pilotage de ${periode} — ${lignes.length} délégué(s)${buId ? `, BU ${bu}` : ""}`);
}
