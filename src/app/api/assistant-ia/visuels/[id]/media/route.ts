import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getBlob } from "@/lib/drive-storage";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { contentDisposition } from "@/lib/http/content-disposition";
import { dispositionPourBucket, entetesAntiExecution } from "@/lib/http/types-actifs";
import { recordAudit } from "@/lib/audit";
import { fichierDuVisuel } from "@/modules/assistant-ia/api";
import { enVueExacte, refusAssistantIA } from "../../../personne";

export const dynamic = "force-dynamic";

/**
 * LE FICHIER D'UN VISUEL (lot K2, décision 0032) — l'image ou la vidéo, lue dans le Drive de la personne (droits du Drive
 * revérifiés : un fichier déplacé à la corbeille ou partagé autrement suit SES droits).
 *
 * LES REQUÊTES PARTIELLES (`Range`) SONT SERVIES : le lecteur vidéo de l'iPhone (Safari) n'en lit aucune autre — sans
 * 206, la vidéo ne démarre pas. `?dl=1` force le téléchargement (journalisé, comme au Drive).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus!;
  if (enVueExacte(user)) return new NextResponse(null, { status: 403 });
  const f = await fichierDuVisuel(user.id, id);
  if (!f) return new NextResponse(null, { status: 404 });
  if (!canViewDrive(await resolveDriveAccess(user, f.driveNodeId))) return new NextResponse(null, { status: 403 });
  const octets = await getBlob(f.blobId);
  if (!octets) return new NextResponse(null, { status: 404 });

  const dl = req.nextUrl.searchParams.get("dl") === "1";
  if (dl) await recordAudit({ actorId: user.id, action: "EXPORT", module: "Drive", entityType: "DRIVE_NODE", entityId: f.driveNodeId, summary: `Téléchargement « ${f.nom} » (visuel de l'assistant)` });
  const entetes: Record<string, string> = {
    "Content-Type": f.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    // Un type ACTIF (SVG, HTML) ne s'ouvrirait jamais en ligne : la règle commune des fichiers servis le télécharge.
    "Content-Disposition": contentDisposition(f.nom, dispositionPourBucket(f.mime, dl ? "attachment" : "inline")),
    "X-Content-Type-Options": "nosniff",
    ...entetesAntiExecution(f.mime),
  };
  const total = octets.length;
  const plage = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (plage && !dl) {
    const debut = plage[1] ? Number(plage[1]) : Math.max(0, total - Number(plage[2] || 0));
    const fin = plage[1] && plage[2] ? Math.min(Number(plage[2]), total - 1) : total - 1;
    if (!Number.isFinite(debut) || debut >= total || debut > fin) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const morceau = octets.subarray(debut, fin + 1);
    return new NextResponse(new Uint8Array(morceau), { status: 206, headers: { ...entetes, "Content-Range": `bytes ${debut}-${fin}/${total}`, "Content-Length": String(morceau.length) } });
  }
  return new NextResponse(new Uint8Array(octets), { status: 200, headers: { ...entetes, "Content-Length": String(total) } });
}
