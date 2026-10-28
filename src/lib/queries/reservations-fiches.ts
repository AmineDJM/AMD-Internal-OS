import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { chargerFiches, cleFiche, ficheDeLaDemande, type CleFiches, type FicheReservation } from "@/lib/reservation-fiche/fiches";
import {
  diffEmpreintes, etatLu, lireEmpreinte, libelleEtatAssistante, tuilesFiches, versEnvoiVue, TON_ETAT,
  type ChampChange, type EnvoiVue, type EtatDemande, type NatureFiche, type SourceFiche, type TuilesFiches,
} from "@/lib/reservation-fiche/etat";
import type { BadgeTone } from "@/lib/labels";
import { TITRE_BC_A_ETABLIR } from "@/lib/ad-pro/pieces-secretariat";
import { dossiersPromoAMonTour } from "@/lib/queries/promo-circuit";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE, LUES POUR LES DEUX ÉCRANS (Direction, 14/10/2026) — le poste du demandeur
 * (une pastille par fiche) et l'onglet « Ad & Pro » du Bureau du secrétariat. Une lecture : la même
 * règle (`reservation-fiche/etat.ts`) que les actions, pour qu'un écran n'offre jamais un geste
 * que l'action refuserait (§118.83). En lot, jamais une requête par fiche (§118.102b).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const DEMANDE_SELECT = {
  id: true, voyageurId: true, hebergementId: true, careCellId: true, etat: true, empreinte: true, envoyeeLe: true, relances: true,
  derniereRelanceLe: true, priseParId: true, reserveeLe: true, manqueMotif: true, referenceReservation: true, pieceIds: true,
} as const;

async function nomsDe(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const l = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (l.length === 0) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

async function documentsDe(ids: readonly string[]): Promise<Map<string, { id: string; name: string; hasFile: boolean }>> {
  if (ids.length === 0) return new Map();
  const docs = await prisma.document.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, fileKey: true } });
  return new Map(docs.map((d) => [d.id, { id: d.id, name: d.name, hasFile: Boolean(d.fileKey) }]));
}

/**
 * L'ÉTAT DE CHAQUE FICHE pour l'écran du demandeur — `{ [ficheId]: EnvoiVue }`. Les fiches d'un poste Ad & Pro
 * (voyageurs, fiches hôtellerie) ou d'une prise en charge (billets et hôtels).
 */
export async function envoisDesFiches(cles: CleFiches): Promise<Record<string, EnvoiVue>> {
  const ids = [...(cles.voyageurIds ?? []), ...(cles.hebergementIds ?? []), ...(cles.careCellIds ?? [])];
  if (ids.length === 0) return {};
  const [fiches, demandes] = await Promise.all([
    chargerFiches(cles),
    prisma.demandeReservation.findMany({
      where: { OR: [{ voyageurId: { in: ids } }, { hebergementId: { in: ids } }, { careCellId: { in: ids } }] },
      select: DEMANDE_SELECT,
    }),
  ]);
  const [noms, docs] = await Promise.all([nomsDe(demandes.map((d) => d.priseParId)), documentsDe(demandes.flatMap((d) => d.pieceIds))]);
  const demandeDe = new Map(demandes.map((d) => [d.voyageurId ?? d.hebergementId ?? d.careCellId ?? "", d]));
  const maintenant = new Date();
  const out: Record<string, EnvoiVue> = {};
  for (const f of fiches.values()) {
    const d = demandeDe.get(f.id) ?? null;
    // UN POSTE REFUSÉ, UNE PERSONNE ÉCARTÉE : rien ne s'y envoie — on ne montre que ce qui était déjà parti.
    if (f.refus && !d) continue;
    out[f.id] = versEnvoiVue({
      source: f.source, ficheId: f.id, nature: f.nature, manques: f.manques, empreinte: f.empreinte,
      demande: d ? { ...d, etat: d.etat as EtatDemande } : null,
      priseParNom: d?.priseParId ? noms.get(d.priseParId) ?? null : null,
      pieces: (d?.pieceIds ?? []).map((id) => docs.get(id)).filter((x): x is { id: string; name: string; hasFile: boolean } => Boolean(x)).map(({ id, name }) => ({ id, name })),
    }, maintenant);
  }
  return out;
}

/** Les fiches d'une prise en charge (billets et hôtels non « sans objet »), pour sa page. */
export async function envoisDePriseEnCharge(scope: "NATIONAL" | "INTERNATIONAL", requestId: string): Promise<Record<string, EnvoiVue>> {
  const cells = await prisma.careCell.findMany({
    where: {
      kind: "SERVICE", serviceKind: { in: ["TICKET", "HOTEL"] },
      beneficiary: scope === "NATIONAL" ? { congressNationalId: requestId } : { congressInternationalId: requestId },
    },
    select: { id: true },
  });
  return envoisDesFiches({ careCellIds: cells.map((c) => c.id) });
}

// ───────────────────────────── Le Bureau du secrétariat — onglet « Ad & Pro » ─────────────────────────────

/** Qui voit l'onglet « Ad & Pro » du Bureau : l'assistante de direction (rôle principal ou secondaire), le Super Admin. */
export function voitBureauAdPro(u: Pick<SessionUser, "role"> & { secondaryRole?: SessionUser["secondaryRole"] }): boolean {
  return hasRole(u as SessionUser, "DIRECTION_ASSISTANT") || u.role === "SUPER_ADMIN";
}

export interface PieceVue {
  id: string;
  name: string;
  hasFile: boolean;
  /** « Passeport », « Pièce d'identité », « Billet / confirmation », « Document ». */
  role: string;
}

export interface MessageFil {
  id: string;
  auteur: string;
  le: string;
  body: string;
}

/** Une ligne de la file de l'assistante — une fiche envoyée. */
export interface LigneFiche {
  demandeId: string;
  source: SourceFiche;
  ficheId: string;
  nature: NatureFiche;
  personne: string;
  resume: string;
  dates: string;
  demandeur: string;
  envoyeeLe: string;
  depuis: string;
  relances: number;
  derniereRelanceLe: string | null;
  etat: EtatDemande;
  libelle: string;
  ton: BadgeTone;
  priseParId: string | null;
  priseParNom: string | null;
  manqueMotif: string | null;
  changements: ChampChange[];
  accorde: boolean;
  poste: string;
  budget: number | null;
  operation: { type: EntityType; id: string; ref: string; chemin: string };
  sujet: { id: string; reference: string } | null;
  pieces: PieceVue[];
  reference: string | null;
  devisRef: string | null;
}

export interface GroupeOperation {
  cle: string;
  titre: string;
  lignes: LigneFiche[];
}

/** Une ligne « BC de poste à établir » ou « devis à retranscrire » — lue dans les files EXISTANTES. */
export interface TravailAdPro {
  id: string;
  type: "BC" | "DEVIS";
  titre: string;
  sousTitre: string;
  statut: string;
  depuis: string;
  href: string;
}

export interface BureauAdProData {
  tuiles: TuilesFiches & { bc: number; devis: number };
  groupes: GroupeOperation[];
  travaux: TravailAdPro[];
  fils: Record<string, MessageFil[]>;
  /** Le total de l'onglet : à prendre + en cours + BC + devis (les relancées sont déjà dans les deux premiers). */
  compteur: number;
  moi: string;
}

const depuisJ = (d: Date, maintenant: Date) => {
  const h = Math.floor((maintenant.getTime() - d.getTime()) / 3600_000);
  return h < 1 ? "à l'instant" : h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
};

/** Les états qu'on montre dans la file (une fiche réservée reste trente jours, pour qu'on la retrouve). */
const RETENUE_RESERVEES_MS = 30 * 24 * 3600 * 1000;

async function travauxAdPro(user: SessionUser): Promise<TravailAdPro[]> {
  const maintenant = new Date();
  const toutes = user.role === "SUPER_ADMIN";
  const [piecesBc, bcSecretariat, devisSecretariat, promo] = await Promise.all([
    // LE BC D'UN POSTE, demandé à l'assistante par une DEMANDE DE PIÈCE (§118.204).
    prisma.documentRequest.findMany({
      where: { entityType: "AD_PRO_ITEM", kind: "PURCHASE_ORDER", status: { in: ["PENDING", "DECLINED"] }, ...(toutes ? {} : { askedToId: user.id }) },
      select: { id: true, reference: true, label: true, entityId: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" }, take: 100,
    }),
    // L'ANCIENNE FORME : la demande « Bon de commande à établir » au bureau du secrétariat.
    prisma.administrativeRequest.findMany({
      where: { linkedEntityType: "AD_PRO_ITEM", type: "OTHER", title: { startsWith: TITRE_BC_A_ETABLIR }, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
      select: { id: true, reference: true, title: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" }, take: 100,
    }),
    // LES DEMANDES DE DEVIS d'un poste au secrétariat (à obtenir, puis retranscrire).
    prisma.administrativeRequest.findMany({
      where: { linkedEntityType: "AD_PRO_ITEM", type: "QUOTE", deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
      select: { id: true, reference: true, title: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" }, take: 100,
    }),
    // LE MATÉRIEL PROMOTIONNEL dont c'est son tour de retranscrire les devis (circuit 2).
    dossiersPromoAMonTour(user).then((l) => l.filter((d) => d.tour === "GESTE" && d.etat === "QUOTE_REQUESTED")).catch(sansBloquer("reservations-fiches.travauxAdPro.dossiersPromoAMonTour", [])),
  ]);
  const postes = piecesBc.length
    ? new Map((await prisma.adProItem.findMany({ where: { id: { in: piecesBc.map((p) => p.entityId) } }, select: { id: true, label: true } })).map((p) => [p.id, p.label]))
    : new Map<string, string>();
  return [
    ...piecesBc.map((p) => ({
      id: p.id, type: "BC" as const, titre: p.label, sousTitre: `${p.reference}${postes.get(p.entityId) ? ` · poste « ${postes.get(p.entityId)} »` : ""}`,
      statut: p.status === "DECLINED" ? "à redéposer" : "à établir", depuis: depuisJ(p.createdAt, maintenant), href: `/pieces/${p.id}`,
    })),
    ...bcSecretariat.map((r) => ({
      id: r.id, type: "BC" as const, titre: r.title, sousTitre: r.reference, statut: "à établir", depuis: depuisJ(r.createdAt, maintenant), href: `/demandes/${r.id}`,
    })),
    ...devisSecretariat.map((r) => ({
      id: r.id, type: "DEVIS" as const, titre: r.title, sousTitre: r.reference, statut: "devis à obtenir", depuis: depuisJ(r.createdAt, maintenant), href: `/demandes/${r.id}`,
    })),
    ...promo.map((d) => ({
      id: d.id, type: "DEVIS" as const, titre: d.title, sousTitre: `${d.reference} · matériel promotionnel`, statut: "à retranscrire", depuis: "", href: `/promo-material/${d.id}`,
    })),
  ];
}

/** LE COMPTEUR de l'onglet « Ad & Pro » — sans charger les fiches. */
export async function compteurBureauAdPro(user: SessionUser): Promise<number> {
  const [fiches, travaux] = await Promise.all([
    prisma.demandeReservation.count({ where: { etat: { in: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MODIFIEE_APRES_ENVOI"] } } }),
    travauxAdPro(user),
  ]);
  return fiches + travaux.length;
}

/** L'ONGLET « AD & PRO » DU BUREAU — les fiches envoyées groupées par opération, les tuiles, les BC et devis. */
export async function bureauAdPro(user: SessionUser): Promise<BureauAdProData> {
  const maintenant = new Date();
  const demandes = await prisma.demandeReservation.findMany({
    where: {
      OR: [
        { etat: { in: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MODIFIEE_APRES_ENVOI", "MANQUE_SIGNALE"] } },
        { etat: "RESERVEE", reserveeLe: { gte: new Date(maintenant.getTime() - RETENUE_RESERVEES_MS) } },
      ],
    },
    orderBy: { envoyeeLe: "asc" },
    take: 400,
  });
  const refs = demandes.map((d) => ({ d, ref: ficheDeLaDemande(d) }));
  const [fiches, travaux] = await Promise.all([
    chargerFiches({
      voyageurIds: refs.filter((x) => x.ref?.source === "VOYAGEUR").map((x) => x.ref!.id),
      hebergementIds: refs.filter((x) => x.ref?.source === "HEBERGEMENT").map((x) => x.ref!.id),
      careCellIds: refs.filter((x) => x.ref?.source === "CARE_CELL").map((x) => x.ref!.id),
    }),
    travauxAdPro(user),
  ]);
  const ficheDe = (x: { ref: { source: SourceFiche; id: string } | null }): FicheReservation | undefined => (x.ref ? fiches.get(cleFiche(x.ref.source, x.ref.id)) : undefined);

  // LES PIÈCES DE LA FICHE : celles qui la désignent (passeport, autres documents, billet émis) et, en prise en
  // charge, la pièce d'identité de la PERSONNE (une case DOCUMENT de sa fiche).
  const surFiche = refs.filter((x) => ficheDe(x));
  const pieces = surFiche.length
    ? await prisma.document.findMany({
        where: { stepKey: { in: surFiche.map((x) => x.ref!.id) }, entityType: { in: ["AD_PRO_ITEM", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL"] } },
        select: { id: true, name: true, fileKey: true, stepKey: true, category: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  const personnes = [...new Set(surFiche.map((x) => ficheDe(x)?.careBeneficiaryId).filter((x): x is string => Boolean(x)))];
  const piecesPersonnes = personnes.length
    ? await prisma.careCell.findMany({ where: { beneficiaryId: { in: personnes }, kind: "DOCUMENT", documentId: { not: null } }, select: { beneficiaryId: true, label: true, documentId: true } })
    : [];
  const docsPersonnes = await documentsDe(piecesPersonnes.map((p) => p.documentId!).filter(Boolean));
  const piecesDe = new Map<string, PieceVue[]>();
  const pieceIdsBillet = new Set(demandes.flatMap((d) => d.pieceIds));
  for (const p of pieces) {
    const l = piecesDe.get(p.stepKey ?? "") ?? [];
    l.push({
      id: p.id, name: p.name, hasFile: Boolean(p.fileKey),
      role: pieceIdsBillet.has(p.id) ? "Billet / confirmation" : String(p.category) === "ID_DOCUMENT" ? "Passeport / pièce d'identité" : "Document",
    });
    piecesDe.set(p.stepKey ?? "", l);
  }
  const piecesPersonneDe = new Map<string, PieceVue[]>();
  for (const p of piecesPersonnes) {
    const doc = p.documentId ? docsPersonnes.get(p.documentId) : undefined;
    if (!doc) continue;
    piecesPersonneDe.set(p.beneficiaryId, [...(piecesPersonneDe.get(p.beneficiaryId) ?? []), { ...doc, role: p.label }]);
  }

  const sujetsIds = [...new Set(surFiche.map((x) => x.d.dossierId ?? ficheDe(x)?.sujetId).filter((x): x is string => Boolean(x)))];
  const [sujets, messages, noms] = await Promise.all([
    sujetsIds.length ? prisma.dossier.findMany({ where: { id: { in: sujetsIds } }, select: { id: true, reference: true } }) : [],
    sujetsIds.length
      ? prisma.dossierMessage.findMany({ where: { dossierId: { in: sujetsIds } }, orderBy: { createdAt: "desc" }, take: 40 * sujetsIds.length, select: { id: true, dossierId: true, body: true, createdAt: true, author: { select: { name: true } } } })
      : [],
    nomsDe([...demandes.map((d) => d.demandeurId), ...demandes.map((d) => d.priseParId)]),
  ]);
  const sujetDe = new Map(sujets.map((s) => [s.id, s]));
  const fils: Record<string, MessageFil[]> = {};
  for (const m of messages) {
    const l = (fils[m.dossierId] ??= []);
    if (l.length < 40) l.push({ id: m.id, auteur: m.author?.name ?? "—", le: m.createdAt.toISOString(), body: m.body });
  }
  for (const k of Object.keys(fils)) fils[k]!.reverse();

  const lignes: LigneFiche[] = [];
  for (const x of surFiche) {
    const f = ficheDe(x)!;
    const d = x.d;
    const etat = etatLu({ etat: d.etat as EtatDemande, empreinte: lireEmpreinte(d.empreinte) }, f.empreinte);
    const stockee = lireEmpreinte(d.empreinte);
    const sujetId = d.dossierId ?? f.sujetId;
    const priseParNom = d.priseParId ? noms.get(d.priseParId) ?? null : null;
    lignes.push({
      demandeId: d.id, source: f.source, ficheId: f.id, nature: f.nature, personne: f.nom, resume: f.resume, dates: f.dates,
      demandeur: noms.get(d.demandeurId) ?? "—", envoyeeLe: d.envoyeeLe.toISOString(), depuis: depuisJ(d.envoyeeLe, maintenant),
      relances: d.relances, derniereRelanceLe: d.derniereRelanceLe?.toISOString() ?? null,
      etat, libelle: libelleEtatAssistante(etat, priseParNom?.split(/\s+/)[0] ?? null), ton: TON_ETAT[etat],
      priseParId: d.priseParId, priseParNom, manqueMotif: d.manqueMotif,
      changements: etat === "MODIFIEE_APRES_ENVOI" && stockee ? diffEmpreintes(stockee, f.empreinte) : [],
      accorde: f.accorde, poste: f.poste, budget: f.budget,
      operation: { type: f.operation.type, id: f.operation.id, ref: f.operation.ref, chemin: f.operation.chemin },
      sujet: sujetId && sujetDe.get(sujetId) ? { id: sujetId, reference: sujetDe.get(sujetId)!.reference } : null,
      pieces: [...(f.careBeneficiaryId ? piecesPersonneDe.get(f.careBeneficiaryId) ?? [] : []), ...(piecesDe.get(f.id) ?? [])],
      reference: d.referenceReservation, devisRef: d.devisRef,
    });
  }

  const groupes = new Map<string, GroupeOperation>();
  for (const l of lignes) {
    const cle = `${l.operation.type}:${l.operation.id}:${l.poste}`;
    const g = groupes.get(cle) ?? { cle, titre: `${l.operation.ref} · ${l.poste}${l.budget != null ? ` · ${l.budget.toLocaleString("fr-FR")} DZD accordés` : ""}`, lignes: [] };
    g.lignes.push(l);
    groupes.set(cle, g);
  }
  const t = tuilesFiches(lignes.map((l) => ({ etat: l.etat, relances: l.relances })));
  const bc = travaux.filter((x) => x.type === "BC").length;
  const devis = travaux.filter((x) => x.type === "DEVIS").length;
  return {
    tuiles: { ...t, bc, devis },
    groupes: [...groupes.values()],
    travaux,
    fils,
    compteur: t.aPrendre + t.enCours + bc + devis,
    moi: user.id,
  };
}

