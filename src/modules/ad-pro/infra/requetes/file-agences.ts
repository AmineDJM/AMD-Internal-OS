import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac/roles";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { PARENTS, parentOf, loadItem } from "../postes/commun";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";

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
 * CE QUE LE PARCOURS AGENCE ATTEND DE CETTE PERSONNE, pour « Aujourd'hui » (15/11/2026) : l'assistante (devis à déposer,
 * BC à finaliser), la Direction Marketing (agence à choisir, BC à valider et signer), l'information médicale (BAT à contrôler).
 */
export async function tachesAgence(user: SessionUser): Promise<TacheAgence[]> {
  const out: TacheAgence[] = [];
  const file = await fileAgences(user).catch(() => null);
  for (const l of file ?? []) {
    if (!l.aMoi) continue;
    out.push({ key: `agence-${l.itemId}`, objet: `AD_PRO_ITEM:${l.itemId}`, title: `${l.label} — ${l.ref}`, subtitle: "Parcours agence", href: l.lien, depuis: l.depuis, statusLabel: LIBELLE_ETAPE_FILE[l.etape] });
  }
  if (hasRole(user, "MEDICAL_INFO_PHARMACIST")) {
    for (const l of await fileConformite()) {
      out.push({ key: `bat-${l.itemId}`, objet: `AD_PRO_ITEM_BAT:${l.itemId}`, title: `BAT — ${l.label} — ${l.ref}`, subtitle: "Contrôle de conformité", href: l.lien, depuis: l.depuis, statusLabel: "À contrôler" });
    }
  }
  return out;
}
