"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { recordAudit } from "@/lib/audit";
import { buildRef, createWithRetry } from "@/lib/refs";
import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { submitDocumentRequest } from "@/lib/actions/document-request-actions";
import { createCareQuote } from "@/lib/actions/care-actions";
import { montantLisible, TAUX_USD_DZD_DEFAUT } from "@/lib/care-fiches";
import {
  chargerFiche, chargerFiches, cleFiche, colonneFiche, ficheDeLaDemande, MODULE_OPERATION, type FicheReservation,
} from "@/lib/reservation-fiche/fiches";
import {
  assurerMembre, assurerSujet, destinatairesAssistante, lienBureau, ligneFiche, noterAuFil, prevenir,
} from "@/lib/reservation-fiche/serveur";
import {
  diffEmpreintes, etatApres, etatFiche, etatLu, fichesAEnvoyer, gestePossible, lireEmpreinte, phraseChangements,
  refusGeste, refusRelance, NATURE_LIBELLE, REFUS_AVANT_ACCORD,
  type EtatDemande, type SourceFiche,
} from "@/lib/reservation-fiche/etat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE CHEZ L'ASSISTANTE DE DIRECTION — les gestes (Direction, 14/10/2026).
 *
 * Côté DEMANDEUR : envoyer UNE fiche (billet ou hôtel), « Envoyer les fiches prêtes » (un raccourci qui
 * appelle la même logique fiche par fiche), relancer (une fois par 24 h), retirer. Côté ASSISTANTE (rôle
 * principal ou secondaire, et le Super Admin) : prendre, signaler un manque, joindre le devis de l'agence
 * (par le circuit devis EXISTANT du poste), déposer le billet / la confirmation d'hôtel — après l'accord.
 *
 * Chaque écriture d'état est CONDITIONNELLE sur l'état lu : deux clics font un seul envoi, et deux
 * assistantes qui prennent la même fiche au même instant ne la prennent pas deux fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SOURCES: readonly SourceFiche[] = ["VOYAGEUR", "HEBERGEMENT", "CARE_CELL"];
const lireSource = (v: string | null): SourceFiche | null => (SOURCES as readonly string[]).includes(v ?? "") ? (v as SourceFiche) : null;

/** Qui TRAITE les fiches : l'assistante de direction (rôle principal ou secondaire) et le Super Admin. */
function peutTraiter(user: SessionUser): boolean {
  return hasRole(user, "DIRECTION_ASSISTANT") || user.role === "SUPER_ADMIN";
}

/**
 * Qui ENVOIE, relance, retire : celui qui décrit les postes de l'opération (la porte de `canEditItems` / `canEdit`
 * des prises en charge), sur une opération qu'il voit. La même porte que le bouton d'avant.
 */
async function peutDemander(user: SessionUser, f: FicheReservation): Promise<boolean> {
  const m = MODULE_OPERATION[f.operation.type];
  if (!m) return false;
  const edite = userCan(user, m, "CREATE") || userCan(user, m, "UPDATE") || hasGlobalView(user);
  if (!edite) return false;
  return canAccessEntity(user, f.operation.type, f.operation.id, f.source === "CARE_CELL" ? "UPDATE" : "VIEW");
}

function revalider(f: FicheReservation) {
  revalidatePath(f.operation.chemin);
  revalidatePath(f.operation.chemin.replace(/\/[^/]+$/, ""));
  revalidatePath("/demandes");
  if (f.sujetId) revalidatePath(`/dossiers/${f.sujetId}`);
}

async function auditer(user: SessionUser, f: FicheReservation, summary: string) {
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_OPERATION[f.operation.type] ?? f.operation.type,
    entityType: f.operation.type, entityId: f.operation.id, summary,
  }).catch(() => undefined);
}

/** Une demande et sa fiche, lues ensemble. */
async function chargerDemande(id: string) {
  const d = await prisma.demandeReservation.findUnique({ where: { id } });
  if (!d) return null;
  const ref = ficheDeLaDemande(d);
  const f = ref ? await chargerFiche(ref.source, ref.id) : null;
  return f ? { d, f } : null;
}

const prenom = (nom: string | null | undefined) => (nom ?? "").trim().split(/\s+/)[0] || "l'assistante";

// ───────────────────────────── Côté demandeur ─────────────────────────────

/**
 * ENVOYER UNE FICHE (ou la renvoyer : complétée après un manque, mise à jour après une modification, ou
 * reprise après un retrait). Tout ce qui refuse passe avant l'écriture (§118.18) : fiche refusée, il manque
 * quelque chose, déjà chez l'assistante, aucune assistante active.
 */
async function envoyerUne(user: SessionUser, source: SourceFiche, ficheId: string): Promise<ActionResult> {
  const f = await chargerFiche(source, ficheId);
  if (!f || !(await peutDemander(user, f))) return { ok: false, error: "Fiche introuvable." };
  if (f.refus) return { ok: false, error: f.refus };
  if (f.manques.length > 0) return { ok: false, error: `Fiche incomplète — il manque : ${f.manques.join(", ")}.` };

  const existante = await prisma.demandeReservation.findUnique({ where: colonneFiche(source, ficheId) as Prisma.DemandeReservationWhereUniqueInput });
  const lu = existante ? etatLu({ etat: existante.etat as EtatDemande, empreinte: lireEmpreinte(existante.empreinte) }, f.empreinte) : null;
  const refus = refusGeste("ENVOYER", lu);
  if (refus) return { ok: false, error: refus };

  const sujet = await assurerSujet(f, user.id);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  const maintenant = new Date();
  const empreinte = f.empreinte as Prisma.InputJsonValue;

  let demandeId: string;
  let phrase: string;
  if (!existante) {
    try {
      const cree = await prisma.demandeReservation.create({
        data: {
          ...colonneFiche(source, ficheId), nature: f.nature, itemId: f.itemId, careBeneficiaryId: f.careBeneficiaryId,
          operationType: f.operation.type, operationId: f.operation.id, companyId: f.operation.companyId, dossierId: sujet.id,
          etat: "ENVOYEE", demandeurId: user.id, envoyeeLe: maintenant, premierEnvoiLe: maintenant, empreinte,
        },
        select: { id: true },
      });
      demandeId = cree.id;
    } catch (e) {
      // DEUX CLICS, UN ENVOI : la fiche porte au plus une demande (unicité en base).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { ok: false, error: "Cette fiche vient d'être envoyée : elle est déjà chez l'assistante." };
      }
      throw e;
    }
    phrase = `Fiche envoyée — ${ligneFiche(f)}.`;
  } else {
    const avant = lireEmpreinte(existante.empreinte);
    const changements = avant ? diffEmpreintes(avant, f.empreinte) : [];
    const w = await prisma.demandeReservation.updateMany({
      // CONDITIONNELLE : l'état ET le compteur d'envois lus — deux renvois simultanés n'en font qu'un.
      where: { id: existante.id, etat: existante.etat, envois: existante.envois },
      data: {
        etat: etatApres("ENVOYER", existante.etat === "RETIREE" ? { priseParId: null } : existante),
        envoyeeLe: maintenant, envois: { increment: 1 }, empreinte, demandeurId: user.id, dossierId: sujet.id,
        manqueMotif: null, manqueLe: null, manqueParId: null, modifieeLe: null, retireeLe: null, retraitMotif: null,
        ...(existante.etat === "RETIREE" ? { priseParId: null, priseLe: null, devisRecuLe: null } : {}),
      },
    });
    if (w.count === 0) return { ok: false, error: "Cette fiche vient de changer d'état : rouvrez-la." };
    demandeId = existante.id;
    phrase = lu === "MANQUE_SIGNALE"
      ? `Fiche complétée et renvoyée — ${ligneFiche(f)}.`
      : lu === "MODIFIEE_APRES_ENVOI"
        ? `Fiche renvoyée (mise à jour) — ${ligneFiche(f)}.${changements.length ? ` Ce qui a changé : ${phraseChangements(changements)}.` : ""}`
        : `Fiche renvoyée — ${ligneFiche(f)}.`;
  }

  await noterAuFil(sujet.id, user.id, phrase);
  const dest = await destinatairesAssistante(existante && existante.etat !== "RETIREE" ? existante : { priseParId: null });
  await prevenir(dest, { title: "Fiche de voyage à réserver", body: phrase.slice(0, 240), link: lienBureau(demandeId) }, user.id);
  await auditer(user, f, `${phrase} (poste « ${f.poste} »)`);
  revalider(f);
  return { ok: true, id: demandeId, message: `Fiche ${NATURE_LIBELLE[f.nature].toLowerCase()} de ${f.nom} envoyée à l'assistante de direction.` };
}

/** ENVOYER UNE FICHE À L'ASSISTANTE — un clic, une fiche. */
export async function envoyerFiche(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const source = lireSource(fdStr(formData, "source"));
  const id = fdStr(formData, "id");
  if (!source || !id) return { ok: false, error: "Fiche non précisée." };
  return envoyerUne(user, source, id);
}

/**
 * « ENVOYER LES FICHES PRÊTES » — un RACCOURCI, pas un envoi en bloc : il appelle la même logique fiche par fiche
 * (`envoyerUne`), chaque fiche part seule avec son état. Un poste Ad & Pro (`itemId`), ou une prise en charge
 * (`scope` + `requestId`). Une fiche incomplète ou déjà chez l'assistante ne part pas, et le bilan le dit.
 */
export async function envoyerFichesPretes(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  const scope = fdStr(formData, "scope");
  const requestId = fdStr(formData, "requestId");
  let cles: { source: SourceFiche; id: string }[] = [];
  if (itemId) {
    const [v, h] = await Promise.all([
      prisma.adProVoyageur.findMany({ where: { itemId }, select: { id: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
      prisma.adProHebergement.findMany({ where: { itemId }, select: { id: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    ]);
    cles = [...v.map((x) => ({ source: "VOYAGEUR" as const, id: x.id })), ...h.map((x) => ({ source: "HEBERGEMENT" as const, id: x.id }))];
  } else if ((scope === "NATIONAL" || scope === "INTERNATIONAL") && requestId) {
    const parent = scope === "NATIONAL" ? { congressNationalId: requestId } : { congressInternationalId: requestId };
    const cells = await prisma.careCell.findMany({
      where: { kind: "SERVICE", serviceKind: { in: ["TICKET", "HOTEL"] }, status: { not: "WAIVED" }, beneficiary: parent },
      select: { id: true }, orderBy: [{ beneficiary: { position: "asc" } }, { position: "asc" }],
    });
    cles = cells.map((c) => ({ source: "CARE_CELL" as const, id: c.id }));
  } else {
    return { ok: false, error: "Poste ou prise en charge non précisé." };
  }
  if (cles.length === 0) return { ok: false, error: "Aucune fiche sur ce poste." };

  const fiches = await chargerFiches({
    voyageurIds: cles.filter((c) => c.source === "VOYAGEUR").map((c) => c.id),
    hebergementIds: cles.filter((c) => c.source === "HEBERGEMENT").map((c) => c.id),
    careCellIds: cles.filter((c) => c.source === "CARE_CELL").map((c) => c.id),
  });
  const premiere = [...fiches.values()][0];
  if (!premiere || !(await peutDemander(user, premiere))) return { ok: false, error: "Poste introuvable." };
  const demandes = await prisma.demandeReservation.findMany({
    where: { OR: [{ voyageurId: { in: cles.map((c) => c.id) } }, { hebergementId: { in: cles.map((c) => c.id) } }, { careCellId: { in: cles.map((c) => c.id) } }] },
    select: { voyageurId: true, hebergementId: true, careCellId: true, etat: true, empreinte: true },
  });
  const demandeDe = new Map(demandes.map((d) => [d.voyageurId ?? d.hebergementId ?? d.careCellId ?? "", d]));
  const lues = cles.flatMap((c) => {
    const f = fiches.get(cleFiche(c.source, c.id));
    if (!f || f.refus) return [];
    const d = demandeDe.get(c.id);
    return [{ ...c, f, manques: f.manques, etat: etatFiche(d ? { etat: d.etat as EtatDemande, empreinte: lireEmpreinte(d.empreinte) } : null, f.manques, f.empreinte) }];
  });
  const lot = fichesAEnvoyer(lues);
  if (lot.length === 0) return { ok: false, error: "Aucune fiche prête à envoyer : complétez celles qui le disent, ou relancez celles déjà chez l'assistante." };

  const parties: string[] = [];
  const echecs: string[] = [];
  for (const x of lot) {
    const r = await envoyerUne(user, x.source, x.id);
    if (r.ok) parties.push(x.f.nom);
    else echecs.push(`${x.f.nom} : ${r.error}`);
  }
  if (parties.length === 0) return { ok: false, error: echecs.join(" ; ") };
  return {
    ok: true,
    message: `${parties.length} fiche${parties.length > 1 ? "s" : ""} envoyée${parties.length > 1 ? "s" : ""}, chacune séparément.${echecs.length ? ` Non envoyée${echecs.length > 1 ? "s" : ""} : ${echecs.join(" ; ")}.` : ""}`,
  };
}

/**
 * RELANCER L'ASSISTANTE sur une fiche — une fois par 24 h au plus. Prévient celle qui l'a prise, sinon toutes les
 * assistantes actives ; le compteur se lit des deux côtés. `message` : la phrase du demandeur (facultative).
 */
export async function relancerFiche(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c || !(await peutDemander(user, c.f))) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const lu = etatLu({ etat: d.etat as EtatDemande, empreinte: lireEmpreinte(d.empreinte) }, f.empreinte);
  if (lu === "MODIFIEE_APRES_ENVOI") return { ok: false, error: "La fiche a changé depuis l'envoi : renvoyez la mise à jour plutôt que de relancer." };
  const refus = refusRelance({ etat: d.etat as EtatDemande, envoyeeLe: d.envoyeeLe, derniereRelanceLe: d.derniereRelanceLe }, new Date());
  if (refus) return { ok: false, error: refus };
  const message = fdStr(formData, "message");

  const w = await prisma.demandeReservation.updateMany({
    // CONDITIONNELLE : l'état et le compteur lus — deux clics ne font pas deux relances.
    where: { id, etat: d.etat, relances: d.relances },
    data: { relances: { increment: 1 }, derniereRelanceLe: new Date() },
  });
  if (w.count === 0) return { ok: false, error: "Cette fiche vient d'être relancée ou de changer d'état." };
  const phrase = `Relance — ${NATURE_LIBELLE[f.nature]} · ${f.nom}${message ? ` : ${message}` : "."}`;
  await noterAuFil(d.dossierId, user.id, phrase);
  const dest = await destinatairesAssistante(d);
  await prevenir(dest, { title: `Relance (${d.relances + 1}) — fiche de voyage`, body: phrase.slice(0, 240), link: lienBureau(id) }, user.id);
  await auditer(user, f, `${phrase} (${d.relances + 1}ᵉ relance)`);
  revalider(f);
  return { ok: true, id, message: `Relance envoyée${d.priseParId ? "" : " à toutes les assistantes"} — prochaine possible dans 24 h.` };
}

/**
 * RETIRER UNE FICHE de chez l'assistante — tant qu'elle n'est pas réservée. Le motif est EXIGÉ quand elle
 * l'avait déjà prise (elle travaillait dessus : elle doit savoir pourquoi elle s'arrête).
 */
export async function retirerFiche(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c || !(await peutDemander(user, c.f))) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const refus = refusGeste("RETIRER", d.etat as EtatDemande);
  if (refus) return { ok: false, error: refus };
  const motif = fdStr(formData, "motif");
  if (d.priseParId && !motif) return { ok: false, error: "L'assistante a déjà pris cette fiche : dites-lui pourquoi vous la retirez." };

  const w = await prisma.demandeReservation.updateMany({
    where: { id, etat: d.etat },
    data: { etat: "RETIREE", retireeLe: new Date(), retraitMotif: motif, priseParId: null, priseLe: null, devisRecuLe: null },
  });
  if (w.count === 0) return { ok: false, error: "Cette fiche vient de changer d'état : rouvrez-la." };
  const phrase = `Fiche retirée — ${NATURE_LIBELLE[f.nature]} · ${f.nom}${motif ? ` : ${motif}` : ""}. Ne la réservez pas.`;
  await noterAuFil(d.dossierId, user.id, phrase);
  await prevenir(await destinatairesAssistante(d), { title: "Fiche de voyage retirée", body: phrase.slice(0, 240), link: lienBureau(id) }, user.id);
  await auditer(user, f, phrase);
  revalider(f);
  return { ok: true, id, message: "Fiche retirée — l'assistante est prévenue. Elle se renvoie d'un clic." };
}

// ───────────────────────────── Côté assistante ─────────────────────────────

/** PRENDRE UNE FICHE — la première qui clique la prend ; la seconde l'apprend, avec le nom de celle qui l'a. */
export async function prendreFiche(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutTraiter(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const refus = refusGeste("PRENDRE", d.etat as EtatDemande);
  if (refus) return { ok: false, error: refus };
  const w = await prisma.demandeReservation.updateMany({
    where: { id, etat: "ENVOYEE", priseParId: null },
    data: { etat: "PRISE", priseParId: user.id, priseLe: new Date() },
  });
  if (w.count === 0) {
    const qui = await prisma.demandeReservation.findUnique({ where: { id }, select: { priseParId: true } });
    const nom = qui?.priseParId ? (await prisma.user.findUnique({ where: { id: qui.priseParId }, select: { name: true } }))?.name : null;
    return { ok: false, error: nom ? `${nom} vient de prendre cette fiche.` : "Cette fiche vient de changer d'état : rouvrez-la." };
  }
  await assurerMembre(d.dossierId, user.id);
  const phrase = `${NATURE_LIBELLE[f.nature]} · ${f.nom} — pris en charge par ${user.name}.`;
  await noterAuFil(d.dossierId, user.id, phrase);
  await prevenir([d.demandeurId], { title: `${prenom(user.name)} s'occupe de votre fiche`, body: phrase, link: f.operation.chemin }, user.id);
  await auditer(user, f, phrase);
  revalider(f);
  return { ok: true, id, message: "Fiche prise — elle est à vous." };
}

/**
 * SIGNALER UN MANQUE — motif obligatoire (c'est ce que le demandeur lira). La fiche revient « à compléter » chez
 * lui ; elle reste à celle qui l'avait prise, qui la retrouvera au renvoi.
 */
export async function signalerManque(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutTraiter(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const refus = refusGeste("SIGNALER_MANQUE", d.etat as EtatDemande);
  if (refus) return { ok: false, error: refus };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites ce qui manque : c'est ce que le demandeur lira." };
  const w = await prisma.demandeReservation.updateMany({
    where: { id, etat: d.etat },
    data: { etat: "MANQUE_SIGNALE", manqueMotif: motif.slice(0, 500), manqueLe: new Date(), manqueParId: user.id, priseParId: d.priseParId ?? user.id, priseLe: d.priseLe ?? new Date() },
  });
  if (w.count === 0) return { ok: false, error: "Cette fiche vient de changer d'état : rouvrez-la." };
  await assurerMembre(d.dossierId, user.id);
  const phrase = `Il manque quelque chose — ${NATURE_LIBELLE[f.nature]} · ${f.nom} : ${motif}`;
  await noterAuFil(d.dossierId, user.id, phrase);
  await prevenir([d.demandeurId], { title: "Fiche de voyage à compléter", body: phrase.slice(0, 240), link: f.operation.chemin }, user.id);
  await auditer(user, f, phrase);
  revalider(f);
  return { ok: true, id, message: "Manque signalé — la fiche revient « à compléter » chez le demandeur." };
}

/**
 * DÉPOSER LE BILLET / LA CONFIRMATION D'HÔTEL — une ou plusieurs pièces, attachées à la FICHE (le demandeur les
 * voit sur son poste), et la référence (PNR, n° de confirmation). REFUSÉ AVANT L'ACCORD du poste (décision du
 * 14/10) — et sur une fiche modifiée depuis l'envoi : on ne réserve pas sur des dates que le demandeur a changées.
 * La fiche est déclarée « réservée » AVANT que les fichiers partent (écriture conditionnelle) ; si aucun fichier
 * ne passe, elle revient à son état.
 */
export async function deposerBillet(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutTraiter(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const etat = d.etat as EtatDemande;
  if (etatLu({ etat, empreinte: lireEmpreinte(d.empreinte) }, f.empreinte) === "MODIFIEE_APRES_ENVOI") {
    return { ok: false, error: "La fiche a changé depuis l'envoi : attendez que le demandeur renvoie la mise à jour." };
  }
  const refus = refusGeste("DEPOSER", etat);
  if (refus) return { ok: false, error: refus };
  if (!f.accorde) return { ok: false, error: REFUS_AVANT_ACCORD };
  const fichiers = formData.getAll("pieces").filter((v): v is File => v instanceof File && v.size > 0);
  const reference = fdStr(formData, "reference")?.slice(0, 60) ?? null;
  if (fichiers.length === 0) return { ok: false, error: f.nature === "BILLET" ? "Joignez le billet (e-billet, PDF ou scan)." : "Joignez la confirmation de l'hôtel (voucher, PDF ou scan)." };
  const refusFichier = await validateAttachments(fichiers);
  if (refusFichier) return { ok: false, error: refusFichier };

  const maintenant = new Date();
  const w = await prisma.demandeReservation.updateMany({
    where: { id, etat: d.etat },
    data: {
      etat: "RESERVEE", reserveeLe: d.reserveeLe ?? maintenant, reserveeParId: d.reserveeParId ?? user.id,
      priseParId: d.priseParId ?? user.id, priseLe: d.priseLe ?? maintenant, ...(reference ? { referenceReservation: reference } : {}),
    },
  });
  if (w.count === 0) return { ok: false, error: "Cette fiche vient de changer d'état : rouvrez-la." };

  const deposes: string[] = [];
  const echecs: string[] = [];
  for (const file of fichiers) {
    const r = await persistUploadedDocument(user.id, {
      entityType: f.pieces.entityType as never, entityId: f.pieces.entityId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: f.id, file,
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
    if (r.ok && r.documentId) deposes.push(r.documentId);
    else echecs.push(`${file.name} : ${r.error ?? "dépôt impossible"}`);
  }
  if (deposes.length === 0) {
    // RIEN N'EST PARTI : la fiche n'est pas réservée, elle revient où elle était.
    await prisma.demandeReservation.updateMany({
      where: { id, etat: "RESERVEE" },
      data: { etat: d.etat, reserveeLe: d.reserveeLe, reserveeParId: d.reserveeParId, priseParId: d.priseParId, priseLe: d.priseLe, referenceReservation: d.referenceReservation },
    });
    return { ok: false, error: `Aucune pièce n'a pu être déposée — ${echecs.join(" ; ")}.` };
  }
  await prisma.demandeReservation.update({ where: { id }, data: { pieceIds: { push: deposes } } });
  // PRISE EN CHARGE : la case garde aussi SON billet émis (ce que lit le livret de séjour), sans écraser celui déjà posé.
  if (f.source === "CARE_CELL") {
    await prisma.careCell.updateMany({ where: { id: f.id, issuedDocumentId: null }, data: { issuedDocumentId: deposes[0] } });
    if (reference) await prisma.careCell.update({ where: { id: f.id }, data: { bookingRef: reference } });
  }
  await assurerMembre(d.dossierId, user.id);
  const quoi = f.nature === "BILLET" ? "Billet déposé" : "Confirmation d'hôtel déposée";
  const phrase = `${quoi} — ${f.nom}${reference ? ` (réf. ${reference})` : ""} : ${deposes.length} pièce${deposes.length > 1 ? "s" : ""}.`;
  await noterAuFil(d.dossierId, user.id, phrase);
  await prevenir([d.demandeurId], { title: quoi, body: phrase, link: f.operation.chemin }, user.id);
  await auditer(user, f, phrase);
  revalider(f);
  return { ok: true, id, message: `${quoi} — la fiche est réservée, le demandeur le voit sur son poste.${echecs.length ? ` Non déposé : ${echecs.join(" ; ")}.` : ""}` };
}

async function prochaineReferencePiece(): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await prisma.documentRequest.findMany({ where: { reference: { startsWith: `PIE-${year}-` } }, select: { reference: true } });
  return buildRef("PIE", year, rows.map((r) => r.reference));
}

/**
 * JOINDRE LE DEVIS DE L'AGENCE — par le circuit devis EXISTANT, jamais un second :
 *   • poste Ad & Pro : une DEMANDE DE PIÈCE « devis » du poste (celle du demandeur à l'assistante), où le fichier
 *     est déposé puis signalé par l'action existante `submitDocumentRequest` ; le demandeur l'accepte, et le devis
 *     rejoint le registre et la case « Devis / pro forma » du poste ;
 *   • prise en charge : le devis de la demande (`createCareQuote`), couvrant ce billet / cet hôtel.
 * La fiche passe « devis reçu ».
 */
export async function joindreDevisAgence(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutTraiter(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche non précisée." };
  const c = await chargerDemande(id);
  if (!c) return { ok: false, error: "Fiche introuvable." };
  const { d, f } = c;
  const refus = refusGeste("JOINDRE_DEVIS", d.etat as EtatDemande);
  if (refus) return { ok: false, error: refus };
  const fichiers = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Joignez le devis de l'agence (PDF, Word ou scan)." };
  const fournisseur = fdStr(formData, "fournisseur");
  const montant = fdNum(formData, "montant");
  if (montant !== null && !(montant > 0)) return { ok: false, error: "Le montant du devis doit être positif." };
  // LA DEVISE DE SAISIE (27/10/2026) : un montant saisi en DZD reste en DZD ; seul un montant DIT en USD se
  // convertit, une seule fois, au taux figé (1 USD = 240 DZD). Sans elle, le devis était relu dans la devise du
  // poste — des dinars lus comme des dollars, ×240.
  const deviseBrute = fdStr(formData, "devise") ?? "DZD";
  if (deviseBrute !== "DZD" && deviseBrute !== "USD") return { ok: false, error: "Devise inconnue (DZD ou USD)." };
  const devise: "DZD" | "USD" = deviseBrute;
  const montantDit = montant === null ? null
    : devise === "USD" ? `${montantLisible(montant, "USD")} (= ${montantLisible(Math.round(montant * TAUX_USD_DZD_DEFAUT * 100) / 100)})` : montantLisible(montant);
  const refusFichier = await validateAttachments(fichiers);
  if (refusFichier) return { ok: false, error: refusFichier };

  let devisRef: string;
  if (f.source === "CARE_CELL") {
    if (!fournisseur || montant === null) return { ok: false, error: "Le devis d'une prise en charge dit son agence et son montant." };
    const fd = new FormData();
    fd.set("scope", f.operation.type === "CONGRESS_NATIONAL" ? "NATIONAL" : "INTERNATIONAL");
    fd.set("requestId", f.operation.id);
    fd.set("supplier", fournisseur);
    fd.set("amount", String(montant));
    fd.set("devise", devise);
    fd.append("cellIds", f.id);
    fd.set("file", fichiers[0]!);
    fd.set("note", `Devis de l'agence pour ${NATURE_LIBELLE[f.nature].toLowerCase()} · ${f.nom}, joint par l'assistante de direction.`);
    const r = await createCareQuote(undefined, fd);
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "Le devis n'a pas pu être enregistré." };
    devisRef = r.id;
  } else {
    const itemId = f.itemId;
    if (!itemId) return { ok: false, error: "Poste introuvable." };
    const note = [
      `Devis de l'agence pour ${NATURE_LIBELLE[f.nature].toLowerCase()} · ${f.nom}.`,
      fournisseur ? `Agence : ${fournisseur}.` : null,
      montantDit ? `Montant : ${montantDit}.` : null,
    ].filter(Boolean).join(" ");
    const req = await createWithRetry(async () => prisma.documentRequest.create({
      data: {
        reference: await prochaineReferencePiece(), entityType: "AD_PRO_ITEM", entityId: itemId, link: f.operation.chemin,
        label: `Devis de l'agence — ${NATURE_LIBELLE[f.nature].toLowerCase()} · ${f.nom}`, note, kind: "QUOTE",
        askedById: d.demandeurId, askedToId: user.id, status: "PENDING",
      },
      select: { id: true },
    }));
    for (const file of fichiers) {
      const r = await persistUploadedDocument(user.id, {
        entityType: "DOCUMENT_REQUEST", entityId: req.id, category: "QUOTE", confidentiality: "INTERNAL", stepKey: null, file,
      });
      if (!r.ok) {
        await prisma.documentRequest.update({ where: { id: req.id }, data: { status: "CANCELLED", closedAt: new Date() } }).catch(() => undefined);
        return { ok: false, error: `${file.name} : ${r.error ?? "dépôt impossible"}` };
      }
    }
    const sd = new FormData();
    sd.set("id", req.id);
    sd.set("note", note);
    const r = await submitDocumentRequest(sd);
    if (!r.ok) return { ok: false, error: r.error ?? "Le devis n'a pas pu être signalé au demandeur." };
    devisRef = req.id;
  }

  await prisma.demandeReservation.updateMany({
    where: { id, etat: { in: ["ENVOYEE", "PRISE", "DEVIS_RECU"] } },
    data: { etat: "DEVIS_RECU", devisRecuLe: new Date(), devisRef, priseParId: d.priseParId ?? user.id, priseLe: d.priseLe ?? new Date() },
  });
  await assurerMembre(d.dossierId, user.id);
  const phrase = `Devis de l'agence joint — ${NATURE_LIBELLE[f.nature]} · ${f.nom}${fournisseur ? ` (${fournisseur})` : ""}${montantDit ? ` — ${montantDit}` : ""}.`;
  await noterAuFil(d.dossierId, user.id, phrase);
  await prevenir([d.demandeurId], {
    title: "Devis de l'agence reçu", body: f.source === "CARE_CELL" ? `${phrase} Retenez-le pour demander le BC.` : `${phrase} Acceptez-le pour qu'il rejoigne le poste.`,
    link: f.source === "CARE_CELL" ? f.operation.chemin : `/pieces/${devisRef}`,
  }, user.id);
  await auditer(user, f, phrase);
  revalider(f);
  return { ok: true, id, message: f.source === "CARE_CELL" ? "Devis enregistré sur la prise en charge — le demandeur le retient." : "Devis transmis au demandeur par la demande de pièce du poste — il l'accepte, et le devis rejoint le poste." };
}
