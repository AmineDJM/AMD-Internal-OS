import type { CareBeneficiaryStatus, CareCurrency, CareServiceKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { toNumber } from "@/lib/utils";
import { canAccessEntity } from "@/lib/entity-access";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { lienFichierEmis } from "@/lib/lecteurs/fichiers-emis";
import { LIBELLE_ETAT_BUREAU, type EtatBureau, type LigneBureau } from "@/lib/secretariat/ligne-bureau";
import {
  estDirectionMarketing, etatDuPoste, etatDuProfessionnel, detailDuPoste, nomCourtDuPoste, phraseCircuitBc, prixAValider, refusPaiementDuBc,
  resteAMettreEnBc, montantEngage, totalAPayer, tientLesMontants, etapeDuCircuitBc, type EtatLu, type EtapeCircuitBc, type LigneAchat, type StatutLigneAchat,
} from "../../domaine/prise-en-charge/achats";
import { beneficiaryName, beneficiarySubtitle } from "../../domaine/prise-en-charge/regles";
import { deviseDuPoste, tauxDeLaDemande } from "../../domaine/prise-en-charge/fiches";
import { type Scope, SPEC, CELL_FICHE_SELECT, parentWhere, versCellRow } from "../prise-en-charge/actions-commun";
import { lignesDesPostes, type LigneLue } from "../prise-en-charge/achats";
import { solliciteePourLesDevis } from "../prise-en-charge/devis-acces";
import { demandePrevalidee } from "../prise-en-charge/engagement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LES LECTURES DU CIRCUIT D'ACHAT (Super Admin, 24/11/2026) : la fiche (« À vous », professionnels,
 * bons de commande, historique des prix), la page « Chiffrer », la page « Acheter — BC n°k », et les deux familles de
 * lignes du bureau du secrétariat (`LigneBureau`) : « Chiffrage » et « Achat — BC n°k ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number | null => (v == null ? null : toNumber(v as never));
const rolesDe = (u: Pick<SessionUser, "role"> & { secondaryRole?: string | null }) => [u.role, u.secondaryRole].filter((r): r is string => Boolean(r));
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « 12 → 14 déc. », « 30 nov. → 2 déc. », ou un seul jour. */
export function datesCourtes(debut: Date | null, fin: Date | null): string | null {
  if (!debut) return null;
  const j = (d: Date) => `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
  if (!fin || fin.toISOString().slice(0, 10) === debut.toISOString().slice(0, 10)) return j(debut);
  return debut.getUTCMonth() === fin.getUTCMonth() ? `${debut.getUTCDate()} → ${j(fin)}` : `${j(debut)} → ${j(fin)}`;
}

/** La demande, quel que soit son périmètre : nom, dates, demandeur, référent DM, circuit. */
async function lireDemande(scope: Scope, id: string) {
  const sel = { id: true, name: true, requesterId: true, productManagerId: true, endDate: true, city: true, circuitAchatAt: true, careReservationDossierId: true, usdDzdRate: true } as const;
  if (scope === "NATIONAL") {
    const r = await prisma.congressNational.findUnique({ where: { id }, select: { ...sel, date: true } });
    return r ? { ...r, debut: r.date } : null;
  }
  const r = await prisma.congressInternational.findUnique({ where: { id }, select: { ...sel, startDate: true } });
  return r ? { ...r, debut: r.startDate } : null;
}

// ───────────────────────────── Les portes ─────────────────────────────

/** LA DIRECTION MARKETING SUR CETTE DEMANDE : son rôle (ou le Super Admin), et la fiche qu'elle voit. */
export async function pilotePriseEnCharge(user: SessionUser, scope: Scope, requestId: string): Promise<boolean> {
  if (!estDirectionMarketing(rolesDe(user))) return false;
  return hasRole(user, "SUPER_ADMIN") || canAccessEntity(user, SPEC[scope].module, requestId, "VIEW");
}

/** QUI TIENT LES MONTANTS : la Direction Marketing (sur sa fiche), l'assistante sollicitée pour cette prise en charge. */
export async function tientLesMontantsDe(user: SessionUser, scope: Scope, requestId: string): Promise<boolean> {
  if (!tientLesMontants(rolesDe(user))) return false;
  if (await pilotePriseEnCharge(user, scope, requestId)) return true;
  return solliciteePourLesDevis(user, scope, requestId);
}

// ───────────────────────────── La fiche de la prise en charge ─────────────────────────────

export interface PosteAchatVue { id: string; nom: string; serviceKind: CareServiceKind | null; detail: string; prixDzd: number | null; valideDzd: number | null; etat: EtatLu }
export interface ProfessionnelAchatVue {
  id: string; nom: string; sousTitre: string | null; statut: CareBeneficiaryStatus; retire: boolean;
  postes: PosteAchatVue[]; montant: number | null; etat: EtatLu; aValider: boolean;
  /** Les lignes retirées après achat qui attendent « Remboursé ? ». */
  remboursements: { ligneId: string; libelle: string; montant: number }[];
}
export interface BcAchatVue {
  id: string; numero: number; reference: string | null; contenu: string; montant: number; etape: EtapeCircuitBc; phrase: string;
  pdf: string | null; signeDm: boolean; lienAchat: string;
  lignes: { id: string; libelle: string; montant: number; statut: StatutLigneAchat }[];
}
export interface PrixHistoriqueVue { quand: string; qui: string | null; poste: string; ancien: number | null; nouveau: number | null; motif: string }
export interface VueAchatsPec {
  circuit: boolean;
  peut: { piloter: boolean; montants: boolean; retirerAvantPrevalidation: boolean };
  professionnels: ProfessionnelAchatVue[];
  aValider: { ids: string[]; total: number; noms: string[] };
  prochainBc: { postes: number; total: number };
  bcs: BcAchatVue[];
  chiffrage: { etat: string; demandeLe: string } | null;
  historique: PrixHistoriqueVue[];
  engage: number;
}

const toLigneAchat = (l: LigneLue): LigneAchat => l;

/** LA FICHE : professionnels et leur état, « À vous » de la Direction Marketing, BC, historique des prix. */
export async function vueAchatsPec(user: SessionUser, scope: Scope, requestId: string): Promise<VueAchatsPec> {
  const req = await lireDemande(scope, requestId);
  // UNE DEMANDE D'AVANT LE CIRCUIT garde son écran : rien à lire de plus.
  if (!req?.circuitAchatAt) {
    return {
      circuit: false, peut: { piloter: false, montants: false, retirerAvantPrevalidation: false }, professionnels: [],
      aValider: { ids: [], total: 0, noms: [] }, prochainBc: { postes: 0, total: 0 }, bcs: [], chiffrage: null, historique: [], engage: 0,
    };
  }
  const [rows, chiffrage, bcs, piloter, montants, prevalidee] = await Promise.all([
    prisma.careBeneficiary.findMany({
      where: parentWhere(scope, requestId),
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, doctorId: true, firstName: true, lastName: true, jobTitle: true, institution: true, status: true,
        cells: { where: { kind: "SERVICE" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { ...CELL_FICHE_SELECT, montantValideDzd: true, chiffreLe: true } },
      },
    }),
    prisma.careChiffrage.findFirst({ where: { ...parentWhere(scope, requestId), etat: { in: ["A_PRENDRE", "EN_COURS"] } }, orderBy: { demandeLe: "asc" } }),
    prisma.carePecBc.findMany({ where: parentWhere(scope, requestId), orderBy: { numero: "asc" }, select: { id: true, numero: true, legalDocumentId: true, expenseOrderId: true } }),
    pilotePriseEnCharge(user, scope, requestId),
    tientLesMontantsDe(user, scope, requestId),
    demandePrevalidee(scope, requestId),
  ]);
  const docIds = rows.map((r) => r.doctorId).filter((x): x is string => Boolean(x));
  const docs = docIds.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(docs.map((d) => [d.id, d.name]));
  const cellIds = rows.flatMap((r) => r.cells.map((c) => c.id));
  const lignes = await lignesDesPostes(cellIds);
  const enChiffrage = (bId: string) => Boolean(chiffrage && (chiffrage.tous || chiffrage.beneficiaryIds.includes(bId)));

  const aValider = { ids: [] as string[], total: 0, noms: [] as string[] };
  let prochain = { postes: 0, total: 0 };
  let engage = 0;
  const pros: ProfessionnelAchatVue[] = rows.map((r) => {
    const ident = { ...r, doctorName: r.doctorId ? nomDe.get(r.doctorId) ?? null : null };
    const nom = beneficiaryName(ident);
    const retire = r.status === "WITHDRAWN" || r.status === "REJECTED";
    const postes: PosteAchatVue[] = [];
    const faitsPostes: Parameters<typeof etatDuPoste>[0][] = [];
    let montant: number | null = null;
    let aValiderPro = false;
    const remboursements: ProfessionnelAchatVue["remboursements"] = [];
    for (const c of r.cells.filter((x) => x.status !== "WAIVED")) {
      const ls = (lignes.get(c.id) ?? []).map(toLigneAchat);
      const faits = { chiffre: c.chiffreLe != null, prixDzd: num(c.amountDzd), valideDzd: num(c.montantValideDzd), enChiffrage: enChiffrage(r.id), lignes: ls };
      const etat = etatDuPoste(faits);
      faitsPostes.push(faits);
      postes.push({ id: c.id, nom: nomCourtDuPoste(c.serviceKind), serviceKind: c.serviceKind, detail: detailDuPoste(versCellRow(c)), prixDzd: faits.prixDzd, valideDzd: faits.valideDzd, etat });
      const m = montantEngage({ actif: !retire, chiffre: faits.chiffre, prixDzd: faits.prixDzd, lignes: ls });
      if (m > 0) montant = (montant ?? 0) + m;
      engage += m;
      if (!retire && prixAValider(faits)) {
        aValiderPro = true;
        aValider.total += faits.prixDzd ?? 0;
      }
      if (!retire && r.status === "APPROVED") {
        const reste = resteAMettreEnBc(faits.valideDzd, ls);
        if (reste > 0) prochain = { postes: prochain.postes + 1, total: prochain.total + reste };
      }
      for (const l of lignes.get(c.id) ?? []) {
        if (l.statut === "RETIREE_APRES_ACHAT" && l.rembourse == null) remboursements.push({ ligneId: l.id, libelle: l.libelle, montant: l.montantAchatDzd ?? l.montantDzd });
      }
    }
    if (aValiderPro) { aValider.ids.push(r.id); aValider.noms.push(nom); }
    return {
      id: r.id, nom, sousTitre: beneficiarySubtitle(ident), statut: r.status, retire, postes, montant: montant == null ? null : Math.round(montant * 100) / 100,
      etat: etatDuProfessionnel({ retire, enChiffrage: enChiffrage(r.id), postes: faitsPostes }),
      aValider: aValiderPro, remboursements,
    };
  });

  // LES BC : leur étape (circuit des BC), la signature de la Direction Marketing, le paiement.
  const legalIds = bcs.map((b) => b.legalDocumentId).filter((x): x is string => Boolean(x));
  const [etats, sigsDm, ordres, docsBc] = await Promise.all([
    etatsDesBC(legalIds),
    legalIds.length ? prisma.signatureBC.findMany({ where: { legalDocumentId: { in: legalIds }, qualite: "DIRECTION_MARKETING" }, select: { legalDocumentId: true } }) : Promise.resolve([]),
    prisma.expenseOrder.findMany({ where: { id: { in: bcs.map((b) => b.expenseOrderId).filter((x): x is string => Boolean(x)) } }, select: { id: true, status: true } }),
    legalIds.length ? prisma.legalDocument.findMany({ where: { id: { in: legalIds } }, select: { id: true, custom: true } }) : Promise.resolve([]),
  ]);
  const dmSigne = new Set(sigsDm.map((s) => s.legalDocumentId));
  const statutOrdre = new Map(ordres.map((o) => [o.id, o.status]));
  const aPdf = new Set(docsBc.filter((d) => Boolean((d.custom as { fabrique?: { pdf?: { nodeId?: string } } } | null)?.fabrique?.pdf?.nodeId)).map((d) => d.id));
  const lignesParBc = new Map<string, LigneLue[]>();
  for (const ls of lignes.values()) for (const l of ls) lignesParBc.set(l.bcId, [...(lignesParBc.get(l.bcId) ?? []), l]);
  const nomDuPro = new Map(pros.flatMap((p) => p.postes.map((c) => [c.id, p.nom] as const)));
  const vuesBc: BcAchatVue[] = bcs.map((b) => {
    const ls = lignesParBc.get(b.id) ?? [];
    const e = b.legalDocumentId ? etats.get(b.legalDocumentId) : undefined;
    const faits = {
      annule: Boolean(e?.annule), signeDm: Boolean(b.legalDocumentId && dmSigne.has(b.legalDocumentId)), etapeBc: e?.etape ?? "HORS_CIRCUIT",
      lignesActives: ls.filter((l) => l.statut === "ACTIVE").length, paiementDemande: b.expenseOrderId != null,
      paye: b.expenseOrderId ? statutOrdre.get(b.expenseOrderId) === "PAID" : false,
    };
    const qui = new Set(ls.map((l) => nomDuPro.get(l.cellId) ?? l.cellId));
    const retires = new Set(ls.filter((l) => l.statut === "RETIREE_AVANT_ACHAT").map((l) => nomDuPro.get(l.cellId) ?? l.cellId));
    const vivants = [...qui].filter((n) => !retires.has(n) || ls.some((l) => (nomDuPro.get(l.cellId) ?? l.cellId) === n && l.statut !== "RETIREE_AVANT_ACHAT"));
    return {
      id: b.id, numero: b.numero, reference: e?.reference ?? null,
      contenu: `${vivants.length} professionnel${vivants.length > 1 ? "s" : ""}${retires.size ? ` (${retires.size} retiré${retires.size > 1 ? "s" : ""} avant achat)` : ""}`,
      montant: Math.round(ls.filter((l) => l.statut !== "RETIREE_AVANT_ACHAT").reduce((s, l) => s + (l.montantAchatDzd ?? l.montantDzd) * 100, 0)) / 100,
      etape: etapeDuCircuitBc(faits), phrase: phraseCircuitBc(faits),
      pdf: b.legalDocumentId && aPdf.has(b.legalDocumentId) ? lienFichierEmis(b.legalDocumentId, "pdf") : null,
      signeDm: faits.signeDm, lienAchat: `${SPEC[scope].path}/${requestId}/achat/${b.numero}`,
      lignes: ls.map((l) => ({ id: l.id, libelle: l.libelle, montant: l.montantAchatDzd ?? l.montantDzd, statut: l.statut })),
    };
  });

  const histo = cellIds.length
    ? await prisma.carePrixHistorique.findMany({ where: { cellId: { in: cellIds } }, orderBy: { createdAt: "desc" }, take: 60 })
    : [];
  const auteurs = await prisma.user.findMany({ where: { id: { in: [...new Set(histo.map((h) => h.auteurId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } });
  const nomAuteur = new Map(auteurs.map((a) => [a.id, a.name]));
  const posteDe = new Map(pros.flatMap((p) => p.postes.map((c) => [c.id, `${p.nom} — ${c.nom}`] as const)));

  return {
    circuit: Boolean(req?.circuitAchatAt),
    peut: { piloter, montants, retirerAvantPrevalidation: !prevalidee && req?.requesterId === user.id },
    professionnels: pros,
    aValider: { ...aValider, total: Math.round(aValider.total * 100) / 100 },
    prochainBc: { postes: prochain.postes, total: Math.round(prochain.total * 100) / 100 },
    bcs: vuesBc,
    chiffrage: chiffrage ? { etat: chiffrage.etat, demandeLe: chiffrage.demandeLe.toISOString() } : null,
    historique: histo.map((h) => ({
      quand: h.createdAt.toISOString(), qui: h.auteurId ? nomAuteur.get(h.auteurId) ?? null : null, poste: posteDe.get(h.cellId) ?? "—",
      ancien: num(h.ancienDzd), nouveau: num(h.nouveauDzd), motif: h.motif,
    })),
    engage: Math.round(engage * 100) / 100,
  };
}

// ───────────────────────────── La page « Chiffrer » ─────────────────────────────

export interface LigneChiffrageVue {
  cellId: string; pro: string; poste: string; detail: string; devise: CareCurrency;
  montant: number | null; montantDzd: number | null; piece: { id: string; name: string } | null; dejaEnBc: boolean;
}
export interface PageChiffrageVue {
  scope: Scope; requestId: string; nom: string; dates: string | null; ville: string | null; taux: number | null;
  chiffrage: { id: string; etat: string; demandeLe: string; demandePar: string | null; tous: boolean } | null;
  /** L'état dans le vocabulaire du bureau du secrétariat (« À prendre », « En cours », « Terminée »). */
  etatLibelle: string;
  lignes: LigneChiffrageVue[];
}

/** LA GRILLE DE CHIFFRAGE : professionnel × poste × détail × montant × pièce — ce que la demande ouverte couvre (ou tout). */
export async function pageChiffrage(scope: Scope, requestId: string): Promise<PageChiffrageVue | null> {
  const req = await lireDemande(scope, requestId);
  if (!req) return null;
  const chiffrage = await prisma.careChiffrage.findFirst({ where: { ...parentWhere(scope, requestId), etat: { in: ["A_PRENDRE", "EN_COURS"] } }, orderBy: { demandeLe: "asc" } });
  const rows = await prisma.careBeneficiary.findMany({
    where: { ...parentWhere(scope, requestId), status: { in: ["PROPOSED", "APPROVED"] }, ...(chiffrage && !chiffrage.tous ? { id: { in: chiffrage.beneficiaryIds } } : {}) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, doctorId: true, firstName: true, lastName: true,
      cells: { where: { kind: "SERVICE", status: { not: "WAIVED" }, expenseOrderId: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { ...CELL_FICHE_SELECT, chiffragePieceId: true } },
    },
  });
  const docIds = rows.map((r) => r.doctorId).filter((x): x is string => Boolean(x));
  const docs = docIds.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(docs.map((d) => [d.id, d.name]));
  const lignes = await lignesDesPostes(rows.flatMap((r) => r.cells.map((c) => c.id)));
  const pieceIds = rows.flatMap((r) => r.cells.map((c) => c.chiffragePieceId)).filter((x): x is string => Boolean(x));
  const pieces = pieceIds.length ? await prisma.document.findMany({ where: { id: { in: pieceIds } }, select: { id: true, name: true } }) : [];
  const pieceDe = new Map(pieces.map((p) => [p.id, p]));
  const demandePar = chiffrage?.demandeParId ? await prisma.user.findUnique({ where: { id: chiffrage.demandeParId }, select: { name: true } }) : null;
  const out: LigneChiffrageVue[] = [];
  for (const r of rows) {
    const pro = beneficiaryName({ ...r, doctorName: r.doctorId ? nomDe.get(r.doctorId) ?? null : null });
    for (const c of r.cells) {
      const ls = lignes.get(c.id) ?? [];
      // « Tout ce qui n'est pas encore acheté » : un poste entièrement acheté (ou retiré) sort de la grille.
      if (ls.length > 0 && ls.every((l) => l.statut !== "ACTIVE")) continue;
      out.push({
        cellId: c.id, pro, poste: nomCourtDuPoste(c.serviceKind), detail: detailDuPoste(versCellRow(c)),
        devise: deviseDuPoste(scope, c.serviceKind ?? "OTHER"), montant: num(c.amount) ?? (c.currency === "DZD" ? num(c.amountDzd) : null), montantDzd: num(c.amountDzd),
        piece: c.chiffragePieceId ? pieceDe.get(c.chiffragePieceId) ?? null : null, dejaEnBc: ls.some((l) => l.statut === "ACTIVE"),
      });
    }
  }
  return {
    scope, requestId, nom: req.name, dates: datesCourtes(req.debut, req.endDate), ville: req.city ?? null, taux: tauxDeLaDemande(scope, num(req.usdDzdRate)),
    chiffrage: chiffrage ? { id: chiffrage.id, etat: chiffrage.etat, demandeLe: chiffrage.demandeLe.toISOString(), demandePar: demandePar?.name ?? null, tous: chiffrage.tous } : null,
    etatLibelle: LIBELLE_ETAT_BUREAU[ETAT_CHIFFRAGE[chiffrage?.etat ?? "TERMINEE"] ?? "TERMINEE"],
    lignes: out,
  };
}

// ───────────────────────────── La page « Acheter — BC n°k » ─────────────────────────────

export interface LigneAchatVue {
  id: string; cellId: string; libelle: string; serviceKind: CareServiceKind | null; montantDzd: number; montantAchatDzd: number | null;
  statut: StatutLigneAchat; rembourse: boolean | null; rembourseDzd: number | null; billet: { id: string; reference: string | null } | null;
}
export interface PageAchatVue {
  scope: Scope; requestId: string; nom: string; dates: string | null; bcId: string; numero: number; reference: string | null; pdf: string | null;
  signeFinances: boolean; phrase: string; lignes: LigneAchatVue[]; aPayer: number; refusPaiement: string | null;
  paiement: { demande: boolean; reference: string | null; statut: string | null };
}

/** LA PAGE D'ACHAT D'UN BC : ses lignes (et elles seules), les dépôts, le retrait, le paiement. */
export async function pageAchat(scope: Scope, requestId: string, numero: number): Promise<PageAchatVue | null> {
  const req = await lireDemande(scope, requestId);
  if (!req) return null;
  const bc = await prisma.carePecBc.findFirst({ where: { ...parentWhere(scope, requestId), numero }, select: { id: true, legalDocumentId: true, expenseOrderId: true } });
  if (!bc?.legalDocumentId) return null;
  const [etat, dm, rows, ordre, piece] = await Promise.all([
    etatsDesBC([bc.legalDocumentId]).then((m) => m.get(bc.legalDocumentId!) ?? null),
    prisma.signatureBC.count({ where: { legalDocumentId: bc.legalDocumentId, qualite: "DIRECTION_MARKETING" } }),
    prisma.carePecBcLigne.findMany({ where: { bcId: bc.id }, orderBy: { createdAt: "asc" }, select: { id: true, cellId: true, libelle: true, montantDzd: true, montantAchatDzd: true, statut: true, rembourse: true, rembourseDzd: true, cell: { select: { serviceKind: true, issuedDocumentId: true, bookingRef: true } } } }),
    bc.expenseOrderId ? prisma.expenseOrder.findUnique({ where: { id: bc.expenseOrderId }, select: { reference: true, status: true } }) : Promise.resolve(null),
    prisma.legalDocument.findUnique({ where: { id: bc.legalDocumentId }, select: { custom: true, signedAt: true, status: true } }),
  ]);
  const signeFinances = Boolean(piece?.signedAt) && piece?.status !== "CANCELLED";
  const lignes: LigneAchatVue[] = rows.map((r) => ({
    id: r.id, cellId: r.cellId, libelle: r.libelle, serviceKind: r.cell.serviceKind, montantDzd: num(r.montantDzd) ?? 0, montantAchatDzd: num(r.montantAchatDzd),
    statut: r.statut, rembourse: r.rembourse, rembourseDzd: num(r.rembourseDzd),
    billet: r.cell.issuedDocumentId ? { id: r.cell.issuedDocumentId, reference: r.cell.bookingRef } : null,
  }));
  const pures: LigneAchat[] = lignes.map((l) => ({ bcNumero: numero, statut: l.statut, montantDzd: l.montantDzd, montantAchatDzd: l.montantAchatDzd, rembourse: l.rembourse, rembourseDzd: l.rembourseDzd, bcSigneFinances: signeFinances }));
  const faits = {
    annule: piece?.status === "CANCELLED", signeDm: dm > 0, etapeBc: etat?.etape ?? "HORS_CIRCUIT", lignesActives: lignes.filter((l) => l.statut === "ACTIVE").length,
    paiementDemande: bc.expenseOrderId != null, paye: ordre?.status === "PAID",
  };
  return {
    scope, requestId, nom: req.name, dates: datesCourtes(req.debut, req.endDate), bcId: bc.id, numero, reference: etat?.reference ?? null,
    pdf: (piece?.custom as { fabrique?: { pdf?: { nodeId?: string } } } | null)?.fabrique?.pdf?.nodeId ? lienFichierEmis(bc.legalDocumentId, "pdf") : null,
    signeFinances, phrase: phraseCircuitBc(faits), lignes, aPayer: totalAPayer(pures),
    refusPaiement: refusPaiementDuBc({ signeFinances, paiementDemande: faits.paiementDemande, facture: true, lignes: pures }),
    paiement: { demande: faits.paiementDemande, reference: ordre?.reference ?? null, statut: ordre?.status ?? null },
  };
}

// ───────────────────────────── Le bureau du secrétariat ─────────────────────────────

const ETAT_CHIFFRAGE: Record<string, EtatBureau> = { A_PRENDRE: "A_PRENDRE", EN_COURS: "EN_COURS", TERMINEE: "TERMINEE", ANNULEE: "ANNULEE" };
/** Ce que le bureau garde des lignes terminées : les plus récentes, pas l'historique entier. */
const TERMINEES_MAX = 200;

/** Le secrétariat et le Super Admin voient toutes les lignes ; un demandeur ordinaire, les siennes (DECISIONS, Secrétariat). */
const voitTout = (user: SessionUser) => hasRole(user, "DIRECTION_ASSISTANT") || hasRole(user, "SUPER_ADMIN");

async function nomsDesPersonnes(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const vrais = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (vrais.length === 0) return new Map();
  const us = await prisma.user.findMany({ where: { id: { in: vrais } }, select: { id: true, name: true } });
  return new Map(us.map((u) => [u.id, u.name]));
}

const DEMANDE_SEL = { id: true, name: true, requesterId: true, endDate: true } as const;

/** LES LIGNES « CHIFFRAGE » DU BUREAU — une par demande de chiffrage. */
export async function lignesBureauPecChiffrage(user: SessionUser): Promise<LigneBureau[]> {
  const tout = voitTout(user);
  const filtre = tout ? {} : { OR: [{ demandeParId: user.id }, { congressNational: { requesterId: user.id } }, { congressInternational: { requesterId: user.id } }] };
  const [ouvertes, closes] = await Promise.all([
    prisma.careChiffrage.findMany({
      where: { ...filtre, etat: { in: ["A_PRENDRE", "EN_COURS"] } },
      include: { congressNational: { select: { ...DEMANDE_SEL, date: true } }, congressInternational: { select: { ...DEMANDE_SEL, startDate: true } } },
    }),
    prisma.careChiffrage.findMany({
      where: { ...filtre, etat: { in: ["TERMINEE", "ANNULEE"] } }, orderBy: { updatedAt: "desc" }, take: TERMINEES_MAX,
      include: { congressNational: { select: { ...DEMANDE_SEL, date: true } }, congressInternational: { select: { ...DEMANDE_SEL, startDate: true } } },
    }),
  ]);
  const toutes = [...ouvertes, ...closes];
  const noms = await nomsDesPersonnes(toutes.flatMap((c) => [c.demandeParId, c.priseParId, c.congressNational?.requesterId ?? c.congressInternational?.requesterId ?? null]));
  return toutes.flatMap((c): LigneBureau[] => {
    const nat = c.congressNational;
    const inter = c.congressInternational;
    const d = nat ?? inter;
    if (!d) return [];
    const scope: Scope = nat ? "NATIONAL" : "INTERNATIONAL";
    const debut = nat ? nat.date : inter!.startDate;
    const n = c.tous ? null : c.beneficiaryIds.length;
    const etat = ETAT_CHIFFRAGE[c.etat] ?? "A_PRENDRE";
    return [{
      cle: `pec-chiffrage:${c.id}`, famille: "pec-chiffrage", type: "Chiffrage",
      objet: `Chiffrer — ${d.name}`, reference: c.tous ? "Actualiser les prix" : `${n} professionnel${n && n > 1 ? "s" : ""} à chiffrer`,
      demandeur: noms.get(c.demandeParId ?? "") ?? noms.get(d.requesterId ?? "") ?? null,
      dates: datesCourtes(debut, d.endDate), etat,
      chezQui: etat === "A_PRENDRE" ? "Assistante de direction" : etat === "EN_COURS" ? (noms.get(c.priseParId ?? "") ?? "Assistante de direction") : etat === "TERMINEE" ? "Direction Marketing · validation" : null,
      echeance: debut ? debut.toISOString() : null, depuis: (c.envoyeeLe ?? c.priseLe ?? c.demandeLe).toISOString(),
      href: `${SPEC[scope].path}/${d.id}/chiffrer`,
    }];
  });
}

/** LES LIGNES « ACHAT — BC n°k » DU BUREAU — de la signature des Finances à l'achat, puis au paiement. */
export async function lignesBureauPecAchat(user: SessionUser): Promise<LigneBureau[]> {
  const tout = voitTout(user);
  const filtre = tout ? {} : { OR: [{ congressNational: { requesterId: user.id } }, { congressInternational: { requesterId: user.id } }] };
  const bcs = await prisma.carePecBc.findMany({
    where: { ...filtre, legalDocumentId: { not: null } }, orderBy: { createdAt: "desc" }, take: 500,
    include: { congressNational: { select: { ...DEMANDE_SEL, date: true } }, congressInternational: { select: { ...DEMANDE_SEL, startDate: true } }, lignes: { select: { statut: true, rembourse: true } } },
  });
  const docs = await prisma.legalDocument.findMany({ where: { id: { in: bcs.map((b) => b.legalDocumentId!) }, signedAt: { not: null } }, select: { id: true, reference: true, signedAt: true, status: true } });
  const docDe = new Map(docs.map((d) => [d.id, d]));
  const ordres = await prisma.expenseOrder.findMany({ where: { id: { in: bcs.map((b) => b.expenseOrderId).filter((x): x is string => Boolean(x)) } }, select: { id: true, status: true } });
  const statutOrdre = new Map(ordres.map((o) => [o.id, o.status]));
  const noms = await nomsDesPersonnes(bcs.map((b) => b.congressNational?.requesterId ?? b.congressInternational?.requesterId ?? null));
  const out: LigneBureau[] = [];
  for (const b of bcs) {
    const doc = docDe.get(b.legalDocumentId!);
    const d = b.congressNational ?? b.congressInternational;
    if (!doc?.signedAt || !d) continue;
    const scope: Scope = b.congressNational ? "NATIONAL" : "INTERNATIONAL";
    const debut = b.congressNational ? b.congressNational.date : b.congressInternational!.startDate;
    const actives = b.lignes.filter((l) => l.statut === "ACTIVE").length;
    const achetees = b.lignes.filter((l) => l.statut === "ACHETEE").length;
    const ordre = b.expenseOrderId ? statutOrdre.get(b.expenseOrderId) : null;
    let etat: EtatBureau;
    let chezQui: string;
    if (doc.status === "CANCELLED") { etat = "ANNULEE"; chezQui = "—"; }
    else if (ordre === "PAID") { etat = "TERMINEE"; chezQui = "Payé"; }
    else if (b.expenseOrderId) { etat = "EN_PAIEMENT"; chezQui = "Centre de paiement → Finances"; }
    else if (actives > 0) { etat = achetees > 0 ? "EN_COURS" : "A_PRENDRE"; chezQui = "Assistante de direction · achat"; }
    else { etat = "EN_COURS"; chezQui = b.lignes.some((l) => l.rembourse == null && l.statut === "RETIREE_APRES_ACHAT") ? "Assistante de direction · remboursé ?" : "Assistante de direction · paiement à demander"; }
    out.push({
      cle: `pec-achat:${b.id}`, famille: "pec-achat", type: `Achat — BC n°${b.numero}`,
      objet: `Acheter — ${d.name}`, reference: doc.reference, demandeur: noms.get(d.requesterId ?? "") ?? null,
      dates: datesCourtes(debut, d.endDate), etat, chezQui, echeance: debut ? debut.toISOString() : null,
      depuis: doc.signedAt.toISOString(), href: `${SPEC[scope].path}/${d.id}/achat/${b.numero}`,
    });
  }
  return out;
}

// ───────────────────────────── La discussion des fiches de l'assistante ─────────────────────────────

export interface FilSujetVue {
  dossierId: string; reference: string;
  messages: { id: string; auteur: string | null; corps: string; quand: string; pieces: { id: string; nom: string }[] }[];
}

/**
 * LA DISCUSSION DES PAGES « CHIFFRER » ET « ACHETER » : le sujet de l'assistante pour cette prise en charge (celui où les
 * demandes de chiffrage s'écrivent) — messages et pièces. `null` tant qu'aucun sujet n'est ouvert.
 */
export async function filDuSujetPec(scope: Scope, requestId: string): Promise<FilSujetVue | null> {
  const req = await lireDemande(scope, requestId);
  if (!req?.careReservationDossierId) return null;
  const d = await prisma.dossier.findUnique({
    where: { id: req.careReservationDossierId },
    select: {
      id: true, reference: true,
      messages: { orderBy: { createdAt: "asc" }, take: 200, select: { id: true, body: true, createdAt: true, author: { select: { name: true } }, attachments: { select: { id: true, name: true } } } },
    },
  });
  if (!d) return null;
  return {
    dossierId: d.id, reference: d.reference,
    messages: d.messages.map((m) => ({ id: m.id, auteur: m.author?.name ?? null, corps: m.body, quand: m.createdAt.toISOString(), pieces: m.attachments.map((a) => ({ id: a.id, nom: a.name })) })),
  };
}
