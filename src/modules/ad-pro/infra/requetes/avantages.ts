import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { partPayee, type Avantage, type NatureAvantage } from "../../domaine/avantages";
import { CHEMIN_DEMANDE, demandeAbandonnee, estRoleMedecin, montantAttribuable, type TypeMedecinsConcernes } from "../../domaine/medecins-concernes";
import { effectifDeLaLigne, resteAMettreEnBc, type LigneAchat } from "../../domaine/prise-en-charge/achats";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES AVANTAGES AD & PRO ACCORDÉS AUX PROFESSIONNELS — la lecture du registre (Super Admin seul ; la garde est chez
 * l'appelant, `src/lib/queries/avantages.ts`). Rien n'est copié : tout se relit des tables du module.
 *
 *  • PRISES EN CHARGE (congrès nationaux et internationaux), case par case :
 *      – circuit d'achat par BC : PAYÉ = lignes achetées (achat réel) ; ENGAGÉ = payé + lignes dans un BC pas encore
 *        achetées + validé par la Direction Marketing pas encore mis en BC. Une ligne barrée ou retirée n'est pas un avantage ;
 *      – circuit d'avant : la case couverte par un devis accepté (son ordre de dépense) — PAYÉ quand l'ordre est réglé.
 *    Une personne écartée ou retirée n'a rien reçu ; un chiffrage seul n'est pas un avantage.
 *  • SPONSORING, ÉVÉNEMENTS, AUTRES DEMANDES, DOSSIERS DE MATÉRIEL : par les médecins concernés (`AdProMedecin`), au montant
 *    attribuable (`montantAttribuable`, la règle de la fiche du praticien) ; payé au prorata de ce que la demande a réglé
 *    (ordres des postes payés, dépenses historiques). Un sponsoring qui ne nomme son médecin qu'en texte libre tombe dans les
 *    non-rattachés, avec ce nom.
 * Une demande refusée ou annulée n'a rien accordé ; une demande sans rien d'accordé (aucun poste validé) non plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const NATURE_DU_SERVICE: Record<string, NatureAvantage> = { TICKET: "PEC_BILLET", HOTEL: "PEC_HOTEL", REGISTRATION: "PEC_INSCRIPTION" };
const NATURE_DU_LIEN: Partial<Record<TypeMedecinsConcernes, NatureAvantage>> = {
  SPONSORING: "SPONSORING", EVENT: "EVENEMENT", AD_PRO_OTHER: "AUTRE_AD_PRO", PROMO_MATERIAL: "MATERIEL_PROMO",
};
/** Le parent d'un poste, par nature de demande. Les congrès passent par leurs prises en charge. */
const PARENT_DU_POSTE = { SPONSORING: "sponsoringId", EVENT: "eventId", AD_PRO_OTHER: "otherRequestId", PROMO_MATERIAL: "promoMaterialParentId" } as const;
type NatureLien = keyof typeof PARENT_DU_POSTE;

const n = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));
const arrondi = (x: number) => Math.round(x * 100) / 100;
const iso = (d: Date) => d.toISOString();

const CONGRES = { id: true, name: true, companyId: true, requesterId: true, circuitAchatAt: true, requestStatus: true, createdAt: true } as const;

/** Les avantages des prises en charge — une ligne par case de service accordée. */
async function avantagesPriseEnCharge(): Promise<(Avantage & { demandeurId: string | null })[]> {
  const benefs = await prisma.careBeneficiary.findMany({
    where: { status: { notIn: ["REJECTED", "WITHDRAWN"] } },
    select: {
      id: true, doctorId: true, firstName: true, lastName: true,
      congressNational: { select: { ...CONGRES, date: true } },
      congressInternational: { select: { ...CONGRES, startDate: true } },
      cells: {
        where: { kind: "SERVICE", status: { not: "WAIVED" } },
        select: {
          id: true, serviceKind: true, label: true, dateStart: true, createdAt: true, amountDzd: true, quoteId: true, expenseOrderId: true,
          montantValideDzd: true,
          lignesBc: { select: { statut: true, montantDzd: true, montantAchatDzd: true, bc: { select: { numero: true } } } },
        },
      },
    },
  });

  // Le circuit d'avant : la part d'un devis accepté qui couvre plusieurs cases (sans montant propre), et l'état des ordres.
  const cellsV1 = benefs.flatMap((b) => b.cells).filter((c) => c.lignesBc.length === 0 && c.expenseOrderId);
  const quoteIds = [...new Set(cellsV1.filter((c) => c.amountDzd == null && c.quoteId).map((c) => c.quoteId!))];
  const ordreIds = [...new Set(cellsV1.map((c) => c.expenseOrderId!))];
  const [devis, parDevis, ordres] = await Promise.all([
    quoteIds.length ? prisma.careQuote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, amountDzd: true } }) : [],
    quoteIds.length ? prisma.careCell.groupBy({ by: ["quoteId"], where: { quoteId: { in: quoteIds } }, _count: { _all: true } }) : [],
    ordreIds.length ? prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, status: true } }) : [],
  ]);
  const montantDevis = new Map(devis.map((q) => [q.id, n(q.amountDzd)]));
  const casesDuDevis = new Map(parDevis.map((g) => [g.quoteId!, g._count._all]));
  const statutOrdre = new Map(ordres.map((o) => [o.id, o.status]));

  const out: (Avantage & { demandeurId: string | null })[] = [];
  for (const b of benefs) {
    const national = b.congressNational;
    const c = national ?? b.congressInternational;
    if (!c || c.requestStatus === "REJECTED" || c.requestStatus === "CANCELLED") continue;
    const dateCongres = (national ? national.date : b.congressInternational?.startDate) ?? null;
    const href = `${CHEMIN_DEMANDE[national ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL"]}/${c.id}`;
    const nomLibre = b.doctorId ? null : [b.firstName, b.lastName].filter(Boolean).join(" ").trim() || "Sans nom";
    for (const cell of b.cells) {
      let engage = 0;
      let paye = 0;
      let reference: string | null = null;
      if (cell.lignesBc.length > 0 || c.circuitAchatAt) {
        const lignes: LigneAchat[] = cell.lignesBc.map((l) => ({
          bcNumero: l.bc.numero, statut: l.statut, montantDzd: n(l.montantDzd), montantAchatDzd: l.montantAchatDzd == null ? null : n(l.montantAchatDzd),
          rembourse: null, rembourseDzd: null, bcSigneFinances: false,
        }));
        for (const l of lignes) {
          if (l.statut === "ACHETEE") paye += effectifDeLaLigne(l);
          else if (l.statut === "ACTIVE") engage += l.montantDzd;
        }
        engage += paye + resteAMettreEnBc(cell.montantValideDzd == null ? null : n(cell.montantValideDzd), lignes);
        const numeros = [...new Set(cell.lignesBc.filter((l) => l.statut === "ACTIVE" || l.statut === "ACHETEE").map((l) => l.bc.numero))].sort((x, y) => x - y);
        reference = numeros.length ? `BC n°${numeros.join(", ")}` : null;
      } else if (cell.expenseOrderId) {
        const statut = statutOrdre.get(cell.expenseOrderId);
        if (!statut || statut === "CANCELLED") continue;
        const part = cell.amountDzd != null ? n(cell.amountDzd)
          : cell.quoteId && casesDuDevis.get(cell.quoteId) ? (montantDevis.get(cell.quoteId) ?? 0) / casesDuDevis.get(cell.quoteId)! : 0;
        engage = part;
        paye = statut === "PAID" ? part : 0;
      }
      if (engage <= 0) continue;
      out.push({
        id: `pec:${cell.id}`, doctorId: b.doctorId, nomLibre, date: iso(cell.dateStart ?? dateCongres ?? cell.createdAt),
        nature: NATURE_DU_SERVICE[cell.serviceKind ?? ""] ?? "PEC_AUTRE",
        objet: `Congrès ${c.name} — ${cell.label}`, engageDzd: arrondi(engage), payeDzd: arrondi(paye),
        societeId: c.companyId, demandeur: null, demandeurId: c.requesterId, reference, href,
      });
    }
  }
  return out;
}

interface DemandeLue { id: string; objet: string; date: Date; statut: string; societeId: string | null; demandeurId: string | null; reference: string | null; accordeDemande: number | null; medecinLibre: string | null }

/** Les demandes désignées (ou sponsorings à médecin en texte libre), par nature. */
async function lireDemandes(ids: Record<NatureLien, string[]>, sponsoringsLibres: boolean): Promise<Map<string, DemandeLue>> {
  const [spo, ev, ao, pm] = await Promise.all([
    ids.SPONSORING.length || sponsoringsLibres ? prisma.sponsoringRequest.findMany({
      where: sponsoringsLibres ? { OR: [{ id: { in: ids.SPONSORING } }, { doctor: { not: null } }] } : { id: { in: ids.SPONSORING } },
      select: { id: true, reference: true, type: true, institution: true, doctor: true, requestDate: true, status: true, companyId: true, requesterId: true, amountGranted: true },
    }) : [],
    ids.EVENT.length ? prisma.event.findMany({ where: { id: { in: ids.EVENT } }, select: { id: true, name: true, startDate: true, createdAt: true, status: true, companyId: true, requesterId: true } }) : [],
    ids.AD_PRO_OTHER.length ? prisma.adProOtherRequest.findMany({ where: { id: { in: ids.AD_PRO_OTHER } }, select: { id: true, reference: true, title: true, createdAt: true, status: true, companyId: true, requesterId: true } }) : [],
    ids.PROMO_MATERIAL.length ? prisma.promoMaterial.findMany({ where: { id: { in: ids.PROMO_MATERIAL } }, select: { id: true, reference: true, title: true, createdAt: true, status: true, companyId: true, requesterId: true } }) : [],
  ]);
  const out = new Map<string, DemandeLue>();
  for (const s of spo) out.set(`SPONSORING:${s.id}`, {
    id: s.id, objet: `Sponsoring ${s.type} — ${s.institution}`.replace(/\s+/g, " "), date: s.requestDate, statut: String(s.status), societeId: s.companyId,
    demandeurId: s.requesterId, reference: s.reference, accordeDemande: s.amountGranted == null ? null : n(s.amountGranted), medecinLibre: s.doctor?.trim() || null,
  });
  for (const e of ev) out.set(`EVENT:${e.id}`, { id: e.id, objet: e.name, date: e.startDate ?? e.createdAt, statut: String(e.status), societeId: e.companyId, demandeurId: e.requesterId, reference: null, accordeDemande: null, medecinLibre: null });
  for (const a of ao) out.set(`AD_PRO_OTHER:${a.id}`, { id: a.id, objet: a.title, date: a.createdAt, statut: String(a.status), societeId: a.companyId, demandeurId: a.requesterId, reference: a.reference, accordeDemande: null, medecinLibre: null });
  for (const p of pm) out.set(`PROMO_MATERIAL:${p.id}`, { id: p.id, objet: p.title, date: p.createdAt, statut: String(p.status), societeId: p.companyId, demandeurId: p.requesterId, reference: p.reference, accordeDemande: null, medecinLibre: null });
  return out;
}

/** L'argent d'une demande : ce qu'elle a accordé (postes validés, dépenses historiques) et ce qu'elle a réglé. */
async function argentDesDemandes(ids: Record<NatureLien, string[]>): Promise<Map<string, { accorde: number; paye: number }>> {
  const ou = (Object.keys(PARENT_DU_POSTE) as NatureLien[]).filter((k) => ids[k].length).map((k) => ({ [PARENT_DU_POSTE[k]]: { in: ids[k] } }));
  const out = new Map<string, { accorde: number; paye: number }>();
  if (ou.length === 0) return out;
  const postes = await prisma.adProItem.findMany({
    where: { AND: [{ OR: ou }, { OR: [{ status: "APPROVED" }, { historiqueLotId: { not: null } }] }] },
    select: {
      sponsoringId: true, eventId: true, otherRequestId: true, promoMaterialParentId: true,
      amountGranted: true, amountEstimated: true, expenseOrderId: true, historiqueLotId: true, montantPayeHistorique: true,
    },
  });
  const ordreIds = [...new Set(postes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x)))];
  const ordres = ordreIds.length ? await prisma.expenseOrder.findMany({ where: { id: { in: ordreIds }, status: "PAID" }, select: { id: true, amount: true } }) : [];
  const regle = new Map(ordres.map((o) => [o.id, n(o.amount)]));
  for (const p of postes) {
    const k = p.sponsoringId ? `SPONSORING:${p.sponsoringId}` : p.eventId ? `EVENT:${p.eventId}` : p.otherRequestId ? `AD_PRO_OTHER:${p.otherRequestId}` : `PROMO_MATERIAL:${p.promoMaterialParentId}`;
    const a = out.get(k) ?? out.set(k, { accorde: 0, paye: 0 }).get(k)!;
    if (p.historiqueLotId) {
      // Une dépense historique est déjà réalisée et payée, hors de tout circuit.
      a.accorde += n(p.montantPayeHistorique);
      a.paye += n(p.montantPayeHistorique);
    } else {
      a.accorde += n(p.amountGranted ?? p.amountEstimated);
      a.paye += p.expenseOrderId ? regle.get(p.expenseOrderId) ?? 0 : 0;
    }
  }
  return out;
}

/** Les avantages des demandes qui désignent des praticiens (et des sponsorings à médecin en texte libre). */
async function avantagesDesDemandes(): Promise<(Avantage & { demandeurId: string | null })[]> {
  const liens = await prisma.adProMedecin.findMany({
    where: { entityType: { in: Object.keys(PARENT_DU_POSTE) } },
    select: { id: true, entityType: true, entityId: true, doctorId: true, role: true, montant: true },
  });
  const ids: Record<NatureLien, string[]> = { SPONSORING: [], EVENT: [], AD_PRO_OTHER: [], PROMO_MATERIAL: [] };
  const nombre = new Map<string, number>();
  for (const l of liens) {
    const k = l.entityType as NatureLien;
    ids[k].push(l.entityId);
    nombre.set(`${k}:${l.entityId}`, (nombre.get(`${k}:${l.entityId}`) ?? 0) + 1);
  }
  for (const k of Object.keys(ids) as NatureLien[]) ids[k] = [...new Set(ids[k])];
  const demandes = await lireDemandes(ids, true);
  // Les sponsorings à médecin libre entrent aussi dans le calcul de l'argent.
  ids.SPONSORING = [...new Set([...ids.SPONSORING, ...[...demandes.values()].filter((d) => d.medecinLibre && !nombre.has(`SPONSORING:${d.id}`)).map((d) => d.id)])];
  const argent = await argentDesDemandes(ids);

  const accordeDe = (k: string, d: DemandeLue) => {
    const a = argent.get(k);
    return { accorde: d.accordeDemande ?? a?.accorde ?? 0, paye: a?.paye ?? 0 };
  };
  const out: (Avantage & { demandeurId: string | null })[] = [];
  const base = (k: NatureLien, d: DemandeLue) => ({
    date: iso(d.date), nature: NATURE_DU_LIEN[k]!, societeId: d.societeId, demandeur: null, demandeurId: d.demandeurId,
    reference: d.reference, href: `${CHEMIN_DEMANDE[k]}/${d.id}`,
  });
  for (const l of liens) {
    const k = l.entityType as NatureLien;
    const d = demandes.get(`${k}:${l.entityId}`);
    if (!d || demandeAbandonnee(d.statut)) continue;
    const { accorde, paye } = accordeDe(`${k}:${d.id}`, d);
    if (accorde <= 0 && paye <= 0) continue;
    const nb = nombre.get(`${k}:${d.id}`) ?? 1;
    const attribue = montantAttribuable({ montant: l.montant == null ? null : n(l.montant) }, { nature: k, montantAccorde: accorde, nbMedecins: nb });
    const role = estRoleMedecin(l.role) && l.role === "ORATEUR" ? " (orateur)" : "";
    out.push({
      ...base(k, d), id: `lien:${l.id}`, doctorId: l.doctorId, nomLibre: null, objet: `${d.objet}${role}`,
      engageDzd: attribue == null ? null : arrondi(attribue),
      payeDzd: attribue == null ? null : partPayee(attribue, Math.max(accorde, paye), paye),
      note: attribue == null ? `Non réparti : ${Math.round(accorde).toLocaleString("fr-FR")} DZD accordés pour ${nb} professionnels` : null,
    });
  }
  // Le médecin d'un sponsoring nommé en texte libre seulement : non rattaché, avec ce nom — il reçoit tout l'accordé.
  for (const d of demandes.values()) {
    if (!d.medecinLibre || nombre.has(`SPONSORING:${d.id}`) || demandeAbandonnee(d.statut)) continue;
    const { accorde, paye } = accordeDe(`SPONSORING:${d.id}`, d);
    if (accorde <= 0 && paye <= 0) continue;
    out.push({
      ...base("SPONSORING", d), id: `spo:${d.id}`, doctorId: null, nomLibre: d.medecinLibre, objet: d.objet,
      engageDzd: arrondi(Math.max(accorde, paye)), payeDzd: arrondi(paye),
    });
  }
  return out;
}

/**
 * TOUS LES AVANTAGES AD & PRO ACCORDÉS — prises en charge et demandes qui désignent des praticiens. Le nom du demandeur est
 * résolu ici ; la fusion des fiches, la société et le rôle du lecteur se traitent chez l'appelant.
 */
export async function avantagesAdPro(): Promise<Avantage[]> {
  const [pec, demandes] = await Promise.all([avantagesPriseEnCharge(), avantagesDesDemandes()]);
  const tous = [...pec, ...demandes];
  const userIds = [...new Set(tous.map((a) => a.demandeurId).filter((x): x is string => Boolean(x)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(users.map((u) => [u.id, u.name]));
  return tous.map(({ demandeurId, ...a }) => ({ ...a, demandeur: demandeurId ? nomDe.get(demandeurId) ?? null : null }));
}
