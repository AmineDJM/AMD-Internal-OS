import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { peutPiloterDemandesStocks, chargerDemandeStocks } from "@/lib/queries/demande-stocks";
import { ecrireCsv } from "@/lib/formats/tableur";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_CSV, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * EXPORT D'UNE DEMANDE DE STOCKS — une ligne par case (établissement × produit), lisible par un tableur français
 * (point-virgule, marque UTF-8). Même garde que le suivi : qui pilote. Partagé par `/api/stocks/demandes/[id]/export`
 * et l'Assistant IA (lot K7, décision 0037), qui désigne la demande par son titre (la plus récente qui correspond).
 */
export async function exporterDemandeStocks(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "STOCKS", "VIEW") || !peutPiloterDemandesStocks(user)) return refusExport(403, "Non autorisé.");
  const t = designation.trim();
  const id = !t ? null : estIdentifiant(t) ? t : (await prisma.stockCountRequest.findFirst({
    where: { title: { contains: t, mode: "insensitive" } }, orderBy: { createdAt: "desc" }, select: { id: true },
  }))?.id ?? null;
  const d = id ? await chargerDemandeStocks(id) : null;
  if (!d) return refusExport(404, "Demande de stocks introuvable.");

  const hop = new Map(d.hopitaux.map((h) => [h.id, h]));
  const nomKam = new Map(d.destinataires.map((x) => [x.kamId, x.nom]));
  const lignes = d.lignes
    .map((l) => {
      const h = hop.get(l.hopitalId);
      return {
        "Wilaya": h?.wilaya ?? "",
        "Établissement": h?.name ?? "",
        "Produit": l.productLabel,
        "KAM": l.kamIds.length ? l.kamIds.map((k) => nomKam.get(k) ?? "").join(", ") : "sans KAM",
        "Stock (boîtes)": l.rupture ? 0 : l.quantite,
        "Rupture": l.rupture ? "oui" : "",
        "Saisi par": l.savedBy ?? "",
        "Saisi le": l.savedAt ? new Date(l.savedAt).toLocaleString("fr-FR", { timeZone: "Africa/Algiers" }) : "",
        "Note établissement": h?.note ?? "",
      };
    })
    .sort((a, b) => a["Wilaya"].localeCompare(b["Wilaya"], "fr") || a["Établissement"].localeCompare(b["Établissement"], "fr") || a["Produit"].localeCompare(b["Produit"], "fr"));
  // Les établissements SANS ligne (aucun produit porté par leurs KAM, ou sans KAM) figurent aussi : l'export dit ce qui
  // a été demandé, pas seulement ce qui a été rempli.
  const avecLigne = new Set(d.lignes.map((l) => l.hopitalId));
  for (const h of d.hopitaux.filter((x) => !avecLigne.has(x.id))) {
    lignes.push({
      "Wilaya": h.wilaya ?? "", "Établissement": h.name, "Produit": "", "KAM": h.sansKam ? "sans KAM" : "",
      "Stock (boîtes)": null, "Rupture": "", "Saisi par": "", "Saisi le": "", "Note établissement": h.note ?? "",
    });
  }
  const { texte } = ecrireCsv(lignes, { locale: "fr" });
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Stocks", summary: `Export de la demande de stocks « ${d.title} » (${lignes.length} ligne(s))` });
  return exporte(texte, `demande-stocks-${d.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.csv`, MIME_CSV, `la demande de stocks « ${d.title} » — ${lignes.length} ligne(s)`);
}
