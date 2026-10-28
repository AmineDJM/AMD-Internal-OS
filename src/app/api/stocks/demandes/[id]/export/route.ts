import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { peutPiloterDemandesStocks, chargerDemandeStocks } from "@/lib/queries/demande-stocks";
import { ecrireCsv } from "@/lib/formats/tableur";

export const dynamic = "force-dynamic";

/**
 * EXPORT D'UNE DEMANDE DE STOCKS — une ligne par case (établissement × produit), lisible par un
 * tableur français (point-virgule, marque UTF-8). Même garde que le suivi : qui pilote.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user || !userCan(user, "STOCKS", "VIEW") || !peutPiloterDemandesStocks(user)) return new NextResponse(null, { status: 403 });
  const d = await chargerDemandeStocks(params.id);
  if (!d) return new NextResponse(null, { status: 404 });

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
  // Les établissements SANS ligne (aucun produit porté par leurs KAM, ou sans KAM) figurent aussi :
  // l'export dit ce qui a été demandé, pas seulement ce qui a été rempli.
  const avecLigne = new Set(d.lignes.map((l) => l.hopitalId));
  for (const h of d.hopitaux.filter((x) => !avecLigne.has(x.id))) {
    lignes.push({
      "Wilaya": h.wilaya ?? "", "Établissement": h.name, "Produit": "", "KAM": h.sansKam ? "sans KAM" : "",
      "Stock (boîtes)": null, "Rupture": "", "Saisi par": "", "Saisi le": "", "Note établissement": h.note ?? "",
    });
  }

  const { texte } = ecrireCsv(lignes, { locale: "fr" });
  const nom = `demande-stocks-${d.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.csv`;
  return new NextResponse(texte, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
