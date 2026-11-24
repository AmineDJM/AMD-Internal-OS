import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { chargerFiches, cleFiche, ficheDeLaDemande, type CleFiches, type FicheReservation } from "@/lib/reservation-fiche/fiches";
import {
  diffEmpreintes, etatLu, lireEmpreinte, libelleEtatAssistante, statutDevisAgence, versEnvoiVue, TON_ETAT,
  type ChampChange, type DevisAgenceVue, type EnvoiVue, type EtatDemande, type NatureFiche, type SourceFiche,
} from "@/lib/reservation-fiche/etat";
import { lireNoteDevisAgence } from "@/lib/reservation-fiche/devis-agence";
import type { BadgeTone } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE, LUES POUR LES DEUX ÉCRANS (Direction, 14/10/2026) — le poste du demandeur
 * (une pastille par fiche) et le Bureau du secrétariat (une ligne par fiche, une page par fiche). Une lecture : la même
 * règle (`reservation-fiche/etat.ts`) que les actions, pour qu'un écran n'offre jamais un geste
 * que l'action refuserait (§118.83). En lot, jamais une requête par fiche (§118.102b).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const DEMANDE_SELECT = {
  id: true, voyageurId: true, hebergementId: true, careCellId: true, etat: true, empreinte: true, envoyeeLe: true, relances: true,
  derniereRelanceLe: true, priseParId: true, reserveeLe: true, manqueMotif: true, referenceReservation: true, pieceIds: true,
  devisRef: true, devisRecuLe: true,
} as const;

/**
 * LES DEVIS D'AGENCE DES FICHES D'UN POSTE AD & PRO — leurs demandes de pièce, en lot (§118.102b) : où en est chacune
 * (à accepter, acceptée), qui l'accepte, ce que l'assistante a saisi, ses fichiers tant qu'ils attendent l'acceptation
 * (acceptée, la pièce déménage au registre et se lit dans l'onglet « Devis » du poste). `devisRef` d'une prise en charge
 * désigne un devis de prise en charge, pas une demande de pièce : il n'est pas lu ici.
 */
async function devisAgenceDes(demandes: readonly { careCellId: string | null; devisRef: string | null; devisRecuLe: Date | null }[]): Promise<Map<string, DevisAgenceVue>> {
  const couvre = new Map<string, number>();
  for (const d of demandes) if (!d.careCellId && d.devisRef && d.devisRecuLe) couvre.set(d.devisRef, (couvre.get(d.devisRef) ?? 0) + 1);
  if (couvre.size === 0) return new Map();
  const ids = [...couvre.keys()];
  const [requetes, fichiers, fiches] = await Promise.all([
    prisma.documentRequest.findMany({ where: { id: { in: ids }, kind: "QUOTE" }, select: { id: true, reference: true, status: true, askedById: true, note: true } }),
    prisma.document.findMany({ where: { entityType: "DOCUMENT_REQUEST", entityId: { in: ids } }, select: { id: true, name: true, fileKey: true, entityId: true }, orderBy: { createdAt: "asc" } }),
    // Combien de fiches ce même devis couvre — toutes, pas seulement celles de l'écran.
    prisma.demandeReservation.groupBy({ by: ["devisRef"], where: { devisRef: { in: ids } }, _count: { _all: true } }),
  ]);
  const nb = new Map(fiches.map((g) => [g.devisRef ?? "", g._count._all]));
  const out = new Map<string, DevisAgenceVue>();
  for (const r of requetes) {
    const saisi = lireNoteDevisAgence(r.note);
    out.set(r.id, {
      pieceId: r.id, reference: r.reference, statut: statutDevisAgence(String(r.status)), demandeurId: r.askedById,
      fournisseur: saisi.fournisseur, montantDzd: saisi.montantDzd, fiches: nb.get(r.id) ?? couvre.get(r.id) ?? 1,
      fichiers: fichiers.filter((f) => f.entityId === r.id).map((f) => ({ id: f.id, name: f.name, hasFile: Boolean(f.fileKey) })),
    });
  }
  return out;
}

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
  const [noms, docs, devisAgence] = await Promise.all([nomsDe(demandes.map((d) => d.priseParId)), documentsDe(demandes.flatMap((d) => d.pieceIds)), devisAgenceDes(demandes)]);
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
      devisAgence: d?.devisRef && d.devisRecuLe && !d.careCellId ? devisAgence.get(d.devisRef) ?? null : null,
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

// ───────────────────────────── Le Bureau du secrétariat — les fiches billet / hôtel ─────────────────────────────

/** Qui TRAITE les fiches de voyage au bureau : l'assistante de direction (rôle principal ou secondaire), le Super Admin — la règle des gestes (`peutTraiter`). */
export function voitBureauAdPro(u: Pick<SessionUser, "role"> & { secondaryRole?: SessionUser["secondaryRole"] }): boolean {
  return hasRole(u as SessionUser, "DIRECTION_ASSISTANT") || u.role === "SUPER_ADMIN";
}

/**
 * QUELLES FICHES DE VOYAGE UNE PERSONNE LIT AU BUREAU — la clause NOMMÉE, partagée par la ligne du tableau et la page
 * de la fiche (`/demandes/fiches/<id>`) : l'assistante et le Super Admin, toutes ; toute autre personne, celles qu'elle a
 * envoyées (« un demandeur ordinaire ne voit que ses demandes »). Une seule écriture : la liste et la fiche ne peuvent
 * pas se contredire.
 */
export function clauseFichesVisibles(user: SessionUser): Prisma.DemandeReservationWhereInput {
  return voitBureauAdPro(user) ? {} : { demandeurId: user.id };
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
  /** Les fichiers joints au message (`DossierMessageAttachment`). */
  fichiers: { id: string; name: string }[];
}

/** Une fiche envoyée, telle que le bureau la lit. */
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
  /** Le poste Ad & Pro de la fiche (`null` : une prise en charge) et qui l'a envoyée — « ce devis couvre aussi » ne propose que les fiches du même poste et du même demandeur. */
  itemId: string | null;
  demandeurId: string;
  /** Réservée ou retirée : quand (ISO) — la ligne close du bureau se date ainsi. */
  closeLe: string | null;
}

const depuisJ = (d: Date, maintenant: Date) => {
  const h = Math.floor((maintenant.getTime() - d.getTime()) / 3600_000);
  return h < 1 ? "à l'instant" : h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
};

/** Les fiches closes restent au bureau six mois (« Voir plus de terminées » les montre au-delà de trente jours). */
const RETENUE_CLOSES_MS = 183 * 24 * 3600 * 1000;
/** Une limite OPÉRATIONNELLE (§118.2) : au-delà, la page le dit. */
export const PLAFOND_FICHES_BUREAU = 400;

type DemandeLueBureau = Awaited<ReturnType<typeof prisma.demandeReservation.findMany>>[number];

/**
 * LES LIGNES DE FICHES — en lot (§118.102b), la même règle que les actions (`etatLu`, `libelleEtatAssistante`). `details` :
 * les pièces, le sujet et son fil (la page de la fiche) ; sans lui, ce que le tableau montre.
 */
async function lignesDesDemandes(demandes: DemandeLueBureau[], details: boolean): Promise<{ lignes: LigneFiche[]; fils: Record<string, MessageFil[]> }> {
  const maintenant = new Date();
  const refs = demandes.map((d) => ({ d, ref: ficheDeLaDemande(d) }));
  const fiches = await chargerFiches({
    voyageurIds: refs.filter((x) => x.ref?.source === "VOYAGEUR").map((x) => x.ref!.id),
    hebergementIds: refs.filter((x) => x.ref?.source === "HEBERGEMENT").map((x) => x.ref!.id),
    careCellIds: refs.filter((x) => x.ref?.source === "CARE_CELL").map((x) => x.ref!.id),
  });
  const ficheDe = (x: { ref: { source: SourceFiche; id: string } | null }): FicheReservation | undefined => (x.ref ? fiches.get(cleFiche(x.ref.source, x.ref.id)) : undefined);
  const surFiche = refs.filter((x) => ficheDe(x));

  // LES PIÈCES DE LA FICHE (page seulement) : celles qui la désignent (passeport, autres documents, billet émis) et, en
  // prise en charge, la pièce d'identité de la PERSONNE (une case DOCUMENT de sa fiche).
  const piecesDe = new Map<string, PieceVue[]>();
  const piecesPersonneDe = new Map<string, PieceVue[]>();
  if (details && surFiche.length) {
    const pieces = await prisma.document.findMany({
      where: { stepKey: { in: surFiche.map((x) => x.ref!.id) }, entityType: { in: ["AD_PRO_ITEM", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL"] } },
      select: { id: true, name: true, fileKey: true, stepKey: true, category: true }, orderBy: { createdAt: "asc" },
    });
    const personnes = [...new Set(surFiche.map((x) => ficheDe(x)?.careBeneficiaryId).filter((x): x is string => Boolean(x)))];
    const piecesPersonnes = personnes.length
      ? await prisma.careCell.findMany({ where: { beneficiaryId: { in: personnes }, kind: "DOCUMENT", documentId: { not: null } }, select: { beneficiaryId: true, label: true, documentId: true } })
      : [];
    const docsPersonnes = await documentsDe(piecesPersonnes.map((p) => p.documentId!).filter(Boolean));
    const pieceIdsBillet = new Set(demandes.flatMap((d) => d.pieceIds));
    for (const p of pieces) {
      const l = piecesDe.get(p.stepKey ?? "") ?? [];
      l.push({
        id: p.id, name: p.name, hasFile: Boolean(p.fileKey),
        role: pieceIdsBillet.has(p.id) ? "Billet / confirmation" : String(p.category) === "ID_DOCUMENT" ? "Passeport / pièce d'identité" : "Document",
      });
      piecesDe.set(p.stepKey ?? "", l);
    }
    for (const p of piecesPersonnes) {
      const doc = p.documentId ? docsPersonnes.get(p.documentId) : undefined;
      if (!doc) continue;
      piecesPersonneDe.set(p.beneficiaryId, [...(piecesPersonneDe.get(p.beneficiaryId) ?? []), { ...doc, role: p.label }]);
    }
  }

  const sujetsIds = details ? [...new Set(surFiche.map((x) => x.d.dossierId ?? ficheDe(x)?.sujetId).filter((x): x is string => Boolean(x)))] : [];
  const [sujets, messages, noms] = await Promise.all([
    sujetsIds.length ? prisma.dossier.findMany({ where: { id: { in: sujetsIds } }, select: { id: true, reference: true } }) : [],
    sujetsIds.length
      ? prisma.dossierMessage.findMany({
          where: { dossierId: { in: sujetsIds } }, orderBy: { createdAt: "desc" }, take: 40 * sujetsIds.length,
          select: { id: true, dossierId: true, body: true, createdAt: true, author: { select: { name: true } }, attachments: { select: { id: true, name: true } } },
        })
      : [],
    nomsDe([...demandes.map((d) => d.demandeurId), ...demandes.map((d) => d.priseParId)]),
  ]);
  const sujetDe = new Map(sujets.map((s) => [s.id, s]));
  const fils: Record<string, MessageFil[]> = {};
  for (const m of messages) {
    const l = (fils[m.dossierId] ??= []);
    if (l.length < 40) l.push({ id: m.id, auteur: m.author?.name ?? "—", le: m.createdAt.toISOString(), body: m.body, fichiers: m.attachments });
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
      itemId: f.source === "CARE_CELL" ? null : f.itemId, demandeurId: d.demandeurId,
      closeLe: (etat === "RESERVEE" ? d.reserveeLe : etat === "RETIREE" ? d.updatedAt : null)?.toISOString() ?? null,
    });
  }
  return { lignes, fils };
}

/**
 * LES FICHES DE VOYAGE DU BUREAU — toutes celles que la personne lit (`clauseFichesVisibles`) : ouvertes, et closes
 * depuis moins de six mois. La plus ancienne envoyée d'abord.
 */
export async function fichesDuBureau(user: SessionUser): Promise<{ lignes: LigneFiche[]; coupe: boolean }> {
  const maintenant = new Date();
  const demandes = await prisma.demandeReservation.findMany({
    where: {
      AND: [
        clauseFichesVisibles(user),
        {
          OR: [
            { etat: { in: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MODIFIEE_APRES_ENVOI", "MANQUE_SIGNALE"] } },
            { etat: { in: ["RESERVEE", "RETIREE"] }, updatedAt: { gte: new Date(maintenant.getTime() - RETENUE_CLOSES_MS) } },
          ],
        },
      ],
    },
    orderBy: { envoyeeLe: "asc" },
    take: PLAFOND_FICHES_BUREAU + 1,
  });
  const coupe = demandes.length > PLAFOND_FICHES_BUREAU;
  const { lignes } = await lignesDesDemandes(demandes.slice(0, PLAFOND_FICHES_BUREAU), false);
  return { lignes, coupe };
}

/**
 * LA PAGE D'UNE FICHE (`/demandes/fiches/<id>`) — la fiche, ses pièces, son fil, et les fiches « sœurs » qu'un même devis
 * d'agence peut couvrir (même poste, même demandeur, encore sans devis). `null` hors de la clause : la page dit 404.
 */
export async function ficheDuBureau(user: SessionUser, demandeId: string): Promise<{ ligne: LigneFiche; freres: LigneFiche[]; fil: MessageFil[] } | null> {
  const demande = await prisma.demandeReservation.findFirst({ where: { AND: [{ id: demandeId }, clauseFichesVisibles(user)] } });
  if (!demande) return null;
  const { lignes, fils } = await lignesDesDemandes([demande], true);
  const ligne = lignes[0];
  if (!ligne) return null;
  const voisines = ligne.itemId
    ? await prisma.demandeReservation.findMany({
        where: { itemId: ligne.itemId, demandeurId: ligne.demandeurId, id: { not: ligne.demandeId }, etat: { in: ["ENVOYEE", "PRISE"] } },
        orderBy: { envoyeeLe: "asc" }, take: 50,
      })
    : [];
  const freres = voisines.length
    ? (await lignesDesDemandes(voisines, false)).lignes.filter((x) => x.itemId === ligne.itemId && (x.etat === "ENVOYEE" || x.etat === "PRISE"))
    : [];
  return { ligne, freres, fil: ligne.sujet ? fils[ligne.sujet.id] ?? [] : [] };
}
