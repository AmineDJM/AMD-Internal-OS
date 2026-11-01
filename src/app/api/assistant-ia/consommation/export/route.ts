import * as XLSX from "xlsx";
import { getCurrentUser } from "@/lib/session";
import { contentDisposition } from "@/lib/http/content-disposition";
import { cibleDe, lireAppels, LIMITE_EXPORT } from "@/modules/assistant-ia/api";
import { COLONNES_EXPORT, jourAlger, ligneExport, periodeChoisie, versCsv } from "@/modules/assistant-ia/partage";

export const dynamic = "force-dynamic";

/**
 * L'EXPORT DE LA CONSOMMATION IA (lot K8, décision 0035) — le détail appel par appel de la période, en CSV ou en Excel.
 * Même garde que l'écran : `perimetre=moi` n'exporte QUE les appels de la personne connectée ; `entreprise` est réservé
 * au Super Admin. Coût au micro-dollar (6 décimales), « tarif inconnu » quand il l'est.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Non autorisé.", { status: 401 });
  const sp = new URL(req.url).searchParams;
  const perimetre = sp.get("perimetre") === "entreprise" ? "entreprise" : "moi";
  const cible = cibleDe({ perimetre, userId: user.id, estSuperAdmin: user.role === "SUPER_ADMIN", personne: sp.get("personne") });
  if ("refus" in cible) return new Response(cible.refus, { status: 403 });
  const { debut, fin } = periodeChoisie(sp.get("du"), sp.get("au"), new Date());
  const appels = await lireAppels({ debut, fin, userId: cible.userId }, LIMITE_EXPORT);
  const feuille = [[...COLONNES_EXPORT], ...appels.map(ligneExport)];
  const nom = `consommation-ia-${perimetre}-${jourAlger(debut)}-au-${jourAlger(new Date(fin.getTime() - 1))}`;
  if (sp.get("format") === "xlsx") {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(feuille), "Appels");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new Response(new Uint8Array(buffer), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": contentDisposition(`${nom}.xlsx`) },
    });
  }
  return new Response(versCsv(feuille), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${nom}.csv`) },
  });
}
