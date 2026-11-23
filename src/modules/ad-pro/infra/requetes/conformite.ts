import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac/roles";
import { lienPosteAdPro, type AdProParent } from "@/lib/chemins/ad-pro";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { lireStatutConformite, type StatutConformite } from "../../domaine/parcours-agence";
import { PARENTS, parentOf, demandeVisible } from "../postes/commun";
import { ETAPE_BAT } from "./agence";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BAT DE L'INFORMATION MÉDICALE (Direction, 23/11/2026 — « qu'Alaa sache quoi faire et le fasse facilement »).
 *
 * La file d'avant ne prenait personne : elle listait aussi les postes des « Autres demandes », que le pharmacien n'ouvre
 * pas — la ligne menait à une fiche introuvable, et la décision répondait « Poste introuvable ». Elle ne montrait aucun
 * BAT, seulement le dernier une fois le poste ouvert, et rien de ce qui avait déjà été décidé. Désormais, pour CHAQUE
 * poste, ce qu'il faut pour décider SUR LA LIGNE : la demande et son produit, l'agence, le cahier des charges, TOUS les
 * BAT (le plus récent d'abord ; les versions précédentes avec leur « non conforme » et ce qu'il fallait corriger).
 *
 *   • à contrôler : le BAT attend sa décision (`EN_CONTROLE`) ;
 *   • en attente d'un BAT corrigé : déclaré non conforme, la Direction Marketing le fait reprendre par l'agence ;
 *   • décidés : les 30 dernières décisions.
 *
 * Seuls les postes que la personne peut ouvrir (`demandeVisible` — la porte de `loadItem`, celle de la décision).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FichierBat {
  id: string;
  nom: string;
  le: string;
  /** Le tour de contrôle auquel ce fichier a été soumis (1 = le premier envoi). */
  tour: number;
  /** La décision qui a suivi ce tour ; `null` : en contrôle. */
  verdict: { conforme: boolean; note: string | null; le: string } | null;
}

export interface LigneBat {
  itemId: string;
  poste: string;
  nature: string;
  /** La référence de la demande et son nom (événement, institution, titre de la demande « autre »). */
  ref: string;
  demande: string;
  agence: string | null;
  produits: string | null;
  cahierDesCharges: string | null;
  statut: StatutConformite;
  /** ISO — l'envoi du BAT en contrôle, ou la décision. */
  depuis: string;
  envoyePar: string | null;
  decidePar: string | null;
  note: string | null;
  /** Tous les fichiers BAT du poste, le plus récent d'abord. */
  fichiers: FichierBat[];
  /** La fiche du poste — seulement pour qui ouvre l'écran de la demande. */
  lienPoste: string | null;
}

export interface FileConformite {
  aControler: LigneBat[];
  enAttenteCorrection: LigneBat[];
  decides: LigneBat[];
}

const DECIDES = 30;
const PREFIXE_AUDIT = "Conformité du poste « ";

/** Les décisions passées d'un poste, relues dans le journal de sa demande (`audit` de `deciderConformitePoste`). */
function decisionsDuJournal(label: string, journal: readonly { summary: string | null; createdAt: Date }[]) {
  const tete = `${PREFIXE_AUDIT}${label} » : `;
  const out: { conforme: boolean; note: string | null; le: Date }[] = [];
  for (const j of journal) {
    if (!j.summary?.startsWith(tete)) continue;
    const reste = j.summary.slice(tete.length);
    if (reste.startsWith("conforme")) out.push({ conforme: true, note: null, le: j.createdAt });
    else if (reste.startsWith("non conforme")) out.push({ conforme: false, note: reste.replace(/^non conforme( — )?/, "").replace(/\.$/, "") || null, le: j.createdAt });
  }
  return out;
}

/** La demande qui porte chaque poste : son nom et le produit qu'elle promeut — en lot, une requête par table. */
async function demandesLues(owners: readonly { parent: AdProParent; id: string }[]) {
  const ids = (p: AdProParent) => [...new Set(owners.filter((o) => o.parent === p).map((o) => o.id))];
  const [spo, cn, ci, ev, au] = await Promise.all([
    ids("SPONSORING").length ? prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { id: true, institution: true, type: true, product: true } }) : [],
    ids("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, name: true, promotedProducts: true } }) : [],
    ids("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true, products: true } }) : [],
    ids("EVENT").length ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, name: true, products: true } }) : [],
    ids("AD_PRO_OTHER").length ? prisma.adProOtherRequest.findMany({ where: { id: { in: ids("AD_PRO_OTHER") } }, select: { id: true, title: true, product: true } }) : [],
  ]);
  const res = new Map<string, { nom: string; produits: string | null }>();
  for (const s of spo) res.set(s.id, { nom: `${s.type} — ${s.institution}`, produits: s.product });
  for (const c of cn) res.set(c.id, { nom: c.name, produits: c.promotedProducts });
  for (const c of ci) res.set(c.id, { nom: c.name, produits: c.products });
  for (const e of ev) res.set(e.id, { nom: e.name, produits: e.products });
  for (const o of au) res.set(o.id, { nom: o.title, produits: o.product });
  return res;
}

/** LA FILE DES BAT, pour la personne qui regarde — `null` hors de l'information médicale et de la Direction Marketing. */
export async function fileConformite(user: SessionUser): Promise<FileConformite | null> {
  if (!hasRole(user, "MEDICAL_INFO_PHARMACIST") && !hasRole(user, "SUPER_ADMIN") && !hasRole(user, "PRODUCT_MANAGER")) return null;
  const choix = {
    id: true, itemId: true, conformiteStatut: true, conformiteDemandeeAt: true, conformiteDemandeeParId: true, conformiteDecideeAt: true,
    conformiteParId: true, conformiteNote: true, cahierDesCharges: true, agenceDevisId: true, updatedAt: true,
    item: { select: { id: true, label: true, kind: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true } },
  } as const;
  const [ouverts, decides] = await Promise.all([
    prisma.adProExecutionPoste.findMany({ where: { conformiteStatut: { in: ["EN_CONTROLE", "NON_CONFORME"] } }, orderBy: { conformiteDemandeeAt: "asc" }, take: 300, select: choix }),
    prisma.adProExecutionPoste.findMany({ where: { conformiteDecideeAt: { not: null }, conformiteStatut: { in: ["CONFORME", "NON_CONFORME"] } }, orderBy: { conformiteDecideeAt: "desc" }, take: DECIDES, select: choix }),
  ]);
  const execs = [...new Map([...ouverts, ...decides].map((e) => [e.id, e])).values()];

  // LA PORTE DE LA DÉCISION, une fois par demande : ce que la personne n'ouvre pas ne s'affiche pas.
  const visibles = new Map<string, boolean>();
  const lus: { e: (typeof execs)[number]; owner: { parent: AdProParent; id: string } }[] = [];
  for (const e of execs) {
    const owner = parentOf(e.item);
    if (!owner) continue;
    const cle = `${owner.parent}:${owner.id}`;
    if (!visibles.has(cle)) visibles.set(cle, await demandeVisible(user, owner.parent, owner.id));
    if (visibles.get(cle)) lus.push({ e, owner });
  }
  const itemIds = lus.map((l) => l.e.itemId);
  const personnes = [...new Set(lus.flatMap((l) => [l.e.conformiteDemandeeParId, l.e.conformiteParId]).filter((x): x is string => Boolean(x)))];
  const devisIds = [...new Set(lus.map((l) => l.e.agenceDevisId).filter((x): x is string => Boolean(x)))];
  const [demandes, fichiers, journal, noms, agences] = await Promise.all([
    demandesLues(lus.map((l) => l.owner)),
    itemIds.length ? prisma.document.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: itemIds }, stepKey: ETAPE_BAT }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, entityId: true, createdAt: true } }) : [],
    lus.length ? prisma.auditLog.findMany({
      where: { entityId: { in: [...new Set(lus.map((l) => l.owner.id))] }, summary: { startsWith: PREFIXE_AUDIT } },
      orderBy: { createdAt: "asc" }, select: { entityId: true, summary: true, createdAt: true },
    }) : [],
    personnes.length ? prisma.user.findMany({ where: { id: { in: personnes } }, select: { id: true, name: true } }) : [],
    devisIds.length ? prisma.legalDocument.findMany({ where: { id: { in: devisIds } }, select: { id: true, counterparty: true } }) : [],
  ]);
  const nomDe = new Map(noms.map((u) => [u.id, u.name]));
  const agenceDe = new Map(agences.map((a) => [a.id, a.counterparty]));
  const refs = new Map<string, string>();
  for (const { owner } of lus) {
    const cle = `${owner.parent}:${owner.id}`;
    if (!refs.has(cle)) refs.set(cle, (await PARENTS[owner.parent].load(owner.id))?.ref ?? "—");
  }

  const ligne = ({ e, owner }: (typeof lus)[number]): LigneBat => {
    const statut = lireStatutConformite(e.conformiteStatut) ?? "EN_CONTROLE";
    // LES TOURS : chaque décision clôt les BAT envoyés avant elle ; ce qui suit la dernière est en contrôle.
    const passees = decisionsDuJournal(e.item.label, journal.filter((j) => j.entityId === owner.id));
    if (statut !== "EN_CONTROLE" && e.conformiteDecideeAt && !passees.some((d) => Math.abs(d.le.getTime() - e.conformiteDecideeAt!.getTime()) < 60_000)) {
      passees.push({ conforme: statut === "CONFORME", note: e.conformiteNote, le: e.conformiteDecideeAt });
      passees.sort((a, b) => a.le.getTime() - b.le.getTime());
    }
    const siens = fichiers.filter((f) => f.entityId === e.itemId).map((f) => {
      const i = passees.findIndex((d) => d.le.getTime() >= f.createdAt.getTime());
      const d = i >= 0 ? passees[i] : null;
      return {
        id: f.id, nom: f.name, le: f.createdAt.toISOString(), tour: i >= 0 ? i + 1 : passees.length + 1,
        verdict: d ? { conforme: d.conforme, note: d.note, le: d.le.toISOString() } : null,
      };
    }).reverse();
    const demande = demandes.get(owner.id);
    const module = PARENTS[owner.parent].module;
    return {
      itemId: e.itemId, poste: e.item.label, nature: ITEM_KIND_LABELS[e.item.kind], ref: refs.get(`${owner.parent}:${owner.id}`) ?? "—",
      demande: demande?.nom ?? "—", agence: e.agenceDevisId ? agenceDe.get(e.agenceDevisId) ?? null : null, produits: demande?.produits ?? null,
      cahierDesCharges: e.cahierDesCharges, statut,
      depuis: ((statut === "EN_CONTROLE" ? e.conformiteDemandeeAt : e.conformiteDecideeAt) ?? e.updatedAt).toISOString(),
      envoyePar: e.conformiteDemandeeParId ? nomDe.get(e.conformiteDemandeeParId) ?? null : null,
      decidePar: e.conformiteParId ? nomDe.get(e.conformiteParId) ?? null : null,
      note: e.conformiteNote, fichiers: siens,
      lienPoste: userCan(user, module, "VIEW") ? lienPosteAdPro(owner.parent, owner.id, e.itemId) : null,
    };
  };
  const ouvertsIds = new Set(ouverts.map((e) => e.id));
  return {
    aControler: lus.filter((l) => ouvertsIds.has(l.e.id) && l.e.conformiteStatut === "EN_CONTROLE").map(ligne),
    enAttenteCorrection: lus.filter((l) => ouvertsIds.has(l.e.id) && l.e.conformiteStatut === "NON_CONFORME").map(ligne),
    decides: lus.filter((l) => l.e.conformiteDecideeAt && l.e.conformiteStatut !== "EN_CONTROLE")
      .sort((a, b) => b.e.conformiteDecideeAt!.getTime() - a.e.conformiteDecideeAt!.getTime()).slice(0, DECIDES).map(ligne),
  };
}
