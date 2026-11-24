import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { createDirectValidation, notifyValidator, reprendreEtapesRenvoyees } from "@/lib/validation";
import { repriseApresCorrection } from "@/lib/validations/decision";
import { lienEtapeAValider } from "@/lib/chemins/validations";
import { getManagerOf } from "@/lib/departments";
import {
  circuitDuDepart, LIBELLE_MOTIF_DEPART, OBJET_DEPART_SALARIE, statutApresValidation, STATUTS_DEPART_OUVERTS,
  type MotifDepart,
} from "../domaine/depart/regles";
import { preparerLaSortie } from "./depart-sortie";
import { fermerSiEchu } from "./depart-cloture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FIN DE CONTRAT — LE CIRCUIT (lot rhdepart) : ouvrir, corriger et renvoyer, annuler, et la suite d'une décision.
 *
 * Le circuit est celui du MOTEUR COMMUN des validations (`ValidationRequest`, nature `DEPART_SALARIE`) : les valideurs
 * le voient dans le Centre de validations et dans « Aujourd'hui », la décision (valider, renvoyer, refuser — motif
 * exigé) y est la même que partout, le requérant est prévenu à chaque marche. Ce fichier ne refait aucun de ces gestes :
 * il ouvre la demande, la reprend après correction (depuis la fiche — une demande née d'un objet se corrige là-bas), et
 * fait suivre la fiche quand la décision tombe (`suiteDecisionDepart`, appelé par `decideValidation`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Echec = { ok: false; error: string };
export interface SaisieDepart { motif: MotifDepart; dateFin: Date; preavisJours: number | null; note: string | null }

const dateFr = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);

/** Ce que lisent les valideurs — aucun montant (le solde n'existe qu'après l'accord, et il est réservé aux RH). */
function descriptionPourLesValideurs(s: SaisieDepart, notes: string[]): string {
  return [
    `${LIBELLE_MOTIF_DEPART[s.motif]} — dernier jour travaillé le ${dateFr(s.dateFin)}${s.preavisJours != null ? ` · préavis de ${s.preavisJours} jour(s)` : ""}.`,
    s.note ? `Note des RH : ${s.note}` : null,
    ...notes,
    "Après l'accord de la Direction générale, la liste de sortie, le solde de tout compte et le certificat de travail se préparent sur la fiche.",
  ].filter(Boolean).join("\n");
}

/** Le DG qui tranche en dernier : un Directeur Général actif, sinon un Super Admin — jamais le salarié qui part. */
async function decideurFinal(exclus: readonly string[]): Promise<string | null> {
  for (const role of ["GENERAL_MANAGER", "SUPER_ADMIN"] as const) {
    const u = await prisma.user.findFirst({
      where: { role, isActive: true, isSystem: false, id: { notIn: [...exclus] } }, orderBy: { createdAt: "asc" }, select: { id: true },
    });
    if (u) return u.id;
  }
  return null;
}

/** Une fin de contrat vivante dont la demande a été retirée ailleurs (Centre de validations) est close d'abord. */
async function clorePerimees(employeeId: string): Promise<void> {
  const vivantes = await prisma.departSalarie.findMany({
    where: { employeeId, statut: { in: [...STATUTS_DEPART_OUVERTS] }, validationRequestId: { not: null } }, select: { id: true, validationRequestId: true },
  });
  for (const d of vivantes) {
    const v = await prisma.validationRequest.findUnique({ where: { id: d.validationRequestId! }, select: { status: true } });
    if (!v || v.status === "CANCELLED") await prisma.departSalarie.updateMany({ where: { id: d.id, statut: { in: ["EN_VALIDATION", "A_CORRIGER"] } }, data: { statut: "ANNULE" } });
  }
}

/**
 * OUVRIR LA FIN DE CONTRAT. La marche RH est acquise à l'ouverture (c'est la RH qui la porte) ; la demande part au N+1,
 * puis au DG. Une seule fin de contrat vivante par salarié : la fiche est verrouillée le temps de le vérifier.
 */
export async function ouvrirDepart(acteurId: string, employeeId: string, s: SaisieDepart): Promise<{ ok: true; id: string; message: string } | Echec> {
  const fiche = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, fullName: true, userId: true, isActive: true } });
  if (!fiche) return { ok: false, error: "Fiche salarié introuvable." };
  if (!fiche.isActive) return { ok: false, error: "Cette fiche est déjà inactive : il n'y a plus de contrat à terminer." };
  const manager = await getManagerOf(employeeId);
  const dgId = await decideurFinal([fiche.userId, acteurId].filter((x): x is string => !!x))
    ?? await decideurFinal([fiche.userId].filter((x): x is string => !!x));
  const circuit = circuitDuDepart({ rhId: acteurId, n1Id: manager?.userId ?? null, dgId, salarieUserId: fiche.userId });
  if (!circuit.ok) return { ok: false, error: circuit.refus };

  await clorePerimees(employeeId);
  const cree = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId} FOR UPDATE`;
    const vivante = await tx.departSalarie.findFirst({ where: { employeeId, statut: { in: [...STATUTS_DEPART_OUVERTS] } }, select: { id: true } });
    if (vivante) return null;
    return tx.departSalarie.create({
      data: { employeeId, motif: s.motif, dateFin: s.dateFin, preavisJours: s.preavisJours, note: s.note, ouvertParId: acteurId, statut: "EN_VALIDATION" },
      select: { id: true },
    });
  });
  if (!cree) return { ok: false, error: "Une fin de contrat est déjà en cours pour ce salarié : corrigez-la ou annulez-la depuis sa fiche." };

  const v = await createDirectValidation({
    requesterId: acteurId,
    title: `Fin de contrat — ${fiche.fullName}`,
    description: descriptionPourLesValideurs(s, circuit.notes),
    link: `/rh/${employeeId}#depart`,
    module: "Ressources humaines",
    objectType: OBJET_DEPART_SALARIE,
    entityType: "EMPLOYEE", entityId: employeeId,
    priority: "HIGH",
    validatorIds: circuit.etapes.map((e) => e.validatorId),
    // La RH qui ouvre EST la marche RH : elle figure au circuit (acquise ci-dessous), pas comme une auto-validation cachée.
    allowSelf: true,
  });
  if (!v.ok || !v.requestId) {
    await prisma.departSalarie.delete({ where: { id: cree.id } }).catch(sansBloquer("depart-circuit.ouvrirDepart.retrait"));
    return { ok: false, error: v.error ?? "La demande de validation n'a pas pu être créée : réessayez." };
  }
  const requestId = v.requestId;

  // LA MARCHE RH, ACQUISE À L'OUVERTURE. Le moteur venait de prévenir la RH « validation demandée » — pour sa propre
  // marche, déjà tranchée par ce geste : la notification est retirée, elle n'aurait rien à faire.
  const etapes = await prisma.validationStep.findMany({ where: { requestId }, orderBy: { order: "asc" }, select: { id: true, order: true, validatorId: true } });
  const rh = etapes[0];
  const suivante = etapes.find((e) => e.order === 2) ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.validationStep.update({ where: { id: rh.id }, data: { status: "APPROVED", decidedAt: new Date(), reason: "Fin de contrat ouverte par les RH." } });
    await tx.validationRequest.update({
      where: { id: requestId },
      data: suivante ? { currentOrder: 2 } : { status: "APPROVED", decidedAt: new Date() },
    });
    await tx.departSalarie.update({ where: { id: cree.id }, data: { validationRequestId: requestId } });
  });
  await prisma.notification.deleteMany({ where: { userId: acteurId, type: "VALIDATION_REQUIRED", link: lienEtapeAValider(rh.id) } }).catch(sansBloquer("depart-circuit.ouvrirDepart.notification"));
  if (suivante) {
    await notifyValidator(suivante.validatorId, { id: requestId, reference: v.reference ?? "", title: `Fin de contrat — ${fiche.fullName}` }, suivante.id);
  } else {
    await suiteDecisionDepart(requestId, "APPROVED", acteurId);
  }
  await recordAudit({
    actorId: acteurId, action: "CREATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: employeeId,
    field: "depart", newValue: s.motif,
    summary: `Fin de contrat ouverte pour ${fiche.fullName} — ${LIBELLE_MOTIF_DEPART[s.motif]}, dernier jour le ${dateFr(s.dateFin)} (${v.reference}, RH → ${circuit.etapes.slice(1).map((e) => e.libelle).join(" → ")})`,
  });
  return {
    ok: true, id: cree.id,
    message: `Fin de contrat ouverte (${v.reference}) : validation RH acquise, elle part ${suivante ? "au supérieur hiérarchique, puis à la Direction générale" : "à la Direction générale"}.${circuit.notes.length ? ` ${circuit.notes.join(" ")}` : ""}`,
  };
}

/** LA SUITE D'UNE DÉCISION FINALE — appelée par le moteur des validations quand une demande `DEPART_SALARIE` se clôt. */
export async function suiteDecisionDepart(requestId: string, statutValidation: string, acteurId: string): Promise<void> {
  const nouveau = statutApresValidation(statutValidation);
  if (!nouveau) return;
  const d = await prisma.departSalarie.findUnique({
    where: { validationRequestId: requestId },
    select: { id: true, employeeId: true, dateFin: true, ouvertParId: true, employee: { select: { fullName: true, userId: true } } },
  });
  if (!d) return;
  const ecrit = await prisma.departSalarie.updateMany({
    where: { id: d.id, statut: "EN_VALIDATION" },
    data: { statut: nouveau, ...(nouveau === "VALIDE" ? { valideLe: new Date() } : {}) },
  });
  if (ecrit.count === 0 || nouveau !== "VALIDE") return;

  // LA FIN DE CONTRAT EST ACQUISE : la date de fin passe sur la fiche, la liste de sortie, le solde et le certificat
  // naissent préremplis, et chacun est prévenu.
  await prisma.employee.update({ where: { id: d.employeeId }, data: { contractEnd: d.dateFin } });
  await preparerLaSortie(d.id, acteurId);
  const lien = `/rh/${d.employeeId}#depart`;
  const qui = d.employee.fullName;
  await notifyUser({
    userId: d.ouvertParId, type: "GENERIC", title: "Fin de contrat validée — la sortie est prête",
    body: `${qui} : dernier jour le ${dateFr(d.dateFin)}. Liste de sortie, solde de tout compte et certificat de travail préremplis sur la fiche.`, link: lien,
  }).catch(sansBloquer("depart-circuit.suiteDecisionDepart.rh"));
  const manager = await getManagerOf(d.employeeId);
  if (manager?.userId && manager.userId !== d.ouvertParId) {
    await notifyUser({
      userId: manager.userId, type: "GENERIC", title: `Départ de ${qui} validé`,
      body: `Dernier jour le ${dateFr(d.dateFin)}. Ses dossiers en cours vous seront transférés depuis la liste de sortie.`, link: "/mon-equipe",
    }).catch(sansBloquer("depart-circuit.suiteDecisionDepart.n1"));
  }
  if (d.employee.userId) {
    await notifyUser({
      userId: d.employee.userId, type: "GENERIC", title: "Votre départ est enregistré",
      body: `Dernier jour le ${dateFr(d.dateFin)}. Les RH vous remettront votre certificat de travail et votre solde de tout compte.`, link: "/mon-dossier",
    }).catch(sansBloquer("depart-circuit.suiteDecisionDepart.salarie"));
  }
  await fermerSiEchu(d.id);
}

/**
 * CORRIGER ET RENVOYER — une fin de contrat renvoyée pour correction se corrige sur la fiche, et la demande reprend À
 * L'ÉTAPE QUI L'A RENVOYÉE (règle commune, `repriseApresCorrection`) ; sa version monte, le fil garde le motif et la
 * correction.
 */
export async function corrigerDepart(acteurId: string, departId: string, s: SaisieDepart, ceQuiAChange: string): Promise<{ ok: true; message: string } | Echec> {
  const d = await prisma.departSalarie.findUnique({ where: { id: departId }, select: { id: true, statut: true, validationRequestId: true, employee: { select: { fullName: true } } } });
  if (!d || !d.validationRequestId) return { ok: false, error: "Fin de contrat introuvable." };
  if (d.statut !== "A_CORRIGER") return { ok: false, error: d.statut === "EN_VALIDATION" ? "Cette fin de contrat est en validation : elle ne se corrige que si un valideur la renvoie." : "Cette fin de contrat est close : elle ne se corrige plus." };
  const requestId = d.validationRequestId;
  const req = await prisma.validationRequest.findUnique({
    where: { id: requestId },
    select: { reference: true, title: true, mode: true, currentOrder: true, version: true, status: true, steps: { select: { id: true, order: true, status: true, reason: true, validatorId: true, validator: { select: { name: true } } } } },
  });
  if (!req || req.status !== "CHANGES_REQUESTED") return { ok: false, error: "La demande de validation n'attend plus de correction : rechargez la fiche." };
  const reprise = repriseApresCorrection({ mode: req.mode, currentOrder: req.currentOrder, steps: req.steps }, null, null);
  const version = req.version + 1;
  const histoire = [
    `Resoumise après correction — version ${version}.`,
    ...req.steps.filter((e) => e.status === "CHANGES_REQUESTED").map((e) => `Renvoyée par ${e.validator?.name ?? "le valideur"} : « ${e.reason ?? "sans motif"} ».`),
    `Ce qui a été corrigé : « ${ceQuiAChange} ».`,
  ].join("\n");
  const repartie = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ValidationRequest" WHERE id = ${requestId} FOR UPDATE`;
    const ecrite = await tx.validationRequest.updateMany({
      where: { id: requestId, status: "CHANGES_REQUESTED", version: req.version },
      data: { status: "PENDING", version, currentOrder: reprise.currentOrder, decidedAt: null, description: descriptionPourLesValideurs(s, []) },
    });
    if (ecrite.count === 0) return false;
    await reprendreEtapesRenvoyees(tx, { requestId, etapes: reprise.aRouvrir, auteurId: acteurId, histoire });
    await tx.departSalarie.update({ where: { id: departId }, data: { motif: s.motif, dateFin: s.dateFin, preavisJours: s.preavisJours, note: s.note, statut: "EN_VALIDATION" } });
    return true;
  });
  if (!repartie) return { ok: false, error: "Cette demande vient de changer : rechargez la fiche pour voir où elle en est." };
  for (const e of req.steps.filter((x) => reprise.aRouvrir.includes(x.id) && x.order === reprise.currentOrder)) {
    await notifyValidator(e.validatorId, { id: requestId, reference: req.reference, title: req.title }, e.id).catch(sansBloquer("depart-circuit.corrigerDepart.notifier"));
  }
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "VALIDATION_REQUEST", entityId: requestId,
    field: "version", newValue: String(version), summary: `${req.reference} — fin de contrat de ${d.employee.fullName} corrigée et renvoyée (version ${version}) : ${ceQuiAChange}`,
  });
  return { ok: true, message: `Fin de contrat corrigée (version ${version}) : elle reprend à l'étape qui l'avait renvoyée.` };
}

/**
 * ANNULER — tant que le compte n'est pas fermé. La demande de validation encore ouverte est close (son historique
 * reste), les valideurs qui l'attendaient sont prévenus ; une liste de sortie déjà née reste lisible, close.
 */
export async function annulerDepart(acteurId: string, departId: string, motif: string): Promise<{ ok: true; message: string } | Echec> {
  const d = await prisma.departSalarie.findUnique({ where: { id: departId }, select: { id: true, statut: true, compteFermeLe: true, validationRequestId: true, employeeId: true, employee: { select: { fullName: true } } } });
  if (!d) return { ok: false, error: "Fin de contrat introuvable." };
  if (d.compteFermeLe) return { ok: false, error: "Le départ est consommé (fiche et compte fermés) : une réembauche se fait par une nouvelle fiche ou par la réactivation de celle-ci." };
  const ecrit = await prisma.departSalarie.updateMany({ where: { id: departId, statut: { in: [...STATUTS_DEPART_OUVERTS] }, compteFermeLe: null }, data: { statut: "ANNULE" } });
  if (ecrit.count === 0) return { ok: false, error: "Cette fin de contrat est déjà close : rechargez la fiche." };
  if (d.validationRequestId) {
    const req = await prisma.validationRequest.findUnique({ where: { id: d.validationRequestId }, select: { reference: true, status: true, steps: { where: { status: "PENDING" }, select: { validatorId: true } } } });
    const close = await prisma.validationRequest.updateMany({ where: { id: d.validationRequestId, status: { in: ["PENDING", "CHANGES_REQUESTED"] } }, data: { status: "CANCELLED", decidedAt: new Date() } });
    if (close.count > 0 && req) {
      for (const s of req.steps) {
        if (s.validatorId === acteurId) continue;
        await notifyUser({ userId: s.validatorId, type: "GENERIC", title: "Validation retirée", body: `${req.reference} — fin de contrat de ${d.employee.fullName} annulée par les RH : il n'y a plus rien à trancher. Motif : « ${motif} ».`, link: `/validations/${d.validationRequestId}` })
          .catch(sansBloquer("depart-circuit.annulerDepart.notifier"));
      }
    }
  }
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "statut", oldValue: d.statut, newValue: "ANNULE", summary: `Fin de contrat de ${d.employee.fullName} annulée — ${motif}`,
  });
  return {
    ok: true,
    message: d.statut === "VALIDE"
      ? "Fin de contrat annulée : la date de fin reste sur la fiche — corrigez-la si le contrat continue."
      : "Fin de contrat annulée : les valideurs qui l'attendaient sont prévenus.",
  };
}
