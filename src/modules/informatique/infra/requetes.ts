import { prisma } from "@/lib/prisma";
import { companyLabel, getMyCompanies } from "@/lib/company";
import { CLE_LIGNE_IA, CLES_LIGNES_INFORMATIQUE, rapprocher, type MoisRapproche } from "../domaine/budget";
import { enUsd, lireDetail, type DetailImputation, type Repartition } from "../domaine/imputation";
import { anneeDuMois, moisDe, moisDeLAnneeJusqua } from "../domaine/mois";
import { coutAnnuel, etatGarantie, joursAvant } from "../domaine/registres";
import { calculerCoutIaDuMois, dernierTauxFixe } from "./imputation";

/**
 * LES LECTURES DES ÉCRANS DU DÉPARTEMENT INFORMATIQUE — toujours bornées aux sociétés auxquelles la personne a droit
 * (`getMyCompanies`) : un responsable Informatique ne voit que SA société, le Super Admin et le DG tout le groupe.
 */

export interface Societe { id: string; label: string }

async function societesPermises(userId: string): Promise<Societe[]> {
  return (await getMyCompanies(userId)).map((c) => ({ id: c.id, label: companyLabel(c) }));
}

const jour = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Les lignes budgétaires proposées à un abonnement : celles du budget Informatique de l'année, par société. */
async function lignesBudgetInformatique(companyIds: readonly string[], maintenant: Date): Promise<{ id: string; label: string; companyId: string; cle: string | null }[]> {
  if (companyIds.length === 0) return [];
  const envs = await prisma.budgetEnvelope.findMany({
    where: { companyId: { in: [...companyIds] }, periodStart: { lte: maintenant }, periodEnd: { gte: maintenant }, categories: { some: { cle: CLE_LIGNE_IA } } },
    select: { companyId: true, name: true, categories: { where: { parentId: null }, select: { id: true, name: true, cle: true }, orderBy: { createdAt: "asc" } } },
  });
  return envs.flatMap((e) => e.categories.map((c) => ({ id: c.id, label: `${e.name} › ${c.name}`, companyId: e.companyId ?? "", cle: c.cle })));
}

// ─────────────────────────────── Abonnements & licences ───────────────────────────────

export interface LigneAbonnement {
  id: string; companyId: string; societe: string; fournisseur: string; objet: string; periodicite: string; montant: number; devise: string;
  coutAnnuel: number; echeance: string | null; joursAvantEcheance: number | null; rappelJours: number; budgetCategoryId: string | null;
  ligneBudget: string | null; statut: string; notes: string | null; pieces: { id: string; name: string }[];
}

export interface VueAbonnements {
  lignes: LigneAbonnement[];
  societes: Societe[];
  lignesBudget: { id: string; label: string; companyId: string; cle: string | null }[];
}

export async function vueAbonnements(userId: string, maintenant: Date = new Date()): Promise<VueAbonnements> {
  const societes = await societesPermises(userId);
  const ids = societes.map((s) => s.id);
  const [abonnements, lignesBudget] = await Promise.all([
    prisma.abonnementInformatique.findMany({ where: { companyId: { in: ids } }, orderBy: [{ statut: "asc" }, { echeance: "asc" }, { fournisseur: "asc" }] }),
    lignesBudgetInformatique(ids, maintenant),
  ]);
  const [pieces, categories] = await Promise.all([
    abonnements.length
      ? prisma.document.findMany({ where: { entityType: "IT_SUBSCRIPTION", entityId: { in: abonnements.map((a) => a.id) } }, select: { id: true, name: true, entityId: true }, orderBy: { createdAt: "asc" } })
      : Promise.resolve([]),
    prisma.budgetCategoryLine.findMany({
      where: { id: { in: abonnements.flatMap((a) => (a.budgetCategoryId ? [a.budgetCategoryId] : [])) } },
      select: { id: true, name: true, envelope: { select: { name: true } } },
    }),
  ]);
  const nomSociete = new Map(societes.map((s) => [s.id, s.label]));
  const nomLigne = new Map(categories.map((c) => [c.id, `${c.envelope.name} › ${c.name}`]));
  return {
    societes, lignesBudget,
    lignes: abonnements.map((a) => {
      const montant = Number(a.montant);
      return {
        id: a.id, companyId: a.companyId, societe: nomSociete.get(a.companyId) ?? "—", fournisseur: a.fournisseur, objet: a.objet,
        periodicite: a.periodicite, montant, devise: a.devise, coutAnnuel: coutAnnuel({ periodicite: a.periodicite, montant }),
        echeance: jour(a.echeance), joursAvantEcheance: a.echeance ? joursAvant(a.echeance, maintenant) : null, rappelJours: a.rappelJours,
        budgetCategoryId: a.budgetCategoryId, ligneBudget: a.budgetCategoryId ? nomLigne.get(a.budgetCategoryId) ?? "Ligne retirée du budget" : null,
        statut: a.statut, notes: a.notes, pieces: pieces.filter((p) => p.entityId === a.id).map((p) => ({ id: p.id, name: p.name })),
      };
    }),
  };
}

// ─────────────────────────────── Parc informatique ───────────────────────────────

export interface LigneMateriel {
  id: string; companyId: string; societe: string; type: string; reference: string; numeroSerie: string | null;
  employeeId: string | null; departmentId: string | null; affectation: string | null; dateAchat: string | null;
  finGarantie: string | null; garantie: ReturnType<typeof etatGarantie>; etat: string; notes: string | null;
}

export interface VueParc {
  lignes: LigneMateriel[];
  societes: Societe[];
  personnes: { id: string; label: string; companyId: string | null }[];
  departements: { id: string; label: string; companyId: string | null }[];
}

export async function vueParc(userId: string, maintenant: Date = new Date()): Promise<VueParc> {
  const societes = await societesPermises(userId);
  const ids = societes.map((s) => s.id);
  const [materiels, personnes, departements] = await Promise.all([
    prisma.materielInformatique.findMany({ where: { companyId: { in: ids } }, orderBy: [{ type: "asc" }, { reference: "asc" }] }),
    prisma.employee.findMany({ where: { isActive: true, companyId: { in: ids } }, select: { id: true, fullName: true, companyId: true }, orderBy: { fullName: "asc" } }),
    prisma.department.findMany({ where: { companyId: { in: ids } }, select: { id: true, name: true, companyId: true }, orderBy: { name: "asc" } }),
  ]);
  // Une affectation à une personne partie (fiche désactivée) se lit encore : on relit son nom.
  const absents = materiels.flatMap((m) => (m.employeeId && !personnes.some((p) => p.id === m.employeeId) ? [m.employeeId] : []));
  const anciens = absents.length ? await prisma.employee.findMany({ where: { id: { in: absents } }, select: { id: true, fullName: true } }) : [];
  const nomPersonne = new Map([...personnes, ...anciens].map((p) => [p.id, p.fullName]));
  const nomDepartement = new Map(departements.map((d) => [d.id, d.name]));
  const nomSociete = new Map(societes.map((s) => [s.id, s.label]));
  return {
    societes,
    personnes: personnes.map((p) => ({ id: p.id, label: p.fullName, companyId: p.companyId })),
    departements: departements.map((d) => ({ id: d.id, label: d.name, companyId: d.companyId })),
    lignes: materiels.map((m) => ({
      id: m.id, companyId: m.companyId, societe: nomSociete.get(m.companyId) ?? "—", type: m.type, reference: m.reference, numeroSerie: m.numeroSerie,
      employeeId: m.employeeId, departmentId: m.departmentId,
      affectation: (m.employeeId ? nomPersonne.get(m.employeeId) ?? "Personne retirée" : null) ?? (m.departmentId ? nomDepartement.get(m.departmentId) ?? "Département retiré" : null),
      dateAchat: jour(m.dateAchat), finGarantie: jour(m.finGarantie), garantie: etatGarantie(m.finGarantie, maintenant), etat: m.etat, notes: m.notes,
    })),
  };
}

// ─────────────────────────────── Consommation IA × budget ───────────────────────────────

export interface RapprochementSociete {
  companyId: string; societe: string; enveloppe: { id: string; nom: string } | null; budgetIa: number;
  mois: MoisRapproche[]; imputeAnnee: number; dernierCalcul: string | null; detail: DetailImputation | null; moisDuDetail: string | null;
}

export interface ApercuMois {
  mois: string;
  parSociete: { companyId: string; societe: string; coutUsd: number; appels: number; sansTarif: number; imputeDzd: number | null }[];
  nonRattache: Repartition["nonRattache"] & { coutUsd: number };
}

export interface VueCoutIa { moisCourant: string; annee: number; dernierTaux: number | null; apercu: ApercuMois; societes: RapprochementSociete[] }

export async function vueCoutIa(userId: string, maintenant: Date = new Date()): Promise<VueCoutIa> {
  const societes = await societesPermises(userId);
  const ids = societes.map((s) => s.id);
  const moisCourant = moisDe(maintenant);
  const annee = anneeDuMois(moisCourant);
  const moisAnnee = moisDeLAnneeJusqua(moisCourant);
  const [imputations, envs, rep, dernierTaux] = await Promise.all([
    prisma.imputationCoutIa.findMany({ where: { companyId: { in: ids }, mois: { in: moisAnnee } }, orderBy: { mois: "asc" } }),
    prisma.budgetEnvelope.findMany({
      where: { companyId: { in: ids }, periodStart: { lte: maintenant }, periodEnd: { gte: maintenant }, categories: { some: { cle: CLE_LIGNE_IA } } },
      orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
      select: { id: true, name: true, companyId: true, categories: { where: { cle: { in: [...CLES_LIGNES_INFORMATIQUE] }, parentId: null }, select: { cle: true, allocated: true } } },
    }),
    calculerCoutIaDuMois(moisCourant),
    dernierTauxFixe(),
  ]);
  const nomSociete = new Map(societes.map((s) => [s.id, s.label]));
  const permis = new Set(ids);
  return {
    moisCourant, annee, dernierTaux,
    apercu: {
      mois: moisCourant,
      parSociete: rep.parSociete.filter((p) => permis.has(p.companyId)).map((p) => ({
        companyId: p.companyId, societe: nomSociete.get(p.companyId) ?? "—", coutUsd: enUsd(p.microUsd), appels: p.appels, sansTarif: p.sansTarif,
        imputeDzd: (() => { const i = imputations.find((x) => x.companyId === p.companyId && x.mois === moisCourant); return i ? Number(i.montantDzd) : null; })(),
      })),
      nonRattache: { ...rep.nonRattache, coutUsd: enUsd(rep.nonRattache.microUsd) },
    },
    societes: societes.map((s) => {
      const env = envs.find((e) => e.companyId === s.id) ?? null;
      const budgetIa = Number(env?.categories.find((c) => c.cle === CLE_LIGNE_IA)?.allocated ?? 0);
      const siennes = imputations.filter((i) => i.companyId === s.id);
      // Une seule consommation par mois : la ligne mesurée, ou la facture payée qui l'a soldée (`consommationIaDuMois`).
      const parMois = new Map(siennes.map((i) => [i.mois, Math.round((Number(i.montantDzd) + (lireDetail(i.detail).factureDzd ?? 0)) * 100) / 100]));
      const derniere = siennes.at(-1) ?? null;
      const lignes = rapprocher(moisAnnee, parMois, budgetIa);
      return {
        companyId: s.id, societe: s.label, enveloppe: env ? { id: env.id, nom: env.name } : null, budgetIa,
        mois: lignes, imputeAnnee: lignes.at(-1)?.cumul ?? 0,
        dernierCalcul: derniere ? derniere.calculeLe.toISOString() : null,
        detail: derniere ? lireDetail(derniere.detail) : null, moisDuDetail: derniere?.mois ?? null,
      };
    }),
  };
}
