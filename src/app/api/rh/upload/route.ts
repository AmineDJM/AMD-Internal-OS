import { NextRequest, NextResponse } from "next/server";
import { HrDocumentCategory } from "@prisma/client";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { entitePermisePourFiche } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import {
  mirrorEmployeeContractToDrive, marquerDemandeRhTraitee, resolveVisibility, shouldMirrorToDrive,
  visibilityLabel, hrNature, refusTransitionDemandeRh,
} from "@/modules/rh/api";
import { clauseSalariesVisibles } from "@/lib/queries/visibilite-listes";
import { synchroniserOrdreEmis } from "@/lib/missions-equipe/serveur";
import { sansBloquer } from "@/lib/journal";
import { inscrireDocumentRh } from "@/modules/bibliotheque/api-inscription";
import { typeDeDepot } from "@/lib/drive/mime-nom";

export const dynamic = "force-dynamic";

/** Upload d'un document RH pour un employé (contrat, bulletin, attestation…). RH uniquement. */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  const form = await req.formData();
  // LE DROIT SUIT LE SOUS-MODULE (Direction, 06/10) : la pièce qui RÉPOND à une demande relève des Demandes RH ; un
  // document du dossier d'un salarié, des Employés.
  if (!userCan(user, form.get("requestId") ? "HR_REQUESTS" : "EMPLOYEES", "UPDATE")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  const employeeId = (form.get("employeeId") as string) || "";
  if (!employeeId) return NextResponse.json({ error: "Employé manquant." }, { status: 400 });
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, userId: true, fullName: true, companyId: true } });
  // LA PORTE DE LA FICHE (`/rh/[id]`) : le dossier d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!employee || !(await entitePermisePourFiche(user.id, employee.companyId))) return NextResponse.json({ error: "Employé introuvable." }, { status: 404 });

  const err = validateUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const catRaw = (form.get("category") as string) || "OTHER";
  const category = (Object.values(HrDocumentCategory) as string[]).includes(catRaw) ? (catRaw as HrDocumentCategory) : "OTHER";
  const requestId = (form.get("requestId") as string) || null;
  // La demande à laquelle la pièce répond est celle de CE salarié — sinon on marquait « prête » la demande d'un autre —
  // et dans le périmètre de la file « Demandes RH » (`clauseSalariesVisibles`, la clause de `processHrRequest`).
  const demande = requestId
    ? await prisma.hrDocumentRequest.findFirst({ where: { id: requestId, employeeId, employee: await clauseSalariesVisibles(user.id) }, select: { status: true, type: true } })
    : null;
  if (requestId && !demande) return NextResponse.json({ error: "Demande introuvable pour ce salarié." }, { status: 404 });

  // QUI VERRA CETTE PIÈCE. Le défaut suit la NATURE du document : ce qu'on remet au salarié
  // (bulletin, attestations) lui est visible, ce que les RH conservent (contrat, avenant, pièce
  // d'identité, diplôme) reste aux RH. Le champ du formulaire, s'il est envoyé, l'emporte —
  // remettre son contrat signé à quelqu'un est un geste normal, mais c'est alors une décision,
  // pas un défaut. Absent = « rien coché », ce qui n'est PAS « décoché ».
  const visRaw = form.get("visibleToEmployee");
  const visibleToEmployee = resolveVisibility(
    category,
    visRaw == null ? undefined : visRaw === "1" || visRaw === "true" || visRaw === "on",
  );

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId, size, sha256 } = await putBlob(buf);

  const doc = await prisma.employeeDocument.create({
    data: {
      employeeId,
      category,
      name: (form.get("name") as string) || file.name,
      blobId,
      mime: typeDeDepot(file.name, file.type),
      size,
      period: (form.get("period") as string) || null,
      visibleToEmployee,
      uploadedById: user.id,
      requestId: requestId || undefined,
    },
    select: { id: true, name: true },
  });
  // La pièce entre à la bibliothèque, CONFIDENTIELLE (J1) : ouverte par la règle de `/api/rh/document`, jamais à un modèle.
  await inscrireDocumentRh({ id: doc.id, blobId, sha256, nom: doc.name, mime: typeDeDepot(file.name, file.type), taille: size, deposeParId: user.id });

  // Si le document répond à une demande : la marquer « prête » et prévenir l'employé — seulement si le graphe des statuts
  // le permet (audit sécurité 11/2026) : une pièce jointe à une demande annulée, remise, à un congé ou à une note de frais
  // ne la rend pas « prête » (ces décisions ont leur porte). Écriture conditionnée au statut lu (§118.151).
  let marquee = false;
  if (requestId && demande && demande.status !== "READY" && !refusTransitionDemandeRh(hrNature(demande.type), demande.status, "READY")) {
    const pris = await prisma.hrDocumentRequest.updateMany({ where: { id: requestId, status: demande.status }, data: { status: "READY", handledById: user.id } })
      .catch(sansBloquer("upload-route.POST.hrDocumentRequest", { count: 0 }));
    marquee = pris.count === 1;
  }
  if (requestId && marquee) {
    await marquerDemandeRhTraitee(requestId); // brique KPI « demandes traitées »
    // Un ordre de mission joint à la main : la mission Ad & Pro reliée le sait (« émis »).
    await synchroniserOrdreEmis(requestId, user.id);
    if (employee.userId) {
      await notifyUser({ userId: employee.userId, type: "GENERIC", title: "Votre document RH est prêt", body: doc.name, link: "/mon-dossier" });
    }
  } else if (requestId && visibleToEmployee && employee.userId) {
    // Pièce ajoutée sans changer l'état (document remplacé, pièce à une note de frais) : le salarié la voit, on le prévient.
    await notifyUser({ userId: employee.userId, type: "GENERIC", title: "Un document a été joint à votre demande RH", body: doc.name, link: "/mon-dossier" });
  }

  // Contrat / avenant : AUSSI enregistré dans le Drive, sous « RH — Contrats / <employé> ».
  // C'est là qu'on ira le chercher dans trois ans, quand la personne qui l'a déposé aura changé
  // de poste. La restriction tient par la CATÉGORIE de Drive — ouverte aux seuls rôles des
  // ressources humaines — et non en refusant d'écrire. Best-effort, en arrière-plan : le miroir
  // ne doit jamais faire échouer le dépôt RH.
  if (shouldMirrorToDrive(category, visibleToEmployee)) {
    void mirrorEmployeeContractToDrive({ ownerId: user.id, employeeName: employee.fullName, filename: doc.name, data: buf, mime: typeDeDepot(file.name, file.type) })
      .catch((e) => console.error("[rh upload] miroir contrat → Drive échoué", e));
  }

  await recordAudit({
    actorId: user.id, action: "UPLOAD", module: "RH", entityType: "EMPLOYEE", entityId: employeeId,
    summary: `Document RH « ${doc.name} » — ${visibilityLabel(visibleToEmployee)}`,
  });
  return NextResponse.json({ id: doc.id });
}
