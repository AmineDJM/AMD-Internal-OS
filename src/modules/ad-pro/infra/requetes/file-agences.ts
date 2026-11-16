import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac/roles";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { PARENTS, parentOf, loadItem } from "../postes/commun";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { sitsOnPaymentCentre } from "@/modules/finances/partage";
import { etapeAgence, pasAgence, type FaitsPosteAgence } from "../../domaine/parcours-agence";
import { siegeAuCentreAdPro } from "../../domaine/centre";
import { droitsValidation } from "../../domaine/validation-poste";
import { refusAvantPrevalidation, refusDemandeFermee, type ParentInfo } from "../postes/commun";
import { piecesDesPostes } from "../pieces-poste";
import { devisDesPostes } from "./devis-poste";
import { agencesDesPostes } from "./agence";

/**
 * LES FILES DU PARCOURS AGENCE (Direction, 15/11/2026) — ce qui attend CHAQUE personne, sans qu'elle ait à ouvrir les demandes :
 *   • l'assistante de direction : les postes qu'on lui a confiés (devis à déposer, BC à finaliser) ;
 *   • la Direction Marketing : tout le parcours, par étape ;
 *   • l'information médicale : les BAT à contrôler.
 */

export type EtapeFile = "DEVIS_A_DEPOSER" | "CHOIX" | "BC_A_FINALISER" | "BC_SOUMIS" | "EXECUTION" | "CONFORMITE" | "RECEPTION_FAITE";

export const LIBELLE_ETAPE_FILE: Record<EtapeFile, string> = {
  DEVIS_A_DEPOSER: "Devis à déposer",
  CHOIX: "Chez la Direction Marketing — choix de l'agence",
  BC_A_FINALISER: "BC à finaliser",
  BC_SOUMIS: "BC en validation et signatures",
  EXECUTION: "En exécution — BAT, réception, facture",
  CONFORMITE: "BAT chez l'information médicale",
  RECEPTION_FAITE: "Réceptionné",
};

/** L'étape vue de la file — lue sur les seuls horodatages de l'exécution (PUR). */
export function etapeDeLaFile(e: { devisTransmisAt: Date | null; agenceRetenueAt: Date | null; bcSoumisAt: Date | null; bcEnvoyeAt: Date | null; conformiteStatut: string | null; receptionAt: Date | null }): EtapeFile {
  if (e.receptionAt) return "RECEPTION_FAITE";
  if (e.conformiteStatut === "EN_CONTROLE") return "CONFORMITE";
  if (e.bcEnvoyeAt) return "EXECUTION";
  if (e.bcSoumisAt) return "BC_SOUMIS";
  if (e.agenceRetenueAt) return "BC_A_FINALISER";
  if (e.devisTransmisAt) return "CHOIX";
  return "DEVIS_A_DEPOSER";
}

export interface LigneFileAgence {
  itemId: string;
  label: string;
  nature: string;
  ref: string;
  etape: EtapeFile;
  /** À la personne qui regarde de jouer. */
  aMoi: boolean;
  depuis: string;
  cahierDesCharges: string | null;
  assistante: string | null;
  lien: string;
}

const estMarketing = (u: SessionUser) => hasRole(u, "PRODUCT_MANAGER") || hasRole(u, "SUPER_ADMIN");

/** La file « Prospection d'agences » — l'assistante voit SES postes ; la Direction Marketing et le Super Admin, tous. */
export async function fileAgences(user: SessionUser): Promise<LigneFileAgence[] | null> {
  const assistante = hasRole(user, "DIRECTION_ASSISTANT");
  const marketing = estMarketing(user);
  if (!assistante && !marketing) return null;
  const execs = await prisma.adProExecutionPoste.findMany({
    where: { prospectionDemandeeAt: { not: null }, ...(marketing ? {} : { assistanteId: user.id }), item: { expenseOrderId: null } },
    orderBy: { prospectionDemandeeAt: "asc" },
    take: 300,
    include: {
      item: { select: { id: true, label: true, kind: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true } },
    },
  });
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(execs.map((e) => e.assistanteId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const lignes: LigneFileAgence[] = [];
  for (const e of execs) {
    const owner = parentOf(e.item);
    if (!owner) continue;
    const info = await PARENTS[owner.parent].load(owner.id);
    const etape = etapeDeLaFile(e);
    const miennes = e.assistanteId === user.id;
    const aMoi = (miennes && (etape === "DEVIS_A_DEPOSER" || etape === "BC_A_FINALISER")) || (marketing && !miennes && (etape === "CHOIX" || etape === "BC_SOUMIS"));
    lignes.push({
      itemId: e.item.id, label: e.item.label, nature: ITEM_KIND_LABELS[e.item.kind], ref: info?.ref ?? "—", etape, aMoi,
      depuis: (e.bcSoumisAt ?? e.agenceRetenueAt ?? e.devisTransmisAt ?? e.prospectionDemandeeAt ?? e.createdAt).toISOString(),
      cahierDesCharges: e.cahierDesCharges, assistante: e.assistanteId ? noms.get(e.assistanteId) ?? null : null,
      lien: miennes && !marketing ? `/agences/${e.item.id}` : lienPosteAdPro(owner.parent, owner.id, e.item.id),
    });
  }
  return lignes;
}

/** Les BAT qui attendent l'information médicale. */
export async function fileConformite(): Promise<LigneFileAgence[]> {
  const execs = await prisma.adProExecutionPoste.findMany({
    where: { conformiteStatut: "EN_CONTROLE" },
    orderBy: { conformiteDemandeeAt: "asc" },
    include: { item: { select: { id: true, label: true, kind: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true } } },
  });
  const lignes: LigneFileAgence[] = [];
  for (const e of execs) {
    const owner = parentOf(e.item);
    if (!owner) continue;
    const info = await PARENTS[owner.parent].load(owner.id);
    lignes.push({
      itemId: e.item.id, label: e.item.label, nature: ITEM_KIND_LABELS[e.item.kind], ref: info?.ref ?? "—", etape: "CONFORMITE", aMoi: true,
      depuis: (e.conformiteDemandeeAt ?? e.updatedAt).toISOString(), cahierDesCharges: e.cahierDesCharges, assistante: null,
      lien: lienPosteAdPro(owner.parent, owner.id, e.item.id),
    });
  }
  return lignes;
}

/** Le poste ouvert par l'assistante qui en a la charge — avec de quoi monter sa carte. `null` hors de sa portée. */
export async function posteDeLAssistante(user: SessionUser, itemId: string) {
  const found = await loadItem(itemId, user);
  if (!found) return null;
  const info = await PARENTS[found.owner.parent].load(found.owner.id);
  if (!info) return null;
  return { owner: found.owner, ref: info.ref, label: found.item.label, kind: found.item.kind };
}

/** Une tâche du parcours agence pour « Aujourd'hui » — la même forme que les autres lignes de la file (`ActionItem`). */
export interface TacheAgence {
  key: string; objet: string; title: string; subtitle: string; href: string; depuis: string; statusLabel: string;
}

/**
 * CE QUE LE PARCOURS AGENCE ATTEND DE CETTE PERSONNE, pour « Aujourd'hui » (15/11/2026, complété le 16/11) — CHAQUE geste du
 * parcours, à qui le tient, par la MÊME règle que la carte du poste (`etapeAgence` / `pasAgence`) : ce que la carte dit
 * « À vous », la file le dit aussi.
 *   • Direction Marketing : demander la prospection, choisir l'agence, préparer, valider et signer le BC, l'envoyer, le BAT,
 *     la réception, la facture — jamais sur sa propre demande (une autre personne de la Direction Marketing, ou le Super Admin) ;
 *   • l'assistante chargée du poste : devis à déposer, BC à finaliser ou à corriger ;
 *   • le centre de validation Ad & Pro (DG) : le BC à viser au-dessus du seuil ;
 *   • les Finances (droit « Modifier » sur Bons de commande) : le BC à signer et cacheter ;
 *   • l'information médicale : le BAT à contrôler ;
 *   • le centre de paiement : le paiement à autoriser. (Le règlement est déjà dans la file des Finances.)
 */
export async function tachesAgence(user: SessionUser): Promise<TacheAgence[]> {
  const marketingRole = estMarketing(user);
  const assistanteRole = hasRole(user, "DIRECTION_ASSISTANT");
  const infoMed = hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN");
  const centre = siegeAuCentreAdPro(user);
  // Qui signe un BC : le droit « Modifier » sur Bons de commande (la règle de `peutSignerBC`, la page Bons de commande).
  const finances = userCan(user, "PURCHASE_ORDERS", "UPDATE");
  const paiement = sitsOnPaymentCentre(user as Parameters<typeof sitsOnPaymentCentre>[0]);
  if (!marketingRole && !assistanteRole && !infoMed && !centre && !finances && !paiement) return [];
  // Seule l'assistante ne voit que SES postes ; les autres rôles tiennent une étape de tous les postes « agence » en cours.
  const seulementSiens = assistanteRole && !marketingRole && !infoMed && !centre && !finances && !paiement;

  const items = await prisma.adProItem.findMany({
    where: {
      voie: "AGENCE", status: { not: "REJECTED" }, montantPayeHistorique: null,
      ...(seulementSiens ? { execution: { assistanteId: user.id } } : {}),
    },
    orderBy: { updatedAt: "asc" }, take: 200,
    select: {
      id: true, label: true, kind: true, status: true, orderStage: true, voie: true, conformiteRequise: true, updatedAt: true, expenseOrderId: true,
      execution: { select: { assistanteId: true } },
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
    },
  });
  // L'ordre de paiement de chaque poste (sans relation au schéma) : un poste PAYÉ n'attend plus personne.
  const ordreIds = items.map((i) => i.expenseOrderId).filter((x): x is string => Boolean(x));
  const ordres = new Map((ordreIds.length ? await prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, status: true, centralStatus: true } }) : [])
    .map((o) => [o.id, { status: String(o.status), centralStatus: String(o.centralStatus) }]));
  const enCours = items.filter((i) => !i.expenseOrderId || ordres.get(i.expenseOrderId)?.status !== "PAID");
  if (enCours.length === 0) return [];
  const ids = enCours.map((i) => i.id);
  const [pieces, devis] = await Promise.all([piecesDesPostes(ids), devisDesPostes(ids)]);
  const agences = await agencesDesPostes(enCours, pieces, devis);
  const infos = new Map<string, ParentInfo | null>();
  const demandeurs = new Map<string, { id: string; role: string; secondaryRole: string | null } | null>();

  const out: TacheAgence[] = [];
  for (const i of enCours) {
    const owner = parentOf(i);
    const agence = agences.get(i.id);
    const ordre = i.expenseOrderId ? ordres.get(i.expenseOrderId) ?? null : null;
    if (!owner || !agence) continue;
    const cle = `${owner.parent}:${owner.id}`;
    if (!infos.has(cle)) infos.set(cle, await PARENTS[owner.parent].load(owner.id));
    const info = infos.get(cle);
    if (!info) continue;
    const p = pieces.get(i.id);
    const faits: FaitsPosteAgence = {
      status: i.status, orderStage: i.orderStage,
      bc: p?.bc ? (p.bc.etape ?? "HORS_CIRCUIT") : null,
      factures: p?.factures.length ?? 0, expenseOrderId: i.expenseOrderId,
      expenseOrderStatus: ordre?.status ?? null, expenseOrderCentral: ordre?.centralStatus ?? null,
      agence: agence.faits,
    };
    const etape = etapeAgence(faits);
    // On ne demande pas la prospection d'un poste dont la demande n'est pas encore prévalidée, ou est refusée.
    if (etape === "PROSPECTION_A_DEMANDER" && (refusAvantPrevalidation(info) || refusDemandeFermee(info))) continue;
    if (!demandeurs.has(cle)) {
      demandeurs.set(cle, info.requesterId ? await prisma.user.findUnique({ where: { id: info.requesterId }, select: { id: true, role: true, secondaryRole: true } }) : null);
    }
    const marketing = marketingRole && droitsValidation(user, demandeurs.get(cle) ?? null).marketing;
    const pas = pasAgence(faits, {
      marketing, assistante: agence.assistanteId === user.id, infoMed, centre, fige: Boolean(info.clos || info.refusee),
    });
    const poste = lienPosteAdPro(owner.parent, owner.id, i.id);
    const base = { key: `agence-${i.id}`, objet: `AD_PRO_ITEM:${i.id}`, title: `${i.label} — ${info.ref}`, subtitle: `Parcours agence · ${ITEM_KIND_LABELS[i.kind]}`, depuis: i.updatedAt.toISOString() };
    if (pas.geste) {
      const chezAssistante = agence.assistanteId === user.id && !marketingRole;
      out.push({ ...base, href: chezAssistante ? `/agences/${i.id}` : poste, statusLabel: pas.geste.libelle });
    } else if (etape === "BC_A_SIGNER_FINANCES" && finances) {
      out.push({ ...base, href: "/bons-de-commande", statusLabel: "Signer et cacheter le BC" });
    } else if (etape === "PAIEMENT" && paiement && faits.expenseOrderCentral === "AWAITING") {
      out.push({ ...base, href: "/centre-de-paiement", statusLabel: "Autoriser le paiement" });
    }
  }
  return out;
}
