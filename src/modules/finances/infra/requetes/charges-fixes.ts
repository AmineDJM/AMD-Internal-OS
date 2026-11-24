import { prisma } from "@/lib/prisma";
import {
  cleEcheance, CODE_ENVELOPPE_ADMINISTRATION, ecartFacture, echeancesAApparaitre, echeancesEntre, estNatureChargeFixe, joursAvant,
  LIBELLE_NATURE_CHARGE_FIXE, libellePeriode, lignesPrefillChargesFixes, montantAnnuel, peutDemanderPaiement,
  previsionChargesFixes, type EtatEcheanceCharge, type LignePrefillChargeFixe, type LigneBudgetVue, type MoisPrevision, type SocieteChargesVue,
} from "../../domaine/charges-fixes";
import { chargesPourCalcul } from "../budget-administration";
import { echeancesTraitees } from "../charges-fixes";
import type { ApportContexte, OrdrePourBrique } from "./contexte-decision";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHARGES FIXES — CE QUE LES ÉCRANS LISENT (Super Admin, 24/11/2026).
 *
 *   · la section « Locaux & charges fixes » d'« Informations de la société » : les charges, leurs échéances proches et
 *     leur état (lu sur l'ordre), les lignes du budget de l'Administration, les baux du registre Legal ;
 *   · « Aujourd'hui » des Finances : les échéances à demander, quinze jours avant ;
 *   · la fiche du centre de paiement : l'estimation face à la facture (alerte au-delà de +10 %) ;
 *   · la prévision de trésorerie à 12 mois et le pré-remplissage `AUTO_CHARGES_FIXES` de la campagne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const JOUR = 86_400_000;
/** Les échéances montrées : celles du mois écoulé et des 45 prochains jours, plus toute échéance passée encore ouverte. */
const PASSE_JOURS = 31;
const AVENIR_JOURS = 45;

export async function chargerChargesFixes(
  companyIds: readonly string[], user: { id: string }, maintenant: Date = new Date(),
): Promise<Map<string, SocieteChargesVue>> {
  const out = new Map<string, SocieteChargesVue>(companyIds.map((id) => [id, { charges: [], echeances: [], budget: null, baux: [] }]));
  if (companyIds.length === 0) return out;
  const annee = maintenant.getUTCFullYear();
  const milieu = new Date(Date.UTC(annee, 5, 30));
  const [rows, enveloppes, baux] = await Promise.all([
    prisma.chargeFixeSociete.findMany({
      where: { companyId: { in: [...companyIds] } },
      orderBy: [{ active: "desc" }, { site: "asc" }, { nature: "asc" }],
      include: { legalDocument: { select: { title: true } } },
    }),
    prisma.budgetEnvelope.findMany({
      where: { companyId: { in: [...companyIds] }, module: CODE_ENVELOPPE_ADMINISTRATION, periodStart: { lte: milieu }, periodEnd: { gte: milieu } },
      orderBy: [{ isActive: "desc" }],
      select: { id: true, name: true, companyId: true, totalAmount: true, categories: { select: { id: true, name: true, cle: true, allocated: true, parentId: true } } },
    }),
    // Les baux et contrats en vigueur de la société — jamais un document réservé à ses lecteurs désignés (sauf soi).
    prisma.legalDocument.findMany({
      where: {
        companyId: { in: [...companyIds] }, kind: { in: ["LEASE", "CONTRACT"] }, status: "ACTIVE",
        OR: [{ readers: { none: {} } }, { readers: { some: { userId: user.id } } }],
      },
      orderBy: [{ kind: "desc" }, { title: "asc" }], take: 200,
      select: { id: true, title: true, amount: true, companyId: true, kind: true },
    }),
  ]);
  const traitees = await echeancesTraitees(rows.map((r) => r.id));
  const debut = new Date(maintenant.getTime() - 365 * JOUR);
  const fin = new Date(maintenant.getTime() + AVENIR_JOURS * JOUR);
  for (const r of rows) {
    const vue = out.get(r.companyId);
    if (!vue) continue;
    const calc = { ...r, montant: Number(r.montant) };
    vue.charges.push({
      id: r.id, site: r.site, nature: r.nature, natureLibelle: estNatureChargeFixe(r.nature) ? LIBELLE_NATURE_CHARGE_FIXE[r.nature] : r.nature,
      libelle: r.libelle, beneficiaire: r.beneficiaire, rib: r.rib, legalDocumentId: r.legalDocumentId, bail: r.legalDocument?.title ?? null,
      modeMontant: r.modeMontant, montant: calc.montant, periodicite: r.periodicite, jourEcheance: r.jourEcheance, moisEcheance: r.moisEcheance,
      dateDebut: r.dateDebut.toISOString().slice(0, 10), dateFin: r.dateFin?.toISOString().slice(0, 10) ?? null,
      echeanceFixe: r.echeanceFixe, active: r.active, notes: r.notes, montantAnnuel: montantAnnuel(calc, annee),
    });
    for (const e of echeancesEntre(calc, debut, fin)) {
      const t = traitees.get(cleEcheance(e.chargeId, e.periode));
      const etat: EtatEcheanceCharge = t?.etat ?? "A_DEMANDER";
      const recente = e.date.getTime() >= maintenant.getTime() - PASSE_JOURS * JOUR;
      if (!recente && (etat === "PAYEE" || etat === "ANNULEE")) continue;
      vue.echeances.push({
        cle: cleEcheance(e.chargeId, e.periode), chargeId: e.chargeId, periode: e.periode, periodeLibelle: libellePeriode(e.periode, r.periodicite),
        date: e.date.toISOString(), joursAvant: joursAvant(e.date, maintenant), montantPrevu: e.montant, modeMontant: r.modeMontant,
        nature: vue.charges[vue.charges.length - 1].natureLibelle, site: r.site, beneficiaire: r.beneficiaire, etat,
        reference: t?.reference ?? null, montantFacture: t?.montantFacture ?? null,
      });
    }
  }
  for (const v of out.values()) v.echeances.sort((a, b) => a.date.localeCompare(b.date));
  for (const env of enveloppes) {
    const vue = env.companyId ? out.get(env.companyId) : undefined;
    if (!vue || vue.budget) continue;
    const meres = env.categories.filter((c) => c.parentId === null);
    const lignes: LigneBudgetVue[] = [];
    for (const m of meres) {
      lignes.push({ id: m.id, cle: m.cle, nom: m.name, alloue: Number(m.allocated), sous: false });
      for (const f of env.categories.filter((c) => c.parentId === m.id)) lignes.push({ id: f.id, cle: f.cle, nom: f.name, alloue: Number(f.allocated), sous: true });
    }
    vue.budget = { id: env.id, nom: env.name, total: Number(env.totalAmount), lignes };
  }
  for (const b of baux) {
    const vue = b.companyId ? out.get(b.companyId) : undefined;
    vue?.baux.push({ id: b.id, titre: `${b.kind === "LEASE" ? "Bail" : "Contrat"} — ${b.title}`, montant: b.amount === null ? null : Number(b.amount) });
  }
  return out;
}

/** Une échéance à demander, telle que « Aujourd'hui » des Finances la montre. */
export interface EcheanceAFaire {
  cle: string;
  companyId: string;
  chargeId: string;
  titre: string;
  detail: string;
  date: Date;
  montant: number;
  nature: string;
}

/** LES ÉCHÉANCES À DEMANDER (quinze jours avant, et les passées jamais demandées) des sociétés données. */
export async function echeancesChargesFixesAFaire(companyIds: readonly string[], maintenant: Date = new Date()): Promise<EcheanceAFaire[]> {
  if (companyIds.length === 0) return [];
  const charges = await chargesPourCalcul({ companyId: { in: [...companyIds] }, active: true });
  if (charges.length === 0) return [];
  const t = await echeancesTraitees(charges.map((c) => c.id));
  const traitees = new Set([...t.entries()].filter(([, v]) => !peutDemanderPaiement(v.etat)).map(([k]) => k));
  return echeancesAApparaitre(charges, maintenant, traitees).map((e) => {
    const c = charges.find((x) => x.id === e.chargeId)!;
    const nature = estNatureChargeFixe(c.nature) ? LIBELLE_NATURE_CHARGE_FIXE[c.nature] : c.nature;
    return {
      cle: cleEcheance(e.chargeId, e.periode), companyId: e.companyId, chargeId: e.chargeId,
      titre: `${nature} — ${c.site} · ${libellePeriode(e.periode, c.periodicite)}`,
      detail: `${c.beneficiaire}${c.modeMontant === "SELON_FACTURE" ? " · estimation, la facture fait foi" : ""}`,
      date: e.date, montant: e.montant, nature,
    };
  });
}

/**
 * LA PRÉVISION DE TRÉSORERIE À 12 MOIS des charges fixes, par société et par mois (à partir du mois en cours). Une
 * échéance déjà payée en sort ; une échéance demandée mais pas encore payée y reste (l'argent n'est pas sorti).
 */
export async function previsionTresorerieChargesFixes(companyIds: readonly string[], depuis: Date = new Date(), mois = 12): Promise<MoisPrevision[]> {
  if (companyIds.length === 0) return [];
  const charges = await chargesPourCalcul({ companyId: { in: [...companyIds] }, active: true });
  const t = await echeancesTraitees(charges.map((c) => c.id));
  const payees = new Set([...t.entries()].filter(([, v]) => v.etat === "PAYEE").map(([k]) => k));
  return previsionChargesFixes(charges, depuis, mois, payees);
}

/**
 * LE PRÉ-REMPLISSAGE `AUTO_CHARGES_FIXES` d'une société pour l'année budgétée — le point d'entrée de la campagne
 * (`prefillChargesFixes` du lot campagne). Le réalisé = ce qui a été payé l'année précédente, par nature.
 */
export async function prefillChargesFixesSociete(companyId: string, annee: number): Promise<LignePrefillChargeFixe[]> {
  const charges = await chargesPourCalcul({ companyId, active: true });
  if (charges.length === 0) return [];
  const t = await echeancesTraitees(charges.map((c) => c.id));
  const realises = new Map<string, number>();
  for (const [cle, v] of t) {
    const [chargeId, periode] = cle.split(":");
    if (v.etat !== "PAYEE" || !periode?.startsWith(`${annee - 1}-`)) continue;
    const c = charges.find((x) => x.id === chargeId);
    if (c) realises.set(c.nature, (realises.get(c.nature) ?? 0) + (v.montantFacture ?? 0));
  }
  return lignesPrefillChargesFixes(charges, annee, realises);
}

/**
 * LA BRIQUE DU CENTRE DE PAIEMENT : d'où vient le paiement (« Charges fixes · Loyer »), l'échéance, et la facture face à
 * ce que la charge prévoyait — au-delà de +10 % de l'estimation (« selon facture »), l'alerte rouge s'affiche.
 */
export async function apportsChargesFixes(ordres: readonly OrdrePourBrique[]): Promise<Map<string, ApportContexte>> {
  const out = new Map<string, ApportContexte>();
  const siens = ordres.filter((o) => o.sourceType === "FIXED_CHARGE" && o.sourceId);
  if (siens.length === 0) return out;
  const echeances = await prisma.echeanceChargeFixe.findMany({
    where: { id: { in: siens.map((o) => o.sourceId as string) } },
    select: { id: true, periode: true, montantPrevu: true, demandeLe: true, charge: { select: { nature: true, site: true, modeMontant: true, periodicite: true, legalDocument: { select: { title: true } } } } },
  });
  for (const o of siens) {
    const e = echeances.find((x) => x.id === o.sourceId);
    if (!e) continue;
    const nature = estNatureChargeFixe(e.charge.nature) ? LIBELLE_NATURE_CHARGE_FIXE[e.charge.nature] : e.charge.nature;
    const prevu = Number(e.montantPrevu);
    const alerte = ecartFacture({ modeMontant: e.charge.modeMontant, prevu, facture: o.montant });
    out.set(o.id, {
      origine: `Charges fixes · ${nature}`,
      objet: `${nature} — ${e.charge.site} · ${libellePeriode(e.periode, e.charge.periodicite)}`,
      ...(e.demandeLe ? { demandeLe: e.demandeLe } : {}),
      chaine: [{ etape: "Charge fixe de la société", detail: e.charge.legalDocument ? `bail : ${e.charge.legalDocument.title}` : "Informations de la société", etat: "OK" }],
      jalons: [{ libelle: e.charge.modeMontant === "SELON_FACTURE" ? "Estimation" : "Montant fixe", valeur: prevu }, { libelle: "Facture", valeur: o.montant }],
      alertes: alerte ? [alerte] : [],
    });
  }
  return out;
}
