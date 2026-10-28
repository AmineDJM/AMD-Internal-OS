"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type Module } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { apresModificationDeLaDemande } from "@/lib/workflow/engine";
import {
  canEditAdProRequest, isAdProDecided, editableField, describeChanges, PERIODE_DE_LA_DEMANDE,
  type NatureEditable,
} from "@/modules/ad-pro/partage";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { notifyRoles } from "@/lib/notify";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { ajusterVisaAuMontant, phraseGesteVisa } from "@/modules/ad-pro/api";
import { MODULE_DU_POLE, CHEMIN_LISTE_POLE, poleDe } from "@/lib/lecteurs/consulting";

/**
 * MODIFICATION D'UNE DEMANDE AD & PRO (sponsoring, prise en charge nationale/internationale).
 *
 * Le point d'entrée est unique pour les trois modules : la règle « ce qui a fondé une décision
 * ne se réécrit pas » ne doit exister qu'à un seul endroit. Ce qui varie d'un module à l'autre
 * (table, module RBAC, chemin, statut) tient dans la table `TARGETS` ci-dessous — ajouter un
 * type de demande, c'est ajouter une ligne, pas dupliquer la garde.
 *
 * Les décisions (montant accordé, statut, Direction Marketing, avis, motifs) ne passent JAMAIS par
 * ici : elles appartiennent au circuit, et la liste blanche de `ad-pro-edit.ts` les exclut.
 */

interface Target {
  module: Module;
  /**
   * Le module qui garde CETTE ligne, quand il dépend d'elle : un contrat de consulting se lit et se
   * corrige par le module de son PÔLE (Consulting ou RH, §118.150) — le juger sur « Consulting » en dur
   * refuserait aux RH la correction d'un contrat qu'elles suivent.
   */
  moduleDe?: (row: Record<string, unknown>) => Module;
  /** La liste où la ligne se montre, quand elle dépend d'elle (même raison). */
  listeDe?: (row: Record<string, unknown>) => string;
  /**
   * Le statut où la demande ATTEND encore sa décision et où sa porte au centre Ad & Pro suit le montant
   * (audit 360°, lot C4a) — pour la nature dont le visa EST la porte (le consulting). Les autres portent un
   * circuit : `apresModificationDeLaDemande` s'en charge — la demande « autre » comprise depuis le
   * 27/10/2026 (décision #17).
   */
  attendLeCentre?: (row: Record<string, unknown>) => boolean;
  path: string;
  /** Colonne portant le statut de la demande (pour décider si elle est tranchée). */
  statusField: "status" | "requestStatus";
  load: (id: string) => Promise<Record<string, unknown> | null>;
  save: (id: string, data: Record<string, unknown>) => Promise<unknown>;
}

const TARGETS: Record<NatureEditable, Target> = {
  SPONSORING: {
    module: "SPONSORING",
    path: "/sponsoring",
    statusField: "status",
    load: (id) => prisma.sponsoringRequest.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.sponsoringRequest.update({ where: { id }, data }),
  },
  CONGRESS_NATIONAL: {
    module: "CONGRESS_NATIONAL",
    path: "/congress-national",
    statusField: "requestStatus",
    load: (id) => prisma.congressNational.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.congressNational.update({ where: { id }, data }),
  },
  CONGRESS_INTERNATIONAL: {
    module: "CONGRESS_INTERNATIONAL",
    path: "/congress-international",
    statusField: "requestStatus",
    load: (id) => prisma.congressInternational.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.congressInternational.update({ where: { id }, data }),
  },
  PROMO_MATERIAL: {
    module: "PROMO_MATERIAL",
    path: "/promo-material",
    statusField: "status",
    load: (id) => prisma.promoMaterial.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.promoMaterial.update({ where: { id }, data }),
  },
  EVENT: {
    module: "EVENTS",
    path: "/events",
    // Un événement peut vivre SANS demande de financement : son statut de demande est alors
    // nul, et c'est le demandeur/la Direction qui gouverne la correction.
    statusField: "requestStatus",
    load: (id) => prisma.event.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    // L'ÉVÉNEMENT N'A PAS DE COLONNE « MODIFIÉ PAR » — les quatre autres tables, si. Écrire `updatedById`
    // ici faisait échouer CHAQUE correction de demande d'événement sur une erreur Prisma : le demandeur
    // ne pouvait jamais corriger la sienne (trouvé par le banc de §118.184). L'auteur est dans l'audit.
    save: (id, data) => {
      const sansAuteur = { ...data };
      delete sansAuteur.updatedById;
      return prisma.event.update({ where: { id }, data: sansAuteur });
    },
  },
  CONSULTING_CONTRACT: {
    module: "CONSULTING",
    moduleDe: (row) => MODULE_DU_POLE[poleDe(row.pole)],
    listeDe: (row) => CHEMIN_LISTE_POLE[poleDe(row.pole)],
    path: "/consulting",
    statusField: "status",
    // Côté RH, un contrat ne passe pas par le centre de la PROMOTION (§118.150).
    attendLeCentre: (row) => row.status === "AWAITING_VALIDATION" && poleDe(row.pole) === "AD_PRO",
    load: (id) => prisma.consultingContract.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.consultingContract.update({ where: { id }, data }),
  },
  AD_PRO_OTHER: {
    module: "AD_PRO_OTHER",
    path: "/ad-pro/autres",
    statusField: "status",
    // PLUS DE VISA DU CENTRE (27/10/2026) : la demande « autre » suit le circuit commun, et le DG valide le
    // TOTAL de ses postes au-dessus du seuil (`ad-pro/porte-dg.ts`), pas le montant demandé.
    load: (id) => prisma.adProOtherRequest.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
    save: (id, data) => prisma.adProOtherRequest.update({ where: { id }, data }),
  },
};

function isKind(v: string | null): v is NatureEditable {
  return v === "SPONSORING" || v === "CONGRESS_NATIONAL" || v === "CONGRESS_INTERNATIONAL" || v === "PROMO_MATERIAL" || v === "EVENT"
    || v === "CONSULTING_CONTRACT" || v === "AD_PRO_OTHER";
}

export async function updateAdProRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const kind = fdStr(formData, "kind");
  const id = fdStr(formData, "id");
  if (!isKind(kind) || !id) return { ok: false, error: "Paramètres manquants." };

  const target = TARGETS[kind];
  // Un module qui dépend de la ligne ne se juge qu'une fois la ligne lue — la porte de la fiche, juste
  // en dessous, est déjà celle de son pôle.
  if (!target.moduleDe && !userCan(user, target.module, "VIEW")) return { ok: false, error: "Non autorisé." };

  // LA PORTE DE LA FICHE, avant tout chargement (§118.184) : société, portée de ligne, parties
  // prenantes. Un identifiant ne suffit plus à corriger la demande d'une autre société — et hors de
  // cette porte, la demande est INTROUVABLE, la même phrase que son absence.
  if (!(await canAccessEntity(user, kind, id, "VIEW"))) return { ok: false, error: "Demande introuvable." };

  const before = await target.load(id);
  if (!before) return { ok: false, error: "Demande introuvable." };
  const moduleLigne = target.moduleDe ? target.moduleDe(before) : target.module;
  if (!userCan(user, moduleLigne, "VIEW")) return { ok: false, error: "Non autorisé." };

  const decided = isAdProDecided(kind, String(before[target.statusField] ?? ""), (before.circuitState as string | null | undefined) ?? null);
  const allowed = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user), canManage: userCan(user, moduleLigne, "VALIDATE") },
    { requesterId: (before.requesterId as string | null) ?? null, decided },
  );
  if (!allowed) {
    return {
      ok: false,
      error: decided
        ? "La décision est rendue : seule la Direction peut encore corriger cette demande."
        : "Vous n'avez pas le droit de modifier cette demande.",
    };
  }

  // On ne lit QUE les champs de la liste blanche, et seulement ceux réellement soumis : un
  // champ absent du formulaire n'est pas un effacement.
  const data: Record<string, unknown> = {};
  for (const [key, raw] of formData.entries()) {
    const field = editableField(kind, key);
    if (!field || typeof raw !== "string") continue;
    const v = raw.trim();
    if (field.type === "number") {
      if (!v) { data[key] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: `« ${field.label} » doit être un montant positif.` };
      data[key] = n;
    } else if (field.type === "date") {
      if (!v) { data[key] = null; continue; }
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { ok: false, error: `« ${field.label} » n'est pas une date valide.` };
      data[key] = d;
    } else {
      // UN MENU N'ACCEPTE QUE SES CHOIX — côté serveur aussi : une valeur forgée finissait en erreur de
      // base de données sur une colonne énumérée, au lieu d'un refus qui dit quoi faire.
      if (v && field.options && !field.options.some((o) => o.value === v)) {
        return { ok: false, error: `« ${field.label} » : choisissez une valeur de la liste.` };
      }
      data[key] = v || null;
    }
  }
  if (Object.keys(data).length === 0) return { ok: false, error: "Aucune modification." };

  // UN CHAMP OBLIGATOIRE NE SE VIDE PAS par une correction — la liste les DÉCLARE (`requis`), avec leur
  // refus : une demande sans intitulé n'est plus consultable nulle part, un contrat sans consultant
  // n'a plus deux parties.
  for (const [key, valeur] of Object.entries(data)) {
    const requis = editableField(kind, key)?.requis;
    if (requis && (valeur === null || valeur === "")) return { ok: false, error: requis };
  }
  // Les deux bouts d'une période se lisent ENSEMBLE : corriger la seule fin avant le début enregistrait
  // un contrat qui se termine avant d'avoir commencé.
  const periode = PERIODE_DE_LA_DEMANDE[kind];
  if (periode && (periode.debut in data || periode.fin in data)) {
    const debut = (periode.debut in data ? data[periode.debut] : before[periode.debut]) as Date | null;
    const fin = (periode.fin in data ? data[periode.fin] : before[periode.fin]) as Date | null;
    if (debut && fin && fin < debut) return { ok: false, error: "La date de fin ne peut pas précéder la date de début." };
  }

  const changes = describeChanges(kind, before, data);
  if (changes.length === 0) return { ok: true, id }; // rien n'a bougé — inutile d'écrire ni de tracer

  await target.save(id, { ...data, updatedById: user.id });
  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Ad & Pro",
    entityType: kind,
    entityId: id,
    summary: `Demande modifiée${decided ? " APRÈS DÉCISION" : ""} — ${changes.join(" · ")}`,
  });

  // UNE CORRECTION EN COURS DE CIRCUIT N'EST PLUS MUETTE (audit 360°, R15 — §118.186). Ceux qui ont
  // déjà donné un avis apprennent ce qui a changé, et une porte franchie sous le seuil que le
  // nouveau montant dépasse se rouvre. Le matériel promotionnel a son propre circuit : il n'est pas
  // concerné. Un échec ici ne défait pas la modification, déjà écrite et tracée.
  let porteRouverte: string | null = null;
  // LE VISA DU CENTRE SUIT LE MONTANT (audit 360°, lot C4a) — le consulting : sa porte est un visa, pas
  // une étape. Corrigé sous le seuil, la porte en attente se retire ; au-dessus
  // de ce qu'une autorisation couvrait, elle se rouvre ; un refus du centre reste (réexamen).
  let phraseCentre: string | null = null;
  if (target.attendLeCentre && "amount" in data && target.attendLeCentre(before)) {
    const montant = data.amount == null ? null : Number(data.amount);
    const visa = await ajusterVisaAuMontant(kind, id, montant);
    phraseCentre = phraseGesteVisa(visa.geste, visa.etat);
    if (visa.geste === "OUVERTE" || visa.geste === "ROUVERTE") {
      // Le CENTRE est prévenu, comme à la soumission : c'est lui qui a la main désormais.
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — montant corrigé au-dessus du seuil",
        body: `${String(before.reference ?? "")} — ${String(before.title ?? "")}`, link: lienLigneCentreAdPro(id),
      });
    }
  }
  if (kind !== "PROMO_MATERIAL" && kind !== "CONSULTING_CONTRACT") {
    porteRouverte = (await apresModificationDeLaDemande({
      viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
      entityType: kind, entityId: id, changes,
    }).catch((e) => { console.error("[ad-pro-edit] suite de la modification non appliquée", e); return { porteRouverte: null }; })).porteRouverte;
  }

  revalidatePath(target.listeDe ? target.listeDe(before) : target.path);
  revalidatePath(`${target.path}/${id}`);
  if (target.attendLeCentre) revalidatePath("/centre-ad-pro");
  return porteRouverte
    ? { ok: true, id, message: `Modification enregistrée — le montant dépasse désormais le seuil de « ${porteRouverte} » : la demande y retourne.` }
    : phraseCentre
      ? { ok: true, id, message: `Modification enregistrée — ${phraseCentre}` }
      : { ok: true, id };
}
