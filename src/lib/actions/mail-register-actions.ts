"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import type { EntityType, MailDirection } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { deleteOwnRecord } from "@/lib/actions/admin-delete-actions";
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
 * les tient à jour à partir du contact choisi.
 *
 * TROIS CAS, ET UN SEUL EFFACE (audit Courrier, 24/11) :
 *  - un contact est posté → il devient l'expéditeur, son nom la valeur affichée ;
 *  - le sélecteur signale un VIDAGE VOLONTAIRE (`<champ>__vide`, posé quand on retire le contact)
 *    → le contact ET le nom affiché s'effacent ;
 *  - rien n'est posté → INCHANGÉ. Un sélecteur vide ne poste rien : c'est l'état ordinaire d'un pli
 *    enregistré en texte libre, et le lire comme un effacement vidait l'expéditeur de tout pli
 *    corrigé depuis sa fiche.
 * Le formulaire ne rend AUCUN champ texte : le nom libre (`sender` / `recipient`) n'arrive que
 * d'Adam, qui nomme sans choisir (comme l'API et la déclaration depuis le Drive). Il n'est lu que
 * si aucun contact n'est posté, et détache alors l'ancien contact, qui ne correspond plus au nom.
 */
async function readParties(userId: string, formData: FormData) {
  // Les noms de champs sont écrits EN TOUTES LETTRES (pas de clé calculée) : le contrat d'action
  // (`actions:contrat`) les lit dans la source pour décrire ce que l'action attend.
  const un = (key: string) => formData.getAll(key).map(String).filter(Boolean).slice(0, 1);
  const data: Partial<MailFields> = {};
  if (formData.has("senderContactId")) {
    const r = await resolveParties(userId, un("senderContactId"));
    if (!r.ok) return { ok: false as const, error: r.error };
    data.senderContactId = r.ids[0] ?? null;
    data.sender = r.text || null;
  } else if (formData.get("senderContactId__vide")) {
    data.senderContactId = null;
    data.sender = null;
  } else if (formData.has("sender")) {
    data.senderContactId = null;
    data.sender = fdStr(formData, "sender");
  }
  if (formData.has("recipientContactId")) {
    const r = await resolveParties(userId, un("recipientContactId"));
    if (!r.ok) return { ok: false as const, error: r.error };
    data.recipientContactId = r.ids[0] ?? null;
    data.recipient = r.text || null;
  } else if (formData.get("recipientContactId__vide")) {
    data.recipientContactId = null;
    data.recipient = null;
  } else if (formData.has("recipient")) {
    data.recipientContactId = null;
    data.recipient = fdStr(formData, "recipient");
  }
  return { ok: true as const, data };
}

/**
 * LE FORMULAIRE, CHAMP PAR CHAMP PRÉSENT — un champ que le formulaire ne porte pas reste `undefined`,
 * donc INCHANGÉ au noyau (`updateMailEntryFor` fusionne). L'écran poste tous ses champs ; Adam ne
 * poste que ce qu'il corrige ; un menu non rendu (aucun partenaire, aucun dossier) n'efface rien.
 */
function readFields(formData: FormData): Partial<MailFields> {
  const f: Partial<MailFields> = {};
  if (formData.has("title")) f.title = fdStr(formData, "title") ?? "";
  if (formData.has("reference")) f.reference = fdStr(formData, "reference");
  if (formData.has("direction")) f.direction = parseDirection(fdStr(formData, "direction"));
  // `sender` / `recipient` se lisent par `readParties` (contact d'annuaire, ou nom donné par Adam).
  if (formData.has("sentAt")) f.sentAt = fdDateTime(formData, "sentAt");
  if (formData.has("receivedAt")) f.receivedAt = fdDate(formData, "receivedAt");
  if (formData.has("acknowledgedAt")) f.acknowledgedAt = fdDate(formData, "acknowledgedAt");
  if (formData.has("carrier")) f.carrier = fdStr(formData, "carrier");
  if (formData.has("notes")) f.notes = fdStr(formData, "notes");
  // L'ENTITÉ absente laisse le noyau retomber sur l'entité actuelle, ou celle du créateur.
  if (formData.has("companyId")) f.companyId = fdStr(formData, "companyId");
  // Les menus ne sont rendus que s'il y a quelque chose à choisir : les lire inconditionnellement
  // effacerait le rattachement d'un pli à chaque enregistrement fait depuis un formulaire qui ne
  // les propose pas.
  if (formData.has("partnerId")) f.partnerId = fdStr(formData, "partnerId");
  if (formData.has("departmentId")) f.departmentId = fdStr(formData, "departmentId");
  if (formData.has("concernedUserId")) f.concernedUserId = fdStr(formData, "concernedUserId");
  if (formData.has("folderId")) f.folderId = fdStr(formData, "folderId");
  return f;
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
      title: "",
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

/**
 * RETIRER UN COURRIER DU REGISTRE — la MÊME suppression que la fiche : réversible, par la corbeille.
 *
 * Cette porte détruisait : la ligne, ses pièces jointes ET leurs fichiers, sans transaction, alors
 * que le bouton de la fiche mettait le même pli à la corbeille (`deleteOwnRecord`). Adam — qui
 * passe par ici — supprimait donc pour toujours ce que l'écran rangeait. Il n'y a plus qu'un geste,
 * avec un seul jeu de droits : le droit `DELETE` du registre ou la paternité du pli, et dans les
 * deux cas un pli que l'on voit encore (entité, module non bloqué).
 */
export async function deleteMailEntry(formData: FormData): Promise<ActionResult> {
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Courrier introuvable." };
  const fd = new FormData();
  fd.set("kind", "MAIL_ENTRY");
  fd.set("id", id);
  const r = await deleteOwnRecord(fd);
  if (!r.ok) return { ok: false, error: r.error ?? "La suppression a été refusée." };
  revalidatePath("/courriers");
  return { ok: true, message: "Courrier mis à la corbeille — l'administrateur peut le restaurer." };
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

    const direction: MailDirection = input.direction === "INCOMING" ? "INCOMING" : "OUTGOING";
    // DÉJÀ AU CARNET : on ne crée pas un deuxième pli pour le même fichier — c'est exactement le
    // doublon que la référence sans copie sert à éviter. Aucune contrainte d'unicité ne le garantit
    // (`driveNodeId` est aussi celui d'un pli saisi à la main) : deux déclarations simultanées
    // passaient toutes deux le contrôle. Un VERROU par fichier, tenu le temps du contrôle et de la
    // création, les sérialise — la seconde voit la première.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('courrier-drive'), hashtext(${node.id}))`;
      const already = await prisma.mailEntry.findFirst({ where: { driveNodeId: node.id }, select: { id: true } });
      if (already) return { ok: false, error: "Ce fichier figure déjà au carnet de courriers.", id: already.id } satisfies ActionResult;
      return createMailEntryFor(user, {
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
    }, { timeout: 20_000 });
    if (created.ok) revalidatePath("/courriers");
    return created;
  });
}
