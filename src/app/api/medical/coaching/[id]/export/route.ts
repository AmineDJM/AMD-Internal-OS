import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { lecteurCoaching } from "@/lib/coaching/serveur";
import { chargerFicheVisible } from "@/lib/coaching/fiches";
import { construireClasseurFiche, nomDeFichier } from "@/lib/coaching/classeur";
import { formaterJour } from "@/lib/coaching/dates";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * TÉLÉCHARGER UNE FICHE DE COACHING (§118.157) — le classeur au format du modèle de la Direction.
 *
 * La porte est celle de l'écran : `chargerFicheVisible`, donc la même règle que la page de la
 * fiche. Une fiche invisible rend 404, comme une fiche inexistante.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "MEDICAL", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  const l = await lecteurCoaching(user);
  const fiche = await chargerFicheVisible(l, params.id);
  if (!fiche) return NextResponse.json({ error: "Fiche introuvable." }, { status: 404 });
  if (!fiche.grille) {
    return NextResponse.json({ error: "La grille de cette fiche ne se lit plus : le classeur ne peut pas être composé." }, { status: 409 });
  }
  const { octets } = await construireClasseurFiche({
    grille: fiche.grille,
    gridVersion: fiche.gridVersion,
    collaborateur: fiche.collaborateur,
    manager: fiche.manager,
    visitDate: fiche.visitDate,
    sector: fiche.sector,
    notes: fiche.notes,
    strengths: fiche.strengths,
    improvements: fiche.improvements,
    status: fiche.status,
    finalizedAt: fiche.finalizedAt,
    finalisePar: fiche.finalisePar,
  });
  await recordAudit({
    actorId: user.id, action: "EXPORT", module: "Promotion médicale", entityId: fiche.id,
    summary: `Export de la fiche de coaching — ${fiche.collaborateur}, tournée du ${formaterJour(fiche.visitDate)}`,
  });
  return new NextResponse(octets as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(nomDeFichier(fiche.collaborateur, fiche.visitDate)),
      "Cache-Control": "no-store",
    },
  });
}
