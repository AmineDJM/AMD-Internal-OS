"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan, rolesWithModule, estPrete } from "@/lib/rbac";
import { MODULE_LABELS } from "@/lib/labels";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { entitePermisePourFiche } from "@/lib/company";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { detenteurPourInterim } from "@/lib/hr/stand-in-resolve";
import { LIEN_INTERIMAIRES_A_VALIDER, LIEN_MES_CONGES } from "@/lib/chemins/rh";
import {
  normalizeDelegated, delegationsFor, modulesNonPretes, congeTermine, annonceDeValidation, STAND_IN_LABEL,
} from "@/lib/hr/stand-in";

/**
 * L'INTÉRIMAIRE D'UN CONGÉ — désigné par l'absent, validé par les RH.
 *
 * Deux gestes, deux personnes, et c'est ce partage qui rend la délégation acceptable : l'absent
 * SAIT qui peut le remplacer sur son métier, les RH VÉRIFIENT que ce n'est pas un remplaçant de
 * complaisance. Ni l'un ni l'autre ne suffit seul.
 *
 * Les règles (fenêtre d'activité, modules délégables, bornes des droits) vivent dans le module
 * pur `lib/hr/stand-in.ts` ; ici on lit le formulaire, on vérifie qui parle, on écrit.
 *
 * CE QUI SE PRÊTE, ET QUI LE VALIDE (§118.196, lot E4 — audit 360°, M13). Ce que la délégation
 * transmet se lit sur ce que l'absent DÉTIENT (`detenteurPourInterim`), jamais sur la matrice de son
 * rôle : un module bloqué, un accès personnalisé plus étroit, un module retiré ne se prêtent pas, et
 * l'action refuse ce que l'écran ne propose pas. Le partage « deux personnes » n'était qu'une phrase :
 * des RH en congé proposaient ET validaient leur propre intérimaire, un intérimaire des RH validait sa
 * propre désignation, et la RH d'une société validait, par l'identifiant, l'intérim d'un salarié d'une
 * autre — la liste, elle, était bornée à la société. Enfin un droit RH qui ne tient qu'à un intérim ne
 * désigne ni ne valide d'intérim : un droit prêté ne s'accorde pas à son tour (`estPrete`).
 */

const libelle = (m: string) => `« ${MODULE_LABELS[m as keyof typeof MODULE_LABELS] ?? m} »`;

/** « « Stocks PCH » ne serait pas prêté » — ou au pluriel, avec les mots qui s'accordent. */
function nonPretes(ms: readonly string[]): { phrase: string; ce: string; le: string } {
  const pluriel = ms.length > 1;
  return {
    phrase: `${ms.map(libelle).join(", ")} ne ${pluriel ? "seraient pas prêtés" : "serait pas prêté"}`,
    ce: pluriel ? "ces modules" : "ce module",
    le: pluriel ? "les" : "le",
  };
}

/** L'absent désigne (ou change) son intérimaire, et choisit ce qu'il délègue. */
export async function proposeStandIn(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande de congé introuvable." };

  const leave = await prisma.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true, status: true, endDate: true,
      employee: { select: { fullName: true, userId: true, companyId: true } },
    },
  });
  if (!leave) return { ok: false, error: "Demande de congé introuvable." };

  // C'est SA demande. Les RH peuvent aussi désigner pour quelqu'un — cela arrive quand l'absence
  // est déjà commencée et que la personne n'y a pas pensé. Les RH EN TITRE : un droit RH prêté par un
  // intérim ne désigne pas d'intérimaire pour les autres. Et dans la société de la fiche : la liste
  // des congés l'est, l'action ne touche pas par l'identifiant au congé d'une autre société.
  const isOwner = leave.employee.userId === user.id;
  if (!isOwner) {
    if (!userCan(user, "HR_REQUESTS", "UPDATE") || estPrete(user, "HR_REQUESTS", "UPDATE")) {
      return { ok: false, error: "Seule la personne absente (ou les ressources humaines) désigne son intérimaire." };
    }
    if (!(await entitePermisePourFiche(user.id, leave.employee.companyId))) {
      return { ok: false, error: "Demande de congé introuvable." };
    }
  }
  if (leave.status === "REJECTED" || leave.status === "CANCELLED") {
    return { ok: false, error: "Ce congé n'est plus en cours." };
  }

  const standInId = fdStr(formData, "standInId");
  // RETIRER l'intérimaire est un geste légitime : on change d'avis, ou le remplaçant part aussi.
  if (standInId === null) {
    const retrait = await prisma.leaveRequest.updateMany({
      where: { id, status: { notIn: ["REJECTED", "CANCELLED"] } },
      data: { standInId: null, standInStatus: null, standInModules: [], standInDecidedAt: null, standInDecidedById: null, standInNote: null },
    });
    if (retrait.count === 0) return { ok: false, error: "Ce congé vient d'être annulé ou refusé — rechargez la page." };
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "RH", entityType: "LEAVE_REQUEST", entityId: id,
      summary: `Congé de ${leave.employee.fullName} — intérimaire retiré`,
    });
    revalidatePath("/rh/conges");
    revalidatePath("/mon-espace");
    revalidatePath("/mon-dossier");
    // Un intérim en cours qui se retire change les DROITS de l'intérimaire.
    revalidatePath("/", "layout");
    return { ok: true, message: "Intérimaire retiré." };
  }

  // UN CONGÉ TERMINÉ n'a plus de place à tenir : la liste ne propose plus d'y désigner quelqu'un.
  if (congeTermine(leave.endDate)) {
    return { ok: false, error: "Ce congé est terminé : il n'y a plus de place à tenir." };
  }
  // ON NE SE REMPLACE PAS SOI-MÊME : la situation naît d'un clic malheureux, et ferait passer
  // une auto-validation pour un intérim.
  if (standInId === leave.employee.userId) {
    return { ok: false, error: "On ne peut pas se désigner soi-même comme intérimaire." };
  }
  const candidate = await prisma.user.findUnique({ where: { id: standInId }, select: { name: true, isActive: true } });
  if (!candidate || !candidate.isActive) return { ok: false, error: "Cette personne n'a plus de compte actif." };

  // CE QUE L'ABSENT DÉTIENT — la seule source de ce qui se prête (§118.196).
  const absent = leave.employee.userId ? await detenteurPourInterim(leave.employee.userId) : null;
  if (!absent) {
    return { ok: false, error: `${leave.employee.fullName} n'a pas de compte actif sur la plateforme : il n'y a rien à déléguer.` };
  }
  const modules = normalizeDelegated(formData.getAll("modules").map(String));
  if (modules.length === 0) {
    return { ok: false, error: "Choisissez au moins un module à déléguer — sinon l'intérimaire n'aurait rien à faire." };
  }
  const refuses = modulesNonPretes(absent, modules);
  if (refuses.length > 0) {
    const n = nonPretes(refuses);
    const qui = isOwner ? `vous ne détenez pas ${n.ce}` : `${leave.employee.fullName} ne détient pas ${n.ce}`;
    return {
      ok: false,
      error: `${n.phrase} : ${qui} — un intérimaire ne reçoit que ce que la personne absente a elle-même. Retirez-${n.le} de la sélection.`,
    };
  }

  const ecrit = await prisma.leaveRequest.updateMany({
    where: { id, status: { notIn: ["REJECTED", "CANCELLED"] } },
    data: {
      standInId,
      // Toute nouvelle désignation REPART en attente des RH : changer de remplaçant après
      // validation ne doit pas hériter de l'accord donné pour quelqu'un d'autre.
      standInStatus: "PENDING",
      standInModules: modules,
      standInDecidedAt: null, standInDecidedById: null, standInNote: null,
    },
  });
  if (ecrit.count === 0) return { ok: false, error: "Ce congé vient d'être annulé ou refusé — rechargez la page." };
  await notifyRoles(rolesWithModule("HR_REQUESTS", "UPDATE"), {
    type: "GENERIC",
    title: "Intérimaire à valider",
    body: `${leave.employee.fullName} propose ${candidate.name} pendant son congé (${modules.map((m) => MODULE_LABELS[m]).join(", ")}).`,
    link: LIEN_INTERIMAIRES_A_VALIDER,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH", entityType: "LEAVE_REQUEST", entityId: id,
    field: "Intérimaire", newValue: candidate.name,
    summary: `Congé de ${leave.employee.fullName} — ${candidate.name} proposé comme intérimaire (${modules.map((m) => MODULE_LABELS[m]).join(", ")})`,
  });
  revalidatePath("/rh/conges");
  revalidatePath("/mon-espace");
  revalidatePath("/mon-dossier");
  // Une désignation qui remplace un intérim validé le remet en attente : les droits changent.
  revalidatePath("/", "layout");
  return { ok: true, message: "Intérimaire proposé — en attente de validation des RH." };
}

/** Les RH tranchent : l'intérimaire est validé, ou refusé avec un motif. */
export async function decideStandIn(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) {
    return { ok: false, error: "La validation d'un intérimaire appartient aux ressources humaines." };
  }
  // UN DROIT PRÊTÉ NE S'ACCORDE PAS À SON TOUR (§118.196) : valider un intérim, c'est prêter des
  // droits — l'intérimaire des RH ne le fait pas au nom de la personne qu'il remplace.
  if (estPrete(user, "HR_REQUESTS", "UPDATE")) {
    return {
      ok: false,
      error: "Vous tenez les ressources humaines par intérim : valider un intérimaire reste aux RH en titre — un droit prêté ne se prête pas à son tour.",
    };
  }
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande de congé introuvable." };

  const leave = await prisma.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true, status: true, startDate: true, endDate: true,
      standInId: true, standInStatus: true, standInModules: true,
      employee: { select: { fullName: true, companyId: true, user: { select: { id: true } } } },
    },
  });
  // LA PORTE DE LA FICHE : la liste « Intérimaires à valider » est bornée à la société, l'action aussi.
  if (!leave || !(await entitePermisePourFiche(user.id, leave.employee.companyId))) {
    return { ok: false, error: "Demande de congé introuvable." };
  }
  if (!leave.standInId) return { ok: false, error: "Aucun intérimaire n'est proposé sur ce congé." };
  // DEUX PERSONNES, VRAIMENT : ni l'absent, ni l'intérimaire ne valident l'intérim qui les lie.
  const absentId = leave.employee.user?.id ?? null;
  if (user.id === absentId) {
    return { ok: false, error: "On ne valide pas l'intérimaire de son propre congé : un autre membre des RH le fait." };
  }
  if (user.id === leave.standInId) {
    return { ok: false, error: "On ne valide pas sa propre désignation comme intérimaire : un autre membre des RH le fait." };
  }
  if (leave.standInStatus !== "PENDING") {
    return {
      ok: false,
      error: `Cet intérimaire a déjà été ${leave.standInStatus === "APPROVED" ? "validé" : "refusé"} — rechargez la page. Pour mettre fin à un intérim, retirez l'intérimaire du congé.`,
    };
  }
  if (leave.status === "REJECTED" || leave.status === "CANCELLED") {
    return { ok: false, error: "Ce congé n'est plus en cours." };
  }
  if (congeTermine(leave.endDate)) {
    return { ok: false, error: "Ce congé est terminé : il n'y a plus de place à tenir." };
  }
  // UNE DÉCISION ILLISIBLE N'EST PAS UN ACCORD : toute valeur autre que « REJECTED » validait. Absente,
  // elle est refusée de même — et la garde `!decision` le DIT au contrat d'action (champ obligatoire).
  const decision = fdStr(formData, "decision");
  if (!decision || (decision !== "APPROVED" && decision !== "REJECTED")) {
    return { ok: false, error: "Décision illisible : choisissez « Valider » ou « Refuser »." };
  }
  const approve = decision === "APPROVED";
  const note = fdStr(formData, "note");
  if (!approve && note === null) {
    return { ok: false, error: "Un refus se motive : la personne absente doit savoir quoi proposer d'autre." };
  }

  // CE QUE LA DÉLÉGATION TRANSMETTRA — lu sur ce que l'absent DÉTIENT, jamais sur la matrice de son
  // rôle. Valider un intérim vide, ou qui ne transmettrait pas tout ce qui a été choisi, laisserait
  // tout le monde croire que la place est tenue.
  let pretes: string[] = [];
  if (approve) {
    const absent = absentId ? await detenteurPourInterim(absentId) : null;
    if (!absent) {
      return { ok: false, error: `${leave.employee.fullName} n'a pas de compte actif sur la plateforme : un intérim ne transmettrait rien.` };
    }
    if (leave.standInModules.length === 0) {
      return {
        ok: false,
        error: `Aucun module n'a été choisi : ${leave.employee.fullName} doit encore dire ce que l'intérimaire reprend (Mon dossier RH › Mes congés et absences › Intérimaire).`,
      };
    }
    const refuses = modulesNonPretes(absent, leave.standInModules);
    if (refuses.length > 0) {
      const n = nonPretes(refuses);
      return {
        ok: false,
        error: `${n.phrase} : ${leave.employee.fullName} ne détient pas ${n.ce}. Demandez-lui de ${n.le} retirer de sa sélection (Mon dossier RH › Mes congés et absences), ou refusez en le disant.`,
      };
    }
    pretes = delegationsFor(absent, leave.standInModules).map((d) => MODULE_LABELS[d.module]);
  }

  // UNE DÉCISION PORTE SUR CE QU'ELLE A VU : l'intérimaire, ses modules et l'état lus. Si l'absent a
  // changé d'intérimaire entre-temps, on ne valide pas une personne que les RH n'ont pas vue.
  const ecrit = await prisma.leaveRequest.updateMany({
    where: {
      id, standInId: leave.standInId, standInStatus: "PENDING",
      standInModules: { equals: leave.standInModules },
      status: { notIn: ["REJECTED", "CANCELLED"] },
    },
    data: {
      standInStatus: approve ? "APPROVED" : "REJECTED",
      standInDecidedById: user.id, standInDecidedAt: new Date(), standInNote: note,
    },
  });
  if (ecrit.count === 0) {
    return { ok: false, error: "Cet intérim vient d'être modifié ou tranché par quelqu'un d'autre — rechargez la page." };
  }

  await notifyUser({
    userId: leave.standInId, type: "GENERIC",
    title: approve ? "Vous êtes intérimaire" : "Intérim refusé",
    body: approve
      ? annonceDeValidation(
          leave.employee.fullName,
          { leaveApproved: leave.status === "APPROVED", startDate: leave.startDate, endDate: leave.endDate },
          pretes,
        )
      : `Les RH n'ont pas retenu votre désignation comme intérimaire de ${leave.employee.fullName}${note ? ` — ${note}` : ""}.`,
    // Là où les décisions de l'absent sont RÉUNIES (§118.185) — « /validations » n'en montrait qu'une
    // partie. Un refus, lui, ne mène nulle part : il n'y a rien à faire.
    ...(approve ? { link: "/mon-espace" } : {}),
  });
  if (absentId) {
    await notifyUser({
      userId: absentId, type: "GENERIC",
      title: STAND_IN_LABEL[approve ? "APPROVED" : "REJECTED"],
      body: note || (approve ? "Votre intérimaire pourra agir pendant votre congé." : ""),
      // L'intérim se règle sur SON congé, dans « Mon dossier RH » — un refus s'y corrige.
      link: LIEN_MES_CONGES,
    });
  }
  await recordAudit({
    actorId: user.id, action: approve ? "VALIDATE" : "REFUSE", module: "RH",
    entityType: "LEAVE_REQUEST", entityId: id,
    field: "Intérimaire", newValue: approve ? "APPROVED" : "REJECTED",
    summary: `Congé de ${leave.employee.fullName} — intérimaire ${approve ? "validé" : "refusé"}${note ? ` · ${note}` : ""}`,
  });
  revalidatePath("/rh/conges");
  revalidatePath("/mon-espace");
  revalidatePath("/mon-dossier");
  // La délégation change les DROITS de l'intérimaire : sa navigation doit être recalculée.
  revalidatePath("/", "layout");
  return { ok: true, message: approve ? "Intérimaire validé." : "Intérimaire refusé." };
}
