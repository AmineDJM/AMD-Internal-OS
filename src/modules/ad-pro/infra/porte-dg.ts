import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { hasRole } from "@/lib/rbac";
import { PARENT_COLONNE, type AdProParent } from "../domaine/postes";
import { lienDemandeAdPro, lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import {
  etatPorteDg, phrasePorteDg, refusPorteDg, type DecisionDg, type EtatPorteDg,
} from "@/lib/seuils/porte-dg-total";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DU DG SUR LE TOTAL D'UNE DEMANDE — la lecture en base, la décision, le signalement.
 *
 * Règle (Direction, 27/10/2026) : `lib/seuils/porte-dg-total.ts`. Ici, UN seul calcul du total — la
 * somme des postes non refusés (accordé quand il l'est, sinon estimé), plus les devis de personnes
 * acceptés ou retenus d'une prise en charge —, lu par la carte des postes, la carte des devis,
 * la fiche, le centre de validation et chaque action qui engagerait de l'argent (bon de commande,
 * visa, paiement). Deux calculs écrits à part finiraient par ne plus compter les mêmes postes, et le
 * symptôme serait un BC émis porte fermée (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LecturePorteDg {
  etat: EtatPorteDg;
  total: number;
  seuil: number | null;
  decision: DecisionDg | null;
  /** La phrase à afficher, ou `null` quand la porte n'est pas requise. */
  phrase: string | null;
  /** Le refus à rendre par une action qui engagerait de l'argent, ou `null` si la porte est ouverte. */
  refus: string | null;
  decideLe: Date | null;
  note: string | null;
}

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));

/**
 * LE TOTAL DE LA DEMANDE — la somme de ses postes non refusés (accordé, sinon estimé), et, pour une
 * prise en charge, de ses DEVIS de personnes qui comptent : acceptés, ou retenus (la proposition
 * choisie, en attente de BC). Un devis seulement reçu ne compte pas : plusieurs se concurrencent pour
 * les mêmes cases, les additionner gonflerait le total de propositions qu'on n'engagera jamais.
 */
export async function totalDeLaDemande(parent: AdProParent, parentId: string): Promise<number> {
  const colonneDevis = parent === "CONGRESS_NATIONAL" ? "congressNationalId" : parent === "CONGRESS_INTERNATIONAL" ? "congressInternationalId" : null;
  const [lignes, devis] = await Promise.all([
    prisma.adProItem.findMany({
      where: { [PARENT_COLONNE[parent]]: parentId, status: { not: "REJECTED" } },
      select: { amountEstimated: true, amountGranted: true },
    }),
    colonneDevis
      ? prisma.careQuote.findMany({
        where: { [colonneDevis]: parentId, OR: [{ status: "ACCEPTED" }, { status: "PENDING", retainedAt: { not: null } }] },
        select: { amountDzd: true },
      })
      : Promise.resolve([] as { amountDzd: Prisma.Decimal }[]),
  ]);
  const postes = lignes.reduce((t, l) => t + (l.amountGranted != null ? num(l.amountGranted) : num(l.amountEstimated)), 0);
  return postes + devis.reduce((t, d) => t + num(d.amountDzd), 0);
}

function decisionDe(row: { statut: string | null; montant: Prisma.Decimal | null } | null): DecisionDg | null {
  if (!row?.statut || row.montant == null) return null;
  if (row.statut !== "VALIDEE" && row.statut !== "A_REVOIR") return null;
  return { statut: row.statut, montant: num(row.montant) };
}

/** OÙ EN EST LA PORTE d'une demande. Une panne de lecture la tient FERMÉE au-dessus du seuil (sens sûr). */
export async function lirePorteDg(parent: AdProParent, parentId: string, seuilConnu?: number | null, enPlus = 0): Promise<LecturePorteDg> {
  const [totalActuel, seuil, row] = await Promise.all([
    totalDeLaDemande(parent, parentId),
    seuilConnu !== undefined ? Promise.resolve(seuilConnu) : getAppSettings().then((s) => s.adProDgThreshold).catch(sansBloquer("porte-dg.lirePorteDg.getAppSettings", null)),
    prisma.adProPorteDg.findUnique({ where: { entityType_entityId: { entityType: parent, entityId: parentId } } }),
  ]);
  // `enPlus` : un engagement qui n'est pas encore dans le total (un devis accepté sans avoir été retenu).
  const total = totalActuel + enPlus;
  const decision = decisionDe(row);
  const etat = etatPorteDg(total, seuil, decision);
  return {
    etat, total, seuil, decision,
    phrase: phrasePorteDg(etat, total, seuil, decision),
    refus: refusPorteDg(etat, total, seuil, decision),
    decideLe: row?.decideLe ?? null,
    note: row?.note ?? null,
  };
}

/** Le refus d'une action qui engagerait de l'argent pour un poste de cette demande — `null` si la porte est ouverte. */
export async function refusSiPorteDgFermee(parent: AdProParent, parentId: string, enPlus = 0): Promise<string | null> {
  return (await lirePorteDg(parent, parentId, undefined, enPlus)).refus;
}

/** Qui statue sur le total : le Directeur Général (rôle principal ou secondaire), ou le Super Admin. */
export function peutStatuerSurLeTotal(user: { role: string; secondaryRole?: string | null }): boolean {
  return user.role === "SUPER_ADMIN" || hasRole(user as { role: UserRole; secondaryRole?: UserRole | null }, "GENERAL_MANAGER");
}

async function demandeurEtNom(parent: AdProParent, parentId: string): Promise<{ requesterId: string | null; nom: string } | null> {
  switch (parent) {
    case "SPONSORING": {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id: parentId }, select: { requesterId: true, reference: true, institution: true } });
      return r ? { requesterId: r.requesterId, nom: `Sponsoring ${r.reference} — ${r.institution}` } : null;
    }
    case "CONGRESS_NATIONAL": {
      const r = await prisma.congressNational.findUnique({ where: { id: parentId }, select: { requesterId: true, name: true } });
      return r ? { requesterId: r.requesterId, nom: `Prise en charge nationale — ${r.name}` } : null;
    }
    case "CONGRESS_INTERNATIONAL": {
      const r = await prisma.congressInternational.findUnique({ where: { id: parentId }, select: { requesterId: true, name: true } });
      return r ? { requesterId: r.requesterId, nom: `Prise en charge internationale — ${r.name}` } : null;
    }
    case "EVENT": {
      const r = await prisma.event.findUnique({ where: { id: parentId }, select: { requesterId: true, name: true } });
      return r ? { requesterId: r.requesterId, nom: `Événement — ${r.name}` } : null;
    }
    case "AD_PRO_OTHER": {
      const r = await prisma.adProOtherRequest.findUnique({ where: { id: parentId }, select: { requesterId: true, reference: true, title: true } });
      return r ? { requesterId: r.requesterId, nom: `Autre demande ${r.reference} — ${r.title}` } : null;
    }
  }
}

/**
 * PRÉVENIR LE DG quand la porte vient de se fermer pour un NOUVEAU total — appelé après chaque
 * changement de poste. Un même total n'est signalé qu'une fois. Ne lève jamais.
 */
export async function signalerPorteDgSiBesoin(parent: AdProParent, parentId: string): Promise<void> {
  try {
    const p = await lirePorteDg(parent, parentId);
    if (p.etat !== "EN_ATTENTE") return;
    const row = await prisma.adProPorteDg.findUnique({ where: { entityType_entityId: { entityType: parent, entityId: parentId } } });
    if (row?.signaleMontant != null && Math.abs(num(row.signaleMontant) - p.total) < 0.005) return;
    await prisma.adProPorteDg.upsert({
      where: { entityType_entityId: { entityType: parent, entityId: parentId } },
      create: { entityType: parent, entityId: parentId, signaleMontant: p.total, signaleLe: new Date() },
      update: { signaleMontant: p.total, signaleLe: new Date() },
    });
    const d = await demandeurEtNom(parent, parentId);
    await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
      type: "ASSIGNMENT",
      title: "Ad & Pro — total à valider (Directeur Général)",
      body: `${d?.nom ?? "Demande"} — ${p.phrase ?? ""}`.slice(0, 280),
      link: lienLigneCentreAdPro(parentId),
    });
  } catch (e) {
    console.error("[porte-dg] signalement", parent, parentId, e);
  }
}

/**
 * LE DG STATUE SUR LE TOTAL — « Valider le total » ou « Renvoyer en révision » (motif exigé).
 *
 * La décision porte sur le total LU MAINTENANT : s'il a bougé depuis l'affichage, on le dit plutôt
 * que de valider un montant que le DG n'a pas vu.
 */
export async function statuerSurLeTotal(input: {
  user: { id: string; name?: string | null; role: string; secondaryRole?: string | null };
  parent: AdProParent;
  parentId: string;
  decision: "VALIDEE" | "A_REVOIR";
  /** Le total que l'écran affichait au DG. */
  totalVu: number;
  note: string | null;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { user, parent, parentId, decision } = input;
  if (!peutStatuerSurLeTotal(user)) return { ok: false, error: "Seul le Directeur Général (ou le Super Admin) valide le total d'une demande." };
  const note = input.note?.trim() || null;
  if (decision === "A_REVOIR" && !note) return { ok: false, error: "Dites ce qu'il faut revoir : le motif est transmis aux parties prenantes." };
  const p = await lirePorteDg(parent, parentId);
  if (p.etat === "NON_REQUISE") return { ok: false, error: "Le total de cette demande ne dépasse pas le seuil : votre validation n'est pas requise." };
  if (Math.abs(p.total - input.totalVu) >= 0.005) {
    return { ok: false, error: `Le total vient de changer (${Math.round(p.total).toLocaleString("fr-FR")} DZD) : rouvrez la demande pour statuer sur le montant à jour.` };
  }
  const maintenant = new Date();
  await prisma.adProPorteDg.upsert({
    where: { entityType_entityId: { entityType: parent, entityId: parentId } },
    create: { entityType: parent, entityId: parentId, statut: decision, montant: p.total, note, decideParId: user.id, decideLe: maintenant },
    update: { statut: decision, montant: p.total, note, decideParId: user.id, decideLe: maintenant },
  });
  const montant = `${Math.round(p.total).toLocaleString("fr-FR")} DZD`;
  const libelle = decision === "VALIDEE" ? `Total de ${montant} validé par le Directeur Général` : `Total de ${montant} renvoyé en révision par le Directeur Général`;
  // AU JOURNAL DU CIRCUIT : la décision se lit à côté des étapes de la demande.
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType: parent, entityId: parentId } }, select: { id: true } });
  if (instance) {
    await prisma.workflowStepEvent.create({
      data: {
        instanceId: instance.id, stepSlug: "dg-total", stepTitle: "Validation du total (Directeur Général)",
        action: decision === "VALIDEE" ? "APPROVE" : "RETURN", actorId: user.id, actorName: user.name ?? null,
        note: note ?? libelle, amount: p.total,
      },
    }).catch((e) => console.error("[porte-dg] journal", e));
  }
  const d = await demandeurEtNom(parent, parentId);
  await recordAudit({
    actorId: user.id, action: decision === "VALIDEE" ? "VALIDATE" : "UPDATE", module: "Ad & Pro", entityType: parent, entityId: parentId,
    summary: `${libelle} — ${d?.nom ?? parentId}${note ? ` (${note})` : ""}`,
  });
  // LES PARTIES PRENANTES : le demandeur, la Direction Marketing et le Directeur des opérations.
  const titre = decision === "VALIDEE" ? "Ad & Pro — total validé par le DG : les bons de commande peuvent partir" : "Ad & Pro — total renvoyé en révision par le DG";
  const corps = `${d?.nom ?? "Demande"} — ${libelle}${note ? ` : ${note}` : "."}`.slice(0, 280);
  const lien = lienDemandeAdPro(parent, parentId);
  if (d?.requesterId) await notifyUser({ userId: d.requesterId, type: "GENERIC", title: titre, body: corps, link: lien }).catch(sansBloquer("porte-dg.statuerSurLeTotal.notifyUser"));
  await notifyRoles(["PRODUCT_MANAGER", "OPERATIONS_DIRECTOR"], { type: "GENERIC", title: titre, body: corps, link: lien }).catch(sansBloquer("porte-dg.statuerSurLeTotal.notifyRoles"));
  return { ok: true, message: `${libelle}.` };
}

/**
 * LES TOTAUX QUI ATTENDENT LE DG — pour le centre de validation. Ne relit que les demandes déjà
 * signalées (`signaleMontant`, posé quand la porte s'est fermée), puis recalcule leur état : une
 * demande dont le total est redescendu sous le seuil, ou déjà validée, n'y figure pas.
 */
export async function totauxEnAttenteDuDg(): Promise<{
  entityType: AdProParent; entityId: string; total: number; seuil: number | null; nom: string; requesterId: string | null; depuis: Date;
}[]> {
  const rows = await prisma.adProPorteDg.findMany({
    where: { signaleMontant: { not: null } },
    select: { entityType: true, entityId: true, signaleLe: true, updatedAt: true },
    orderBy: { signaleLe: "asc" },
    take: 300,
  });
  const seuil = await getAppSettings().then((s) => s.adProDgThreshold).catch(sansBloquer("porte-dg.totauxEnAttenteDuDg.getAppSettings", null));
  const out: Awaited<ReturnType<typeof totauxEnAttenteDuDg>> = [];
  for (const r of rows) {
    const parent = r.entityType as AdProParent;
    if (!(parent in PARENT_COLONNE)) continue;
    const p = await lirePorteDg(parent, r.entityId, seuil);
    if (p.etat !== "EN_ATTENTE") continue;
    const d = await demandeurEtNom(parent, r.entityId);
    if (!d) continue;
    out.push({ entityType: parent, entityId: r.entityId, total: p.total, seuil: p.seuil, nom: d.nom, requesterId: d.requesterId, depuis: r.signaleLe ?? r.updatedAt });
  }
  return out;
}
