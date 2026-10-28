import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { readFileByKey } from "@/lib/storage";
import { recordAudit } from "@/lib/audit";
import { peutTraiterCandidaturesSite, nomDeFichierSur } from "@/lib/site-web/candidatures";
import { contentDisposition } from "@/lib/http/content-disposition";

export const dynamic = "force-dynamic";

/**
 * LE CV D'UNE CANDIDATURE DE LA BOÎTE D'ARRIVÉE (§118.159) — derrière la SESSION (ce chemin n'est
 * pas sous `/api/site-web/v1/`), et derrière la porte du tri : les RH et la direction. Une fois la
 * candidature rattachée, son CV est un Document du candidat et se sert par `/api/documents/[id]`,
 * sous la porte de SA demande.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!peutTraiterCandidaturesSite(user)) return NextResponse.json({ error: "Accès refusé" }, { status: 403 });

  const c = await prisma.siteCandidature.findUnique({ where: { id: params.id }, select: { id: true, cvCle: true, cvNom: true, cvType: true, nom: true } });
  if (!c) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  if (!c.cvCle) return NextResponse.json({ error: "Cette candidature n'a pas de CV." }, { status: 404 });

  try {
    const octets = await readFileByKey(c.cvCle);
    const telecharger = req.nextUrl.searchParams.get("dl") === "1";
    if (telecharger) {
      await recordAudit({ actorId: user.id, action: "EXPORT", module: "Recrutement", entityId: c.id, summary: `Téléchargement du CV de ${c.nom} (candidature du site)` });
    }
    const nom = nomDeFichierSur(c.cvNom ?? "cv");
    return new NextResponse(octets as unknown as BodyInit, {
      headers: {
        "Content-Type": c.cvType ?? "application/octet-stream",
        // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
        ...entetesAntiExecution(c.cvType ?? "application/octet-stream"),
        "Content-Disposition": contentDisposition(nom, telecharger ? "attachment" : "inline"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Fichier indisponible" }, { status: 404 });
  }
}
