import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { hasRole } from "@/lib/rbac";
import { PARENT_COLONNE, type AdProParent } from "@/lib/ad-pro-items";
import { lienDemandeAdPro, lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import {
  etatPorteDg, phrasePorteDg, refusPorteDg, type DecisionDg, type EtatPorteDg,
} from "@/lib/seuils/porte-dg-total";

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
  return (await totauxDesDemandes(parent, [parentId])).get(parentId) ?? 0;
}

/**
 * LES TOTAUX DE PLUSIEURS DEMANDES d'un même type, EN LOT (ADPRO-07) — deux requêtes quel que soit leur
 * nombre. C'est LE calcul : `totalDeLaDemande` n'en est que l'appel sur un identifiant (§118.5).
 */
export async function totauxDesDemandes(parent: AdProParent, parentIds: readonly string[]): Promise<Map<string, number>> {
  const totaux = new Map<string, number>(parentIds.map((id) => [id, 0]));
  if (parentIds.length === 0) return totaux;
  const colonne = PARENT_COLONNE[parent];
  const colonneDevis = parent === "CONGRESS_NATIONAL" ? "congressNationalId" : parent === "CONGRESS_INTERNATIONAL" ? "congressInternationalId" : null;
  const ids = [...parentIds];
  const [lignes, devis] = await Promise.all([
    prisma.adProItem.findMany({
      where: { [colonne]: { in: ids }, status: { not: "REJECTED" } },
      select: { [colonne]: true, amountEstimated: true, amountGranted: true },
    }) as Promise<({ amountEstimated: Prisma.Decimal | null; amountGranted: Prisma.Decimal | null } & Record<string, unknown>)[]>,
    colonneDevis
      ? prisma.careQuote.findMany({
        where: { [colonneDevis]: { in: ids }, OR: [{ status: "ACCEPTED" }, { status: "PENDING", retainedAt: { not: null } }] },
        select: { [colonneDevis]: true, amountDzd: true },
      }) as Promise<({ amountDzd: Prisma.Decimal } & Record<string, unknown>)[]>
      : Promise.resolve([] as ({ amountDzd: Prisma.Decimal } & Record<string, unknown>)[]),
  ]);
  const ajouter = (id: unknown, montant: number) => {
    if (typeof id === "string" && totaux.has(id)) totaux.set(id, totaux.get(id)! + montant);
  };
  for (const l of lignes) ajouter(l[colonne], l.amountGranted != null ? num(l.amountGranted) : num(l.amountEstimated));
  if (colonneDevis) for (const d of devis) ajouter(d[colonneDevis], num(d.amountDzd));
  return totaux;
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
    seuilConnu !== undefined ? Promise.resolve(seuilConnu) : getAppSettings().then((s) => s.adProDgThreshold).catch(() => null),
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
  return (await demandeursEtNoms(parent, [parentId])).get(parentId) ?? null;
}

/** Le demandeur et le nom de plusieurs demandes d'un même type — une requête (ADPRO-07). */
async function demandeursEtNoms(parent: AdProParent, parentIds: readonly string[]): Promise<Map<string, { requesterId: string | null; nom: string }>> {
  const out = new Map<string, { requesterId: string | null; nom: string }>();
  const where = { id: { in: [...parentIds] } };
  switch (parent) {
    case "SPONSORING":
      for (const r of await prisma.sponsoringRequest.findMany({ where, select: { id: true, requesterId: true, reference: true, institution: true } })) {
        out.set(r.id, { requesterId: r.requesterId, nom: `Sponsoring ${r.reference} — ${r.institution}` });
      }
      break;
    case "CONGRESS_NATIONAL":
      for (const r of await prisma.congressNational.findMany({ where, select: { id: true, requesterId: true, name: true } })) {
        out.set(r.id, { requesterId: r.requesterId, nom: `Prise en charge nationale — ${r.name}` });
      }
      break;
    case "CONGRESS_INTERNATIONAL":
      for (const r of await prisma.congressInternational.findMany({ where, select: { id: true, requesterId: true, name: true } })) {
        out.set(r.id, { requesterId: r.requesterId, nom: `Prise en charge internationale — ${r.name}` });
      }
      break;
    case "EVENT":
      for (const r of await prisma.event.findMany({ where, select: { id: true, requesterId: true, name: true } })) {
        out.set(r.id, { requesterId: r.requesterId, nom: `Événement — ${r.name}` });
      }
      break;
    case "AD_PRO_OTHER":
      for (const r of await prisma.adProOtherRequest.findMany({ where, select: { id: true, requesterId: true, reference: true, title: true } })) {
        out.set(r.id, { requesterId: r.requesterId, nom: `Autre demande ${r.reference} — ${r.title}` });
      }
      break;
  }
  return out;
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
    // LE SIGNALEMENT EST LEVÉ (ADPRO-07) : le DG a statué, la ligne quitte la liste que relit le centre. Un
    // total qui bouge ensuite au-dessus de ce qu'il a validé la referme — et la signale de nouveau.
    create: { entityType: parent, entityId: parentId, statut: decision, montant: p.total, note, decideParId: user.id, decideLe: maintenant },
    update: { statut: decision, montant: p.total, note, decideParId: user.id, decideLe: maintenant, signaleMontant: null, signaleLe: null },
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
  if (d?.requesterId) await notifyUser({ userId: d.requesterId, type: "GENERIC", title: titre, body: corps, link: lien }).catch(() => undefined);
  await notifyRoles(["PRODUCT_MANAGER", "OPERATIONS_DIRECTOR"], { type: "GENERIC", title: titre, body: corps, link: lien }).catch(() => undefined);
  return { ok: true, message: `${libelle}.` };
}

/**
 * LES TOTAUX QUI ATTENDENT LE DG — pour le centre de validation. Ne relit que les demandes déjà
 * signalées (`signaleMontant`, posé quand la porte s'est fermée, levé quand le DG statue), puis
 * recalcule leur état : une demande dont le total est redescendu sous le seuil, ou déjà validée, n'y
 * figure pas.
 *
 * EN LOT (audit 27/10/2026, ADPRO-07) : la porte (3 requêtes) et le demandeur (1) se relisaient pour
 * CHACUNE des 300 lignes, à chaque ouverture du centre. Désormais : la porte d'abord (décisions
 * comprises), puis, par type de demande, les totaux et les demandeurs — une poignée de requêtes quel que
 * soit le nombre de lignes, et la MÊME règle d'état (`etatPorteDg`) appliquée en mémoire.
 */
export async function totauxEnAttenteDuDg(): Promise<{
  entityType: AdProParent; entityId: string; total: number; seuil: number | null; nom: string; requesterId: string | null; depuis: Date;
}[]> {
  const rows = await prisma.adProPorteDg.findMany({
    where: { signaleMontant: { not: null } },
    select: { entityType: true, entityId: true, signaleLe: true, updatedAt: true, statut: true, montant: true },
    orderBy: { signaleLe: "asc" },
    take: 300,
  });
  const seuil = await getAppSettings().then((s) => s.adProDgThreshold).catch(() => null);
  const parType = new Map<AdProParent, string[]>();
  for (const r of rows) {
    const parent = r.entityType as AdProParent;
    if (!(parent in PARENT_COLONNE)) continue;
    parType.set(parent, [...(parType.get(parent) ?? []), r.entityId]);
  }
  const lus = new Map<AdProParent, { totaux: Map<string, number>; demandeurs: Map<string, { requesterId: string | null; nom: string }> }>();
  await Promise.all([...parType].map(async ([parent, ids]) => {
    const [totaux, demandeurs] = await Promise.all([totauxDesDemandes(parent, ids), demandeursEtNoms(parent, ids)]);
    lus.set(parent, { totaux, demandeurs });
  }));
  const out: Awaited<ReturnType<typeof totauxEnAttenteDuDg>> = [];
  for (const r of rows) {
    const parent = r.entityType as AdProParent;
    const l = lus.get(parent);
    const d = l?.demandeurs.get(r.entityId);
    if (!l || !d) continue;
    const total = l.totaux.get(r.entityId) ?? 0;
    if (etatPorteDg(total, seuil, decisionDe(r)) !== "EN_ATTENTE") continue;
    out.push({ entityType: parent, entityId: r.entityId, total, seuil, nom: d.nom, requesterId: d.requesterId, depuis: r.signaleLe ?? r.updatedAt });
  }
  return out;
}
