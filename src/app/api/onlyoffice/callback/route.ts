import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { ajouterVersionDrive, rendreBlobOrphelin } from "@/lib/drive/versions";
import { enregistrerVersionDocument } from "@/lib/document-versions";
import { recordAudit } from "@/lib/audit";
import { onlyofficeConfigured, lireRappelOnlyoffice } from "@/lib/onlyoffice";
import { peutEnregistrerOnlyoffice } from "@/lib/onlyoffice-session";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";

/**
 * Callback du Document Server : à l'enregistrement (status 2 ou 6), il fournit l'URL
 * du document édité ; on le récupère et on crée une **nouvelle version**.
 * Gère le Drive (FileVersion) ET les documents (modèle Document, `DocumentVersion` : chaque enregistrement garde le
 * précédent lisible). Le numéro de version se prend sous verrou : deux rappels simultanés font deux versions. Un
 * enregistrement FORCÉ (statut 6) est marqué : la clé d'édition (`onlyoffice-session.ts`) l'ignore, la session
 * continue au lieu de se scinder. Triple sécurité :
 * notre jeton d'ENREGISTREMENT (lié au nœud/document + utilisateur, émis en mode édition seulement),
 * le JWT du Document Server (OBLIGATOIRE), et le droit d'enregistrer relu au moment d'écrire.
 * Doit toujours répondre `{ error: 0 }` en cas de succès.
 */
export async function POST(req: NextRequest) {
  if (!onlyofficeConfigured()) return NextResponse.json({ error: 1 });

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: 1 });
  }

  // La décision est pure (`lireRappelOnlyoffice`) : jeton d'ENREGISTREMENT, corps SIGNÉ par le Document
  // Server, valeurs lues dans la partie signée, adresse chez le Document Server. Voir `lib/onlyoffice.ts`.
  const rappel = lireRappelOnlyoffice({
    jeton: req.nextUrl.searchParams.get("token"),
    id: req.nextUrl.searchParams.get("id"),
    docId: req.nextUrl.searchParams.get("docId"),
    corps,
    autorisation: req.headers.get("authorization"),
  });
  if (rappel.action === "refuser") {
    console.warn(`[onlyoffice] rappel refusé : ${rappel.raison}`);
    return NextResponse.json({ error: 1 });
  }
  if (rappel.action === "ignorer") return NextResponse.json({ error: 0 });

  // LE DROIT SE RELIT AU MOMENT D'ÉCRIRE : un droit retiré (ou un compte désactivé) depuis l'ouverture
  // de l'éditeur ne s'exerce plus, même avec un jeton encore valide.
  const { cible, id, userId } = rappel.jeton;
  if (!(await peutEnregistrerOnlyoffice(userId, cible, id))) {
    console.warn(`[onlyoffice] rappel refusé : ${userId} n'a plus le droit d'enregistrer ${cible} ${id}`);
    return NextResponse.json({ error: 1 });
  }

  try {
    const res = await fetch(rappel.url);
    if (!res.ok) return NextResponse.json({ error: 1 });
    const buf = Buffer.from(await res.arrayBuffer());

    // ─── Document (pièce d'un dossier / Regulatory / etc.) : une NOUVELLE clé, l'ancienne reste lisible ───
    if (cible === "document") {
      const r = await enregistrerVersionDocument(id, buf, userId, { forcesave: rappel.forcage });
      if (!r.ok) return NextResponse.json({ error: 1 });
      const doc = await prisma.document.findUnique({ where: { id }, select: { entityType: true, entityId: true, name: true } });
      if (doc) await recordAudit({ actorId: userId, action: "UPLOAD", module: "Documents", entityType: doc.entityType, entityId: doc.entityId, summary: `Édition Office enregistrée (v${r.version}) — ${doc.name}` });
      // La version éditée est entrée à la bibliothèque (J1) avec son écriture (`enregistrerVersionDocument`).
      return NextResponse.json({ error: 0 });
    }

    // ─── Drive (DriveNode + FileVersion) ───
    const { blobId, size, sha256 } = await putBlob(buf);
    let ecrit: { version: number; mimeType: string };
    try {
      ecrit = await ajouterVersionDrive({ nodeId: id, blobId, size, createdById: userId, forcesave: rappel.forcage });
    } catch (e) {
      // Rien n'est inscrit : le contenu compté pour ce rappel se rend (le Document Server renverra le rappel).
      await rendreBlobOrphelin(blobId, "onlyoffice.callback.rendreBlob");
      throw e;
    }
    const { version, mimeType } = ecrit;
    await recordAudit({ actorId: userId, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: id, summary: `Édition Office enregistrée (v${version})${rappel.forcage ? " — enregistrement en cours de session" : ""}` });
    // La nouvelle version entre à la bibliothèque (J1) : la clé du nœud passe à ce contenu. Ne lève jamais.
    const noeud = await prisma.driveNode.findUnique({ where: { id }, select: { name: true } });
    await inscrireFichierDrive({ nodeId: id, version, blobId, sha256, nom: noeud?.name ?? "document", mime: mimeType, taille: size, deposeParId: userId });
    return NextResponse.json({ error: 0 });
  } catch (e) {
    console.error("[onlyoffice] save failed", e);
    return NextResponse.json({ error: 1 });
  }
}
