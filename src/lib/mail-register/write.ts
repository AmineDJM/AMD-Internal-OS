import type { EntityType, MailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { companyIdForNew, entitePermisePourFiche, getMyCompanies } from "@/lib/company";
import { chosenCompanyId } from "@/lib/company-access";
import { canAccessEntity } from "@/lib/entity-access";
import type { ActionResult } from "@/lib/actions/types";
import {
  diffMailEntry, diffMailAssignments, describeMailChanges, MAIL_TRACKED_FIELDS,
  type MailSnapshot, type MailLabelChange,
} from "./trace";
import { correctionSuivie, dossierAccepteLePli, origineInvalide } from "./regles";

/**
 * L'ÉCRITURE DU REGISTRE DES COURRIERS — le cœur, appelé par les DEUX portes.
 *
 * L'écran passe par une action serveur, l'API des agents par le registre d'opérations. Si chacun
 * réécrivait la mise à jour, les deux divergeraient : un contrôle ajouté d'un côté manquerait de
 * l'autre, et l'on ne s'en apercevrait qu'après. Il n'y a donc qu'UNE implémentation, et elle
 * reçoit explicitement l'utilisateur au nom de qui l'on agit — jamais la session courante.
 *
 * Les mêmes gardes s'appliquent des deux côtés : droit de module, périmètre d'entité, journal
 * champ par champ. Un agent n'a aucun raccourci ; il a juste une autre porte.
 */

export interface MailFields {
  title: string;
  reference?: string | null;
  direction?: MailDirection;
  /**
   * L'EXPÉDITEUR ET LE DESTINATAIRE, tels qu'ils s'AFFICHENT. Le formulaire ne les saisit plus :
   * ils sont DÉDUITS des contacts choisis dans l'annuaire (`senderContactId` /
   * `recipientContactId`). Ils restent dans les champs parce que la recherche, les exports et le
   * journal les lisent tels quels — et parce qu'Adam et l'import savent nommer sans choisir.
   */
  sender?: string | null;
  recipient?: string | null;
  /** Les contacts d'annuaire retenus. `null` = aucun ; `undefined` = le champ n'a pas été proposé. */
  senderContactId?: string | null;
  recipientContactId?: string | null;
  sentAt?: Date | null;
  receivedAt?: Date | null;
  acknowledgedAt?: Date | null;
  carrier?: string | null;
  notes?: string | null;
  sourceType?: EntityType | null;
  sourceId?: string | null;
  /**
   * Nœud du Drive RÉFÉRENCÉ par le courrier — jamais recopié. Le fichier continue de s'y
   * versionner et de s'y renommer, et le courrier en montre toujours la version courante.
   * Vérifié par l'appelant (droit de lecture, nœud vivant) : ce module écrit, il n'arbitre pas
   * les accès au Drive.
   */
  driveNodeId?: string | null;
  /**
   * ENTITÉ du courrier, CHOISIE et non déduite de la portée d'affichage.
   *
   * Vide OU absente retombe sur l'entité de la pièce, puis sur celle du créateur — voir
   * `chosenCompanyId`. Un menu laissé vide n'est pas le choix « aucune entité » : ce l'était,
   * et le pli naissait alors hors de toutes les vues cloisonnées, visible dans la liste et
   * introuvable sur sa fiche.
   */
  companyId?: string | null;
  /** Partenaire concerné (liste du module). `null` = aucun, ce qui est fréquent et normal. */
  partnerId?: string | null;
  /**
   * LA DIRECTION CONCERNÉE et LA PERSONNE CONCERNÉE — à qui ce pli s'adresse.
   *
   * Les deux se cumulent et sont indépendantes : un contrat vise « la Direction Générale » ET son
   * directeur, une convocation ne vise qu'une personne, une mise en demeure ne vise qu'un service.
   * `undefined` = la mise à jour n'en parle pas (elle ne les efface donc pas) ; `null` = on retire
   * explicitement le rattachement.
   */
  departmentId?: string | null;
  concernedUserId?: string | null;
  /**
   * LE DOSSIER DE CLASSEMENT. `undefined` = l'écriture n'en parle pas (elle ne déclasse donc
   * pas) ; `null` = on sort explicitement le pli de son dossier. Un dossier RANGE, il n'autorise
   * pas — il ne change rien au cloisonnement par entité.
   */
  folderId?: string | null;
}

/** Les colonnes suivies, lues telles quelles pour la comparaison avant/après. */
export const TRACKED_SELECT = Object.fromEntries(
  Object.keys(MAIL_TRACKED_FIELDS).map((f) => [f, true]),
) as Record<keyof typeof MAIL_TRACKED_FIELDS, true>;

/**
 * VÉRIFIE la direction et la personne CHOISIES, et rend leurs NOMS pour le journal.
 *
 * Les deux viennent de menus, donc de champs de formulaire qu'on peut réécrire dans le
 * navigateur. Sans contrôle, on rattacherait un pli à la direction d'une société qu'on n'a pas le
 * droit de voir — ou, plus banalement, la base refuserait la clé étrangère et l'assistante
 * lirait une erreur technique au lieu d'une phrase.
 */
async function resolveAssignments(
  user: SessionUser, f: Partial<MailFields>,
): Promise<{ ok: true; department: string; person: string } | { ok: false; error: string }> {
  let department = "";
  let person = "";
  if (f.departmentId) {
    const d = await prisma.department.findUnique({
      where: { id: f.departmentId }, select: { name: true, companyId: true },
    });
    if (!d) return { ok: false, error: "Cette direction n'existe plus." };
    // Une direction TRANSVERSE (sans entité) est ouverte à tous ; une direction rattachée à une
    // société ne l'est qu'à ceux qui voient cette société.
    if (d.companyId) {
      const mine = await getMyCompanies(user.id);
      if (!mine.some((c) => c.id === d.companyId)) {
        return { ok: false, error: "Cette direction n'est pas dans votre périmètre." };
      }
    }
    department = d.name;
  }
  if (f.concernedUserId) {
    const u = await prisma.user.findUnique({
      where: { id: f.concernedUserId }, select: { name: true, isActive: true },
    });
    if (!u || !u.isActive) return { ok: false, error: "Cette personne n'a plus de compte actif." };
    person = u.name;
  }
  return { ok: true, department, person };
}

/**
 * VÉRIFIE LE PARTENAIRE ET LE DOSSIER CHOISIS — et l'objet d'origine.
 *
 * Les trois viennent de menus ou de champs cachés, donc de valeurs qu'on peut réécrire dans le
 * navigateur (ou qu'un agent peut inventer). Sans contrôle, une valeur inconnue faisait lever la
 * clé étrangère — une page d'erreur au lieu d'une phrase — et un dossier d'une société qu'on ne
 * voit pas recevait le pli. `companyId` est l'entité FINALE du pli : un dossier d'une entité ne
 * range que les plis de cette entité (`dossierAccepteLePli`).
 */
async function verifierRattachements(
  user: SessionUser, f: Partial<MailFields>, companyId: string | null,
): Promise<string | null> {
  if (f.partnerId) {
    const p = await prisma.mailPartner.findUnique({ where: { id: f.partnerId }, select: { id: true } });
    if (!p) return "Ce partenaire n'existe plus — choisissez-en un autre dans la liste.";
  }
  if (f.folderId) {
    const d = await prisma.mailEntryFolder.findUnique({ where: { id: f.folderId }, select: { companyId: true } });
    // Un dossier d'une société qu'on ne voit pas est INTROUVABLE : on ne dit pas qu'il existe.
    if (!d || !(await entitePermisePourFiche(user.id, d.companyId))) return "Ce dossier de classement est introuvable.";
    if (!dossierAccepteLePli(d.companyId, companyId)) {
      return "Ce dossier de classement appartient à une autre entité que le courrier — choisissez un dossier de la même entité, ou un dossier commun.";
    }
  }
  return origineInvalide(f.sourceType, f.sourceId);
}

/**
 * Écrit au journal une ligne PAR CHAMP touché (ancienne → nouvelle valeur), plus la synthèse.
 * Les deux sont rattachées au courrier : sa fiche affiche son propre historique sans fouiller le
 * journal global.
 *
 * `extra` reçoit les changements DÉJÀ RÉSOLUS EN CLAIR (direction, personne concernée) : ils ne
 * peuvent pas être comparés sur les colonnes brutes sans écrire des identifiants au journal.
 */
export async function traceMailChanges(
  actorId: string, id: string, title: string, before: MailSnapshot, after: MailSnapshot,
  extra: readonly MailLabelChange[] = [],
) {
  const changes: MailLabelChange[] = [...diffMailEntry(before, after), ...extra];
  if (changes.length === 0) return changes;
  const summary = describeMailChanges(title, changes);
  for (const c of changes) {
    await recordAudit({
      actorId, action: "UPDATE", module: "Courriers",
      entityType: "MAIL_ENTRY", entityId: id,
      field: c.label, oldValue: c.before, newValue: c.after,
      summary,
    });
  }
  return changes;
}

/** Enregistrer un courrier. */
export async function createMailEntryFor(user: SessionUser, f: MailFields): Promise<ActionResult> {
  if (!userCan(user, "MAIL_REGISTER", "CREATE")) return { ok: false, error: "Non autorisé." };
  const title = (f.title ?? "").trim();
  if (!title) return { ok: false, error: "L'objet du courrier est obligatoire." };

  // L'ENTITÉ CHOISIE EST VÉRIFIÉE. Elle vient d'un menu, donc d'un champ de formulaire : sans
  // contrôle, on rangerait un pli dans une société qu'on n'a pas le droit de voir — et il y
  // disparaîtrait aussitôt de sa propre vue.
  if (f.companyId) {
    const mine = await getMyCompanies(user.id);
    if (!mine.some((c) => c.id === f.companyId)) {
      return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
    }
  }
  const assigned = await resolveAssignments(user, f);
  if (!assigned.ok) return { ok: false, error: assigned.error };
  // L'ENTITÉ FINALE, calculée une fois : le dossier choisi doit l'accepter.
  const companyId = chosenCompanyId(f.companyId, null, await companyIdForNew(user.id));
  const refus = await verifierRattachements(user, f, companyId);
  if (refus) return { ok: false, error: refus };

  const created = await prisma.mailEntry.create({
    data: {
      title,
      reference: f.reference ?? null,
      direction: f.direction ?? "OUTGOING",
      sender: f.sender ?? null,
      recipient: f.recipient ?? null,
      senderContactId: f.senderContactId ?? null,
      recipientContactId: f.recipientContactId ?? null,
      sentAt: f.sentAt ?? null,
      receivedAt: f.receivedAt ?? null,
      acknowledgedAt: f.acknowledgedAt ?? null,
      carrier: f.carrier ?? null,
      notes: f.notes ?? null,
      driveNodeId: f.driveNodeId ?? null,
      partnerId: f.partnerId ?? null,
      departmentId: f.departmentId ?? null,
      concernedUserId: f.concernedUserId ?? null,
      folderId: f.folderId ?? null,
      // UN MENU LAISSÉ VIDE N'EST PAS UN CHOIX. Sans ce repli, le pli naît sans entité :
      // la liste le montre (elle garde les non rattachés, exprès), sa fiche répond 404 et ses
      // pièces jointes sont refusées. C'est le défaut rapporté « j'enregistre, et 404 ».
      companyId,
      sourceType: f.sourceType ?? null,
      sourceId: f.sourceId ?? null,
      createdById: user.id, updatedById: user.id,
    },
    select: { id: true },
  });
  // Le résumé porte le DESTINATAIRE INTERNE quand il y en a un : c'est la question qu'on pose au
  // journal global (« qui devait traiter ce pli ? »), et l'y lire évite d'ouvrir la fiche.
  const addressee = [assigned.department, assigned.person].filter(Boolean).join(" · ");
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Courriers",
    entityType: "MAIL_ENTRY", entityId: created.id,
    summary: `Courrier ${(f.direction ?? "OUTGOING") === "INCOMING" ? "entrant" : "sortant"} « ${title} »${addressee ? ` — ${addressee}` : ""}`,
  });
  return { ok: true, id: created.id };
}

/**
 * Modifier un courrier — chaque champ touché part au journal avec ses deux valeurs.
 *
 * UNE CORRECTION FUSIONNE (`correctionSuivie`) : un champ `undefined` est INCHANGÉ, un champ
 * présent — même vide, c'est alors un effacement voulu — est écrit. Les trois portes en dépendent :
 * l'écran ne poste pas l'expéditeur quand aucun contact n'est choisi, Adam ne cite que ce qu'il
 * corrige, l'API n'envoie que les paramètres de l'appel. L'ancien `f.sender ?? null` effaçait en
 * silence tout ce que l'appelant n'avait pas répété.
 */
export async function updateMailEntryFor(user: SessionUser, id: string, f: Partial<MailFields>): Promise<ActionResult> {
  if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };
  if (!id) return { ok: false, error: "Courrier introuvable." };
  if (!(await canAccessEntity(user, "MAIL_ENTRY", id, "UPDATE"))) {
    return { ok: false, error: "Ce courrier n'est pas dans votre périmètre." };
  }
  const after = correctionSuivie(f);
  if (after.title !== undefined && !after.title) return { ok: false, error: "L'objet du courrier est obligatoire." };

  const before = await prisma.mailEntry.findUnique({
    where: { id },
    // Les rattachements sont relus par leur NOM, pas par leur identifiant : c'est ce nom qui part
    // au journal, et c'est lui qu'on compare.
    select: {
      ...TRACKED_SELECT,
      // L'ENTITÉ ACTUELLE est relue : elle est ce qu'on GARDE quand le menu revient vide.
      companyId: true, folderId: true,
      department: { select: { name: true } }, concernedUser: { select: { name: true } },
    },
  });
  if (!before) return { ok: false, error: "Courrier introuvable." };
  const title = after.title ?? before.title;

  // ENTITÉ ET PARTENAIRE se corrigent aussi — une erreur de saisie qui ne se rattrape pas
  // reste au registre pour toujours. Ils sont écrits À CÔTÉ de `after` : le journal suit des
  // champs LISIBLES, et y inscrire « cmt1es… → cmt2fk… » n'apprendrait rien à personne.
  if (f.companyId !== undefined && f.companyId) {
    const mine = await getMyCompanies(user.id);
    if (!mine.some((c) => c.id === f.companyId)) {
      return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
    }
  }
  const assigned = await resolveAssignments(user, f);
  if (!assigned.ok) return { ok: false, error: assigned.error };
  // CORRIGER UNE DATE NE DÉTACHE PAS LE PLI. Le menu d'entité revient vide dès qu'on n'y
  // touche pas ; l'écrire tel quel effaçait l'entité, et le courrier disparaissait de sa
  // propre vue au rechargement suivant — 404 sur la fiche qu'on venait de corriger.
  const companyId = chosenCompanyId(f.companyId, before.companyId, await companyIdForNew(user.id));
  // Le dossier vérifié est celui que le pli AURA : le nouveau s'il change, sinon l'actuel quand
  // c'est l'entité qui change (un pli de B ne reste pas dans un dossier de A).
  const dossierFinal = f.folderId !== undefined ? f.folderId : (companyId !== before.companyId ? before.folderId : null);
  const refus = await verifierRattachements(user, { ...f, folderId: dossierFinal }, companyId);
  if (refus) return { ok: false, error: refus };
  const links = {
    companyId,
    ...(f.partnerId !== undefined ? { partnerId: f.partnerId ?? null } : {}),
    ...(f.departmentId !== undefined ? { departmentId: f.departmentId ?? null } : {}),
    ...(f.concernedUserId !== undefined ? { concernedUserId: f.concernedUserId ?? null } : {}),
    // Le classement se corrige comme le reste ; il ne se journalise pas par son nom (un dossier
    // n'est pas une donnée métier du pli, c'est un rangement).
    ...(f.folderId !== undefined ? { folderId: f.folderId ?? null } : {}),
    // Les contacts d'annuaire, même précaution : `undefined` = le formulaire ne les proposait
    // pas (correction d'une date depuis le tableau), et l'on ne détache alors personne.
    ...(f.senderContactId !== undefined ? { senderContactId: f.senderContactId ?? null } : {}),
    ...(f.recipientContactId !== undefined ? { recipientContactId: f.recipientContactId ?? null } : {}),
  };
  // LA DIRECTION ET LA PERSONNE, ELLES, SE JOURNALISENT — mais par leur nom. Réorienter un pli de
  // la Direction Commerciale vers les Finances est exactement ce qu'on vient chercher dans ce
  // journal des mois plus tard, et c'est aussi ce qui explique qu'un dossier ait dormi.
  const moved = diffMailAssignments(
    { department: before.department?.name ?? "", person: before.concernedUser?.name ?? "" },
    {
      ...(f.departmentId !== undefined ? { department: assigned.department } : {}),
      ...(f.concernedUserId !== undefined ? { person: assigned.person } : {}),
    },
  );
  await prisma.mailEntry.update({ where: { id }, data: { ...after, ...links, updatedById: user.id } });
  const changes = await traceMailChanges(user.id, id, title, before, after, moved);
  return {
    ok: true,
    message: changes.length === 0 ? "Aucune modification." : `${changes.length} champ(s) modifié(s) — inscrit au journal.`,
  };
}

/**
 * Poser (ou effacer) une date d'arrivée / d'accusé.
 *
 * C'est le geste le plus fréquent du registre, et celui par lequel une date se CORRIGE : il est
 * journalisé exactement comme le formulaire complet.
 */
export async function setMailDateFor(
  user: SessionUser,
  input: { id: string; field: "receivedAt" | "acknowledgedAt"; value: Date | null },
): Promise<ActionResult> {
  if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };
  if (input.field !== "receivedAt" && input.field !== "acknowledgedAt") {
    return { ok: false, error: "Champ inconnu." };
  }
  if (!(await canAccessEntity(user, "MAIL_ENTRY", input.id, "UPDATE"))) {
    return { ok: false, error: "Ce courrier n'est pas dans votre périmètre." };
  }

  const before = await prisma.mailEntry.findUnique({ where: { id: input.id }, select: TRACKED_SELECT });
  if (!before) return { ok: false, error: "Courrier introuvable." };

  await prisma.mailEntry.update({
    where: { id: input.id },
    data: { [input.field]: input.value, updatedById: user.id },
  });
  await traceMailChanges(user.id, input.id, before.title, before, { [input.field]: input.value });
  return { ok: true };
}
