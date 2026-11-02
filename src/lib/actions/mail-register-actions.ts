"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import type { EntityType, MailDirection } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { canAccessEntity } from "@/lib/entity-access";
import { deleteFileByKey } from "@/lib/storage";
import { createMailEntryFor, updateMailEntryFor, setMailDateFor, type MailFields } from "@/lib/mail-register/write";
import { resolveParties } from "@/lib/queries/company-contacts";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { attachFormFiles } from "@/lib/documents";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";

/**
 * LE CARNET DE COURRIERS — la porte de l'ÉCRAN.
 *
 * L'écriture elle-même vit dans `src/lib/mail-register/write.ts`, partagée avec le registre
 * d'opérations de l'API des agents : deux implémentations auraient divergé, et un contrôle
 * ajouté d'un côté aurait manqué de l'autre. Ici on ne fait que trois choses — lire le
 * formulaire, résoudre la session, rafraîchir les écrans.
 *
 * Les quatre dates racontent le trajet du pli et se remplissent à des moments différents : on
 * POSTE (avec l'heure — deux courriers du même jour ne partent pas dans le même ordre), le pli
 * ARRIVE, puis on récupère l'ACCUSÉ. Aucune n'est obligatoire.
 */

const parseDirection = (v: string | null): MailDirection => (v === "INCOMING" ? "INCOMING" : "OUTGOING");

/** `datetime-local` renvoie « 2026-08-17T14:30 » — on garde l'heure, contrairement à `fdDate`. */
function fdDateTime(formData: FormData, key: string): Date | null {
  const raw = fdStr(formData, key);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * L'EXPÉDITEUR ET LE DESTINATAIRE VIENNENT DE L'ANNUAIRE.
 *
 * Le sélecteur pose un champ caché par contact retenu (un seul de chaque côté : un pli part d'un
 * endroit et arrive à un autre). Les colonnes texte `sender` / `recipient` restent la valeur
 * AFFICHÉE — recherche, exports et journal les lisent telles quelles — et c'est le serveur qui
 * les tient à jour à partir du contact choisi. Jamais l'inverse : les relire du formulaire
 * rouvrirait la porte du texte libre.
 */
async function readParties(userId: string, formData: FormData) {
  const un = (key: string) => formData.getAll(key).map(String).filter(Boolean).slice(0, 1);
  const expediteur = await resolveParties(userId, un("senderContactId"));
  const destinataire = await resolveParties(userId, un("recipientContactId"));
  if (!expediteur.ok) return { ok: false as const, error: expediteur.error };
  if (!destinataire.ok) return { ok: false as const, error: destinataire.error };
  return {
    ok: true as const,
    // `undefined` quand le champ n'était pas proposé : on ne détache alors personne.
    data: {
      ...(formData.has("senderContactId")
        ? { senderContactId: expediteur.ids[0] ?? null, sender: expediteur.text || null }
        : {}),
      ...(formData.has("recipientContactId")
        ? { recipientContactId: destinataire.ids[0] ?? null, recipient: destinataire.text || null }
        : {}),
    } satisfies Partial<MailFields>,
  };
}

function readFields(formData: FormData): MailFields {
  return {
    title: fdStr(formData, "title") ?? "",
    reference: fdStr(formData, "reference"),
    direction: parseDirection(fdStr(formData, "direction")),
    // `sender` / `recipient` NE SE LISENT PLUS DU FORMULAIRE : ils sont déduits du contact
    // d'annuaire choisi (voir `readParties`), et fusionnés par l'appelant.
    sentAt: fdDateTime(formData, "sentAt"),
    receivedAt: fdDate(formData, "receivedAt"),
    acknowledgedAt: fdDate(formData, "acknowledgedAt"),
    carrier: fdStr(formData, "carrier"),
    notes: fdStr(formData, "notes"),
    // Le champ n'est présent que si le formulaire propose des entités. `undefined` laisse le
    // noyau retomber sur l'entité par défaut du créateur — l'ancien comportement.
    ...(formData.has("companyId") ? { companyId: fdStr(formData, "companyId") } : {}),
    partnerId: fdStr(formData, "partnerId"),
    // Même précaution que pour l'entité : les deux menus ne sont rendus que s'il y a quelque chose
    // à choisir. Les lire inconditionnellement effacerait le rattachement d'un pli à chaque
    // enregistrement fait depuis un formulaire qui ne les propose pas.
    ...(formData.has("departmentId") ? { departmentId: fdStr(formData, "departmentId") } : {}),
    ...(formData.has("concernedUserId") ? { concernedUserId: fdStr(formData, "concernedUserId") } : {}),
    // Le dossier de classement, même précaution : présent seulement si le formulaire l'a proposé.
    ...(formData.has("folderId") ? { folderId: fdStr(formData, "folderId") } : {}),
  };
}

export async function createMailEntry(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-register-actions:createMailEntry", libelle: "Courrier enregistré" }, async () => {

    // LE NŒUD DU DRIVE EST VÉRIFIÉ AVANT D'ÊTRE ÉCRIT. L'identifiant vient d'un champ de
    // formulaire : sans contrôle, le registre pointerait vers un fichier corbeillé, inexistant,
    // ou qu'on n'a pas le droit de lire.
    const driveNodeId = fdStr(formData, "driveNodeId");
    if (driveNodeId) {
      const node = await prisma.driveNode.findUnique({ where: { id: driveNodeId }, select: { isTrashed: true } });
      if (!node || node.isTrashed) return { ok: false, error: "Le dossier / fichier choisi n'existe plus dans le Drive." };
      if (!canViewDrive(await resolveDriveAccess(user, driveNodeId))) {
        return { ok: false, error: "Vous n'avez pas accès à ce dossier / fichier du Drive." };
      }
    }

    const parties = await readParties(user.id, formData);
    if (!parties.ok) return { ok: false, error: parties.error };
    const r = await createMailEntryFor(user, {
      ...parties.data,
      ...readFields(formData),
      driveNodeId,
      sourceType: (fdStr(formData, "sourceType") as EntityType | null) ?? null,
      sourceId: fdStr(formData, "sourceId"),
    });
    if (!r.ok || !r.id) return r;

    // Les pièces jointes du formulaire, rattachées au courrier qui vient de naître. Un échec de
    // fichier ne défait PAS l'enregistrement : le pli est au registre, on dit ce qui n'a pas suivi.
    const files = await attachFormFiles(user.id, "MAIL_ENTRY", r.id, formData);
    revalidatePath("/courriers");
    return files.failed.length
      ? { ...r, message: `Courrier enregistré. ${files.attached} pièce(s) jointe(s) ; échec sur : ${files.failed.map((x) => x.name).join(", ")}.` }
      : r;
  });
}

/**
 * MODIFIER UN COURRIER — depuis sa fiche.
 *
 * L'identifiant est LIÉ côté serveur (`editMailEntry.bind(null, id)`), jamais lu dans le
 * formulaire : un champ caché se réécrit dans le navigateur, et l'on modifierait alors le
 * courrier de quelqu'un d'autre.
 */
export async function editMailEntry(
  id: string,
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-register-actions:editMailEntry", libelle: "Courrier modifié" }, async () => {
    const parties = await readParties(user.id, formData);
    if (!parties.ok) return { ok: false, error: parties.error };
    const r = await updateMailEntryFor(user, id, { ...readFields(formData), ...parties.data });
    if (r.ok) { revalidatePath("/courriers"); revalidatePath(`/courriers/${id}`); }
    return r;
  });
}

/**
 * POSER UNE DATE, depuis la ligne du tableau — l'arrivée et l'accusé se constatent des jours
 * après la saisie, et rouvrir un formulaire complet pour cocher une date, personne ne le fait.
 */
export async function setMailDate(input: {
  id: string; field: "receivedAt" | "acknowledgedAt"; value: string | null;
}): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-register-actions:setMailDate", libelle: "Date du courrier posée" }, async () => {
    const date = input.value ? new Date(input.value) : null;
    if (input.value && Number.isNaN(date!.getTime())) return { ok: false, error: "Date invalide." };

    const r = await setMailDateFor(user, { id: input.id, field: input.field, value: date });
    if (r.ok) { revalidatePath("/courriers"); revalidatePath(`/courriers/${input.id}`); }
    return r;
  });
}

export async function deleteMailEntry(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MAIL_REGISTER", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Courrier introuvable." };
  if (!(await canAccessEntity(user, "MAIL_ENTRY", id, "DELETE"))) {
    return { ok: false, error: "Ce courrier n'est pas dans votre périmètre." };
  }
  const entry = await prisma.mailEntry.findUnique({ where: { id }, select: { title: true } });
  if (!entry) return { ok: false, error: "Courrier introuvable." };

  // Les pièces jointes rattachées ne seraient plus atteignables par aucun écran : on les
  // détache avec le courrier, et on DIT combien il y en avait. Le fichier lui-même n'est pas
  // perdu — tout téléversement est répliqué dans le Drive de celui qui l'a importé — mais le
  // journal doit garder trace de ce qui a disparu de la fiche.
  const attached = await prisma.document.findMany({
    where: { entityType: "MAIL_ENTRY", entityId: id }, select: { id: true, fileKey: true },
  });
  await prisma.document.deleteMany({ where: { entityType: "MAIL_ENTRY", entityId: id } });
  // Les octets se libèrent avec la fiche, sans quoi le stockage garderait à vie des pièces que
  // plus aucun écran ne montre.
  for (const d of attached) if (d.fileKey) await deleteFileByKey(d.fileKey);
  await prisma.mailEntry.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Courriers",
    entityType: "MAIL_ENTRY", entityId: id,
    summary: `Courrier « ${entry.title} » supprimé${attached.length > 0 ? ` — ${attached.length} pièce(s) jointe(s)` : ""}`,
  });
  revalidatePath("/courriers");
  return { ok: true };
}

/**
 * CLASSER UN FICHIER DU DRIVE EN COURRIER — sans copie, comme « Déclarer dans Legal ».
 *
 * Le geste réel : le scan du pli est déjà dans le Drive ; on veut l'inscrire au carnet avec ce
 * que le Drive ne sait pas porter — l'objet, le sens (arrivée / départ), l'expéditeur, le
 * destinataire. Le fichier NE BOUGE PAS : le courrier le référence (`driveNodeId`), il continue
 * de se versionner dans le Drive et le carnet en montre toujours la version courante.
 */
export async function attachDriveNodeToMail(input: {
  driveNodeId: string; title?: string; direction?: string;
  sender?: string; recipient?: string; reference?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-register-actions:attachDriveNodeToMail", libelle: "Fichier du Drive classé en courrier" }, async () => {
    if (!userCan(user, "MAIL_REGISTER", "CREATE")) return { ok: false, error: "Non autorisé à alimenter les Courriers." };

    const node = await prisma.driveNode.findUnique({
      where: { id: input.driveNodeId },
      select: { id: true, name: true, type: true, isTrashed: true },
    });
    if (!node || node.isTrashed) return { ok: false, error: "Fichier introuvable dans le Drive." };
    if (node.type !== "FILE") return { ok: false, error: "Seul un fichier peut devenir un courrier." };
    if (!canViewDrive(await resolveDriveAccess(user, node.id))) {
      return { ok: false, error: "Vous n'avez pas accès à ce fichier du Drive." };
    }

    // Déjà au carnet : on ne crée pas un deuxième pli pour le même fichier — c'est exactement le
    // doublon que la référence sans copie sert à éviter.
    const already = await prisma.mailEntry.findFirst({ where: { driveNodeId: node.id }, select: { id: true } });
    if (already) return { ok: false, error: "Ce fichier figure déjà au carnet de courriers.", id: already.id };

    const direction: MailDirection = input.direction === "INCOMING" ? "INCOMING" : "OUTGOING";
    const created = await createMailEntryFor(user, {
      title: (input.title ?? "").trim() || node.name,
      direction,
      sender: input.sender?.trim() || null,
      recipient: input.recipient?.trim() || null,
      reference: input.reference?.trim() || null,
      driveNodeId: node.id,
      // Un pli qui arrive est déjà arrivé ; un pli qui part n'est pas encore parti — les dates de
      // trajet se posent ensuite depuis la ligne du carnet, comme pour toute saisie.
      receivedAt: direction === "INCOMING" ? new Date() : null,
    });
    if (created.ok) revalidatePath("/courriers");
    return created;
  });
}
