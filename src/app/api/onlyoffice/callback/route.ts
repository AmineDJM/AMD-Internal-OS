import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { saveFile } from "@/lib/storage";
import { recordAudit } from "@/lib/audit";
import { onlyofficeConfigured, lireRappelOnlyoffice } from "@/lib/onlyoffice";
import { peutEnregistrerOnlyoffice } from "@/lib/onlyoffice-session";

/**
 * Callback du Document Server : à l'enregistrement (status 2 ou 6), il fournit l'URL
 * du document édité ; on le récupère et on crée une **nouvelle version**.
 * Gère le Drive (FileVersion) ET les documents (modèle Document). Triple sécurité :
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

    // ─── Document (pièce d'un dossier / Regulatory / etc.) ───
    if (cible === "document") {
      const docId = id;
      const doc = await prisma.document.findUnique({ where: { id: docId }, select: { fileKey: true, entityType: true, entityId: true, name: true } });
      if (!doc) return NextResponse.json({ error: 1 });
      const key = doc.fileKey || `${doc.entityType}/${doc.entityId}/${randomUUID()}__${doc.name}`;
      await saveFile(key, buf);
      await prisma.document.update({ where: { id: docId }, data: { fileKey: key, sizeBytes: buf.length, version: { increment: 1 } } });
      await recordAudit({ actorId: userId, action: "UPLOAD", module: "Documents", entityType: doc.entityType, entityId: doc.entityId, summary: `Édition Office enregistrée — ${doc.name}` });
      return NextResponse.json({ error: 0 });
    }

    // ─── Drive (DriveNode + FileVersion) ───
    const { blobId, size } = await putBlob(buf);
    const last = await prisma.fileVersion.findFirst({ where: { nodeId: id }, orderBy: { version: "desc" }, select: { version: true, mimeType: true } });
    const version = (last?.version ?? 0) + 1;
    await prisma.fileVersion.create({
      data: { nodeId: id, blobId, version, size, mimeType: last?.mimeType ?? "application/octet-stream", createdById: userId },
    });
    await prisma.driveNode.update({ where: { id }, data: { size } });
    await recordAudit({ actorId: userId, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: id, summary: `Édition Office enregistrée (v${version})` });
    return NextResponse.json({ error: 0 });
  } catch (e) {
    console.error("[onlyoffice] save failed", e);
    return NextResponse.json({ error: 1 });
  }
}
