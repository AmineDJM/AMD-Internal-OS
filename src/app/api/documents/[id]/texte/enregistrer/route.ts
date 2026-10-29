import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { readFileByKey, saveFile } from "@/lib/storage";
import { recordAudit } from "@/lib/audit";
import { estUnTexteEditable, texteAEnregistrer } from "@/lib/texte-fichier";
import { TAILLE_MAX_TEXTE_OCTETS } from "@/lib/formats/apercu";
import { sansBloquer } from "@/lib/journal";
import { inscrireDocumentExistant } from "@/modules/bibliotheque/api-inscription";

export const dynamic = "force-dynamic";
const SANS_CACHE = { "Cache-Control": "no-store" };

/**
 * ENREGISTRER un document texte — nouvelle version, comparée à celle que la personne a lue (409 si quelqu'un a modifié
 * entre-temps : on ne l'écrase pas en silence). Droit : celui de l'éditeur Office (téléverser sur l'entité).
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401, headers: SANS_CACHE });
  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc) return NextResponse.json({ error: "Introuvable" }, { status: 404, headers: SANS_CACHE });
  if (!(await canAccessEntity(user, doc.entityType, doc.entityId, "UPLOAD"))) {
    return NextResponse.json({ error: "Vous n'avez pas le droit de modifier ce document." }, { status: 403, headers: SANS_CACHE });
  }
  if (!doc.fileKey || !estUnTexteEditable(doc.name, doc.mimeType)) {
    return NextResponse.json({ error: "Ce n'est pas un fichier texte modifiable." }, { status: 415, headers: SANS_CACHE });
  }
  let corps: { texte?: unknown; version?: unknown };
  try { corps = await req.json(); } catch { return NextResponse.json({ error: "Requête illisible." }, { status: 400, headers: SANS_CACHE }); }
  // Un fichier TRONQUÉ à l'affichage (plus d'1 Mo) n'est JAMAIS réécrit : on écraserait la fin qu'on n'a pas montrée.
  const tailleActuelle = (await readFileByKey(doc.fileKey).catch(sansBloquer("enregistrer-route.POST.readFileByKey", null)))?.length ?? 0;
  const verifie = texteAEnregistrer(corps.texte, tailleActuelle > TAILLE_MAX_TEXTE_OCTETS);
  if (!verifie.ok) return NextResponse.json({ error: verifie.error }, { status: 400, headers: SANS_CACHE });

  // COMPARER ET ÉCHANGER : la version ne passe à la suivante que si elle est encore celle que la personne a lue.
  const prise = await prisma.document.updateMany({
    where: { id: doc.id, version: typeof corps.version === "number" ? corps.version : -1 },
    data: { version: { increment: 1 }, sizeBytes: verifie.octets.length },
  });
  if (prise.count === 0) {
    return NextResponse.json({ error: "Quelqu'un a modifié ce fichier depuis que vous l'avez ouvert : rouvrez-le pour voir sa dernière version.", conflit: true }, { status: 409, headers: SANS_CACHE });
  }
  try {
    await saveFile(doc.fileKey, verifie.octets);
  } catch (e) {
    await prisma.document.updateMany({ where: { id: doc.id }, data: { version: { decrement: 1 }, sizeBytes: doc.sizeBytes } });
    console.error("[texte] enregistrement impossible", e);
    return NextResponse.json({ error: "L'enregistrement a échoué : rien n'a été modifié." }, { status: 500, headers: SANS_CACHE });
  }
  await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Documents", entityType: doc.entityType, entityId: doc.entityId, summary: `Texte modifié — ${doc.name}` });
  // La nouvelle version entre à la bibliothèque (J1) ; l'ancienne ne ressort plus par ce document. Ne lève jamais.
  await inscrireDocumentExistant(doc.id, user.id);
  return NextResponse.json({ ok: true, version: doc.version + 1 }, { headers: SANS_CACHE });
}
