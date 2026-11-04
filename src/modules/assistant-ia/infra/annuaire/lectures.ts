import type { Prisma } from "@prisma/client";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import {
  annuaireOuvertParConsole, peutAnnuaire, scopeMedicalDoctors, scopeMedicalVisits, userCan,
} from "@/lib/rbac";
import { lignesDepensesAdPro } from "@/modules/ad-pro/api";
import { peutDeciderFusionMedecins, propositionsFusionMedecins } from "@/modules/referentiels/api";
import {
  agregerDepenses, bornesPeriode, motsDuNom, plier, pourcentage, PERIODES, type AxeDepense, type Periode,
} from "../../domaine/annuaire/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNUAIRE, LE TERRAIN ET LE MARKETING, LUS PAR L'ASSISTANT (lot T2, décision 0052).
 *
 * Mesuré au banc (02/11) : « qui couvre la pharmacie Ibn Sina ? », « quel délégué a vu le Dr Mansouri en dernier ? »,
 * « nos dépenses Ad & Pro par BU » restaient sans réponse — aucune lecture ne portait la COUVERTURE (secteur → délégués),
 * les VISITES ni les dépenses par BU / produit / mois. Trois lectures typées, chacune sous LA portée de l'écran :
 *
 *   • `annuaire_terrain`  — médecins, pharmacies, établissements : coordonnées, spécialité, établissement, délégué,
 *     secteur, délégués qui couvrent, dernière visite, champs MANQUANTS ; et les comptes (total, couverts). Praticiens :
 *     `scopeMedicalDoctors` (le panel du délégué), ou tout l'annuaire s'il est ouvert par la console ; établissements :
 *     `peutAnnuaire` (un référentiel partagé). Un délégué hors secteur ne voit donc pas le praticien d'un autre panel.
 *   • `visites_terrain`   — visites et comptes rendus : `scopeMedicalVisits` (le délégué : les SIENNES), par médecin,
 *     délégué, période ; par délégué, par médecin, couverture (médecins visibles visités / total, en %).
 *   • `depenses_marketing` — les dépenses Ad & Pro ventilées (BU, produit, nature, mois, demandeur) sur une période, avec
 *     la comparaison à la période précédente : chaque nature lue SEULEMENT si la personne a son module, sous sa portée
 *     de lignes (la règle de la liste unifiée `getAdProRequests`). Montant retenu : accordé, sinon proposé, sinon demandé.
 *
 * Les lignes rendues deviennent des JEUX du tour (K1) : `analyser_donnees` en tire graphiques et calculs exacts,
 * `exporter_donnees` un Excel. Le calcul des agrégats est PUR (`domaine/annuaire/analyse.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const str = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
const nb = (e: Record<string, unknown>, k: string) => (typeof e[k] === "number" ? (e[k] as number) : Number.parseInt(str(e, k), 10) || null);
const oui = (e: Record<string, unknown>, k: string) => e[k] === true || e[k] === "true";
const jour = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const refus = (raison: string) => JSON.stringify({ statut: "REFUS", raison });

/** Un nom désigné par ses MOTS (« Dr Karima BENSALEM », « pharmacie Ibn Sina ») : chaque mot doit figurer dans le nom. */
const parMots = (texte: string): { AND: { name: { contains: string; mode: "insensitive" } }[] } | Record<string, never> => {
  const mots = motsDuNom(texte);
  return mots.length ? { AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) } : {};
};
const wilaya = (w: string) => (w ? { OR: [{ wilaya: { equals: w, mode: "insensitive" as const } }, { city: { equals: w, mode: "insensitive" as const } }] } : {});

/** Les praticiens que la personne voit : tout l'annuaire s'il lui est ouvert par la console, sinon sa portée (panel). */
export function porteeMedecins(u: CurrentUser): Prisma.MedicalDoctorWhereInput {
  // Une fiche ARCHIVÉE (supprimée de la feuille, ou absorbée par une fusion) n'est plus dans l'annuaire.
  if (annuaireOuvertParConsole(u, "MEDECINS", "VIEW")) return { archivedAt: null };
  return userCan(u, "MEDICAL", "VIEW") ? { AND: [scopeMedicalDoctors(u), { archivedAt: null }] } : { id: "__aucun__" };
}
export const voitEtablissements = (u: CurrentUser) => peutAnnuaire(u, "ETABLISSEMENTS", "VIEW") || peutAnnuaire(u, "PHARMACIENS", "VIEW");
export const voitAnnuaire = (u: CurrentUser) => userCan(u, "MEDICAL", "VIEW") || annuaireOuvertParConsole(u, "MEDECINS", "VIEW") || voitEtablissements(u);

/** Ce qu'on lit d'un établissement : sa fiche, ses secteurs actifs (délégués, BU), ses praticiens — partagé avec la vue `etablissements` (I3). */
export const SELECT_ETABLISSEMENT = {
  id: true, name: true, type: true, wilaya: true, city: true, address: true, phone: true, email: true, isActive: true,
  sectors: { where: { sector: { isActive: true } }, select: { sector: { select: { name: true, reps: { select: { rep: { select: { name: true } } } }, businessUnit: { select: { name: true } } } } } },
  _count: { select: { doctors: true } },
} satisfies Prisma.MedicalInstitutionSelect;

const TYPES: Record<string, string[]> = {
  pharmacie: ["PHARMACIE"], grossiste: ["GROSSISTE"], hopital: ["CHU", "EPH", "EHS"], clinique: ["CLINIQUE_PRIVEE", "POLYCLINIQUE"], cabinet: ["CABINET", "CENTRE_SANTE"],
};

function outil(name: string, description: string, properties: Record<string, unknown>, label: string, allowed: (u: CurrentUser) => boolean, run: PowerTool["run"]): PowerTool {
  return { def: { name, description, input_schema: { type: "object", properties } } as PowerTool["def"], allowed, label, run };
}

async function lireAnnuaire(entree: Record<string, unknown>, u: CurrentUser): Promise<string> {
  const quoi = str(entree, "quoi").toLowerCase() || "tous";
  const nom = str(entree, "nom");
  const w = str(entree, "wilaya");
  const manque = str(entree, "manquant").toLowerCase();
  const limite = Math.min(Math.max(nb(entree, "limite") ?? 60, 1), 300);
  const out: Record<string, unknown> = {};

  if ((quoi === "tous" || quoi === "medecin") && (userCan(u, "MEDICAL", "VIEW") || annuaireOuvertParConsole(u, "MEDECINS", "VIEW"))) {
    const sp = str(entree, "specialite");
    const del = str(entree, "delegue");
    const where: Prisma.MedicalDoctorWhereInput = { AND: [
      porteeMedecins(u), nom ? parMots(nom) : {}, wilaya(w),
      sp ? { OR: [{ specialty: { contains: sp, mode: "insensitive" } }, { specialtyRef: { name: { contains: sp, mode: "insensitive" } } }] } : {},
      del ? { delegate: { AND: motsDuNom(del).map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) } } : {},
      manque === "telephone" ? { OR: [{ phone: null }, { phone: "" }] } : manque === "specialite" ? { specialtyId: null, OR: [{ specialty: null }, { specialty: "" }] }
        : manque === "email" ? { OR: [{ email: null }, { email: "" }] } : manque === "etablissement" ? { institutionId: null } : {},
    ] };
    const [total, ds] = await Promise.all([
      prisma.medicalDoctor.count({ where }),
      prisma.medicalDoctor.findMany({
        where, take: limite, orderBy: { name: "asc" },
        select: {
          id: true, name: true, phone: true, email: true, wilaya: true, city: true, address: true, specialty: true, institution: true,
          specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true, sectors: { select: { sector: { select: { name: true } } } } } },
          delegate: { select: { name: true } },
        },
      }),
    ]);
    // La dernière visite de chaque fiche : seulement celles que la personne voit (le délégué : les siennes). Une requête
    // à part, triée — pas un `take` imbriqué (LIMIT en mémoire, cliquet `prisma-take-imbrique.test.ts`).
    const derniere = new Map<string, { le: string | null; par: string | null }>();
    if (ds.length) {
      const vs = await prisma.medicalVisit.findMany({
        where: { AND: [scopeMedicalVisits(u), { status: "COMPLETED" }, { doctorId: { in: ds.map((d) => d.id) } }] },
        orderBy: { date: "desc" }, take: 2_000, select: { doctorId: true, date: true, delegate: { select: { name: true } } },
      });
      for (const v of vs) if (v.doctorId && !derniere.has(v.doctorId)) derniere.set(v.doctorId, { le: jour(v.date), par: v.delegate?.name ?? null });
    }
    out.medecins = ds.map((d) => ({
      nom: d.name, specialite: d.specialtyRef?.name ?? d.specialty ?? null, etablissement: d.institutionRef?.name ?? d.institution ?? null,
      wilaya: d.wilaya ?? d.city ?? null, telephone: d.phone || null, email: d.email || null, adresse: d.address || null,
      delegue: d.delegate?.name ?? null, secteur: d.institutionRef?.sectors.map((s) => s.sector.name).join(", ") || null,
      derniereVisite: derniere.get(d.id) ?? null,
      manquants: [!d.phone && "téléphone", !d.email && "e-mail", !(d.specialtyRef || d.specialty) && "spécialité", !(d.institutionRef || d.institution) && "établissement"].filter(Boolean),
    }));
    out.medecinsTotal = total;
  }

  if (quoi !== "medecin" && voitEtablissements(u)) {
    const types = quoi === "tous" || quoi === "etablissement" ? null : TYPES[quoi] ?? null;
    const where: Prisma.MedicalInstitutionWhereInput = { AND: [
      oui(entree, "inclureInactifs") ? {} : { isActive: true },
      types ? { type: { in: types as never } } : {}, nom ? parMots(nom.replace(/\bpharmacie\b/i, "").trim() || nom) : {}, wilaya(w),
      manque === "telephone" ? { OR: [{ phone: null }, { phone: "" }] } : manque === "adresse" ? { OR: [{ address: null }, { address: "" }] }
        : manque === "email" ? { OR: [{ email: null }, { email: "" }] } : {},
    ] };
    const [total, couverts, es] = await Promise.all([
      prisma.medicalInstitution.count({ where }),
      prisma.medicalInstitution.count({ where: { AND: [where, { sectors: { some: { sector: { isActive: true } } } }] } }),
      prisma.medicalInstitution.findMany({
        where, take: limite, orderBy: { name: "asc" },
        select: SELECT_ETABLISSEMENT,
      }),
    ]);
    out.etablissements = es.map((e) => ({
      nom: e.name, type: e.type, wilaya: e.wilaya ?? e.city ?? null, adresse: e.address || null, telephone: e.phone || null, email: e.email || null,
      ...(e.isActive ? {} : { inactif: true }),
      secteurs: e.sectors.map((s) => s.sector.name),
      couvertPar: [...new Set(e.sectors.flatMap((s) => s.sector.reps.map((r) => r.rep.name)))],
      bu: [...new Set(e.sectors.map((s) => s.sector.businessUnit.name))],
      praticiensRattaches: e._count.doctors,
      manquants: [!e.phone && "téléphone", !e.address && "adresse", !e.email && "e-mail"].filter(Boolean),
    }));
    out.etablissementsTotal = total;
    out.etablissementsCouverts = couverts;
  }
  if (!("medecins" in out) && !("etablissements" in out)) return refus("L'annuaire médical n'est pas ouvert à cette personne (Promotion médicale, ou l'annuaire ouvert par la console).");
  const vide = (out.medecinsTotal ?? 0) === 0 && (out.etablissementsTotal ?? 0) === 0;
  return JSON.stringify({ ...out, ...(vide && nom ? { consigne: "Aucune fiche de ce nom dans le périmètre de la personne (son panel, ou l'annuaire qui lui est ouvert) : dis-le simplement, sans lui demander de vérifier l'orthographe." } : {}), note: "Comptes exacts calculés en base (`…Total`, `etablissementsCouverts` = rattachés à un secteur actif). Les listes sont bornées à `limite`." });
}

async function lireVisites(entree: Record<string, unknown>, u: CurrentUser): Promise<string> {
  const jours = Math.min(Math.max(nb(entree, "jours") ?? 30, 1), 730);
  // Une date illisible (« 03/10 », « début octobre ») ne filtre pas tout en silence : on retombe sur `jours`.
  // Seul AAAA-MM-JJ est lu : « 03/10 » donnait le 10 mars 2001 (le moteur JS devine), donc des mois de trop.
  const dite = /^\d{4}-\d{2}-\d{2}/.test(str(entree, "depuis")) ? new Date(str(entree, "depuis")) : null;
  const depuis = dite && !Number.isNaN(dite.getTime()) ? dite : new Date(Date.now() - jours * 86_400_000);
  const medecin = str(entree, "medecin");
  const del = str(entree, "delegue");
  const visibles = porteeMedecins(u);
  // LE DÉLÉGUÉ DÉSIGNÉ (banc réel 02/11, MKT-07 : « aucune visite » rendu au délégué qui en avait 4) : « moi », ou son
  // propre nom, c'est la personne elle-même ; un nom qui ne désigne aucun compte est DIT — jamais un zéro silencieux.
  let delegues: string[] | null = null;
  if (del) {
    const mots = motsDuNom(del);
    const moi = /^(moi|me|mes|moi-m[eê]me|self|je)$/i.test(del.trim()) || (mots.length > 0 && mots.every((m) => (u.name ?? "").toLowerCase().includes(m.toLowerCase())));
    if (moi) delegues = [u.id];
    else {
      const us = mots.length ? await prisma.user.findMany({ where: { AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) }, select: { id: true }, take: 10 }) : [];
      if (!us.length) return JSON.stringify({ statut: "INTROUVABLE", raison: `Aucun délégué « ${del} » parmi les comptes : relis le nom, ou omets « delegue » pour tes propres visites.` });
      delegues = us.map((x) => x.id);
    }
  }
  if (medecin && !(await prisma.medicalDoctor.count({ where: { AND: [visibles, parMots(medecin)] } }))) {
    return JSON.stringify({ statut: "INTROUVABLE", raison: `Aucun médecin « ${medecin} » dans l'annuaire visible par la personne (son panel, ou l'annuaire qui lui est ouvert).` });
  }
  const where: Prisma.MedicalVisitWhereInput = { AND: [
    scopeMedicalVisits(u), { doctor: visibles }, { date: { gte: depuis, lte: new Date(Date.now() + (oui(entree, "aVenir") ? 365 : 0) * 86_400_000) } },
    oui(entree, "aVenir") ? {} : { status: "COMPLETED" },
    medecin ? { doctor: parMots(medecin) } : {},
    delegues ? { delegateId: { in: delegues } } : {},
  ] };
  const vs = await prisma.medicalVisit.findMany({
    where, orderBy: { date: "desc" }, take: 500,
    select: { date: true, status: true, presentedProducts: true, report: true, followUpActions: true, doctorId: true, doctor: { select: { name: true, specialty: true, specialtyRef: { select: { name: true } } } }, delegate: { select: { name: true } } },
  });
  const parDelegue = new Map<string, { visites: number; medecins: Set<string> }>();
  const parMedecin = new Map<string, { visites: number; derniere: string | null; par: string | null }>();
  for (const v of vs) {
    const d = v.delegate?.name ?? "—";
    const pd = parDelegue.get(d) ?? { visites: 0, medecins: new Set<string>() };
    pd.visites += 1; if (v.doctorId) pd.medecins.add(v.doctorId); parDelegue.set(d, pd);
    const m = v.doctor?.name ?? "—";
    const pm = parMedecin.get(m) ?? { visites: 0, derniere: jour(v.date), par: d };
    pm.visites += 1; parMedecin.set(m, pm);
  }
  const totalMedecins = await prisma.medicalDoctor.count({ where: visibles });
  const vus = new Set(vs.filter((v) => v.status === "COMPLETED").map((v) => v.doctorId).filter(Boolean)).size;
  return JSON.stringify({
    periode: { du: jour(depuis), au: jour(new Date()) },
    totalVisites: vs.length,
    couverture: { medecinsVisibles: totalMedecins, medecinsVisites: vus, pourcentage: pourcentage(vus, totalMedecins) },
    parDelegue: [...parDelegue].map(([delegue, x]) => ({ delegue, visites: x.visites, medecinsDistincts: x.medecins.size })).sort((a, b) => b.visites - a.visites),
    parMedecin: [...parMedecin].map(([medecin, x]) => ({ medecin, visites: x.visites, derniereVisite: x.derniere, par: x.par })),
    visites: vs.slice(0, 80).map((v) => ({
      le: jour(v.date), medecin: v.doctor?.name ?? null, specialite: v.doctor?.specialtyRef?.name ?? v.doctor?.specialty ?? null, delegue: v.delegate?.name ?? null,
      statut: v.status, produits: v.presentedProducts ?? null, compteRendu: v.report ?? null, suite: v.followUpActions ?? null,
    })),
    note: "Visites sous la portée de la personne (un délégué : les siennes). Couverture = médecins visibles visités sur la période / médecins visibles.",
  });
}

const peutDepenses = (u: CurrentUser) => (["SPONSORING", "AD_PRO_OTHER", "CONGRESS_NATIONAL", "EVENTS"] as const).some((m) => userCan(u, m, "VIEW"));

async function lireDepenses(entree: Record<string, unknown>, u: CurrentUser): Promise<string> {
  const periode = (PERIODES as readonly string[]).includes(str(entree, "periode")) ? (str(entree, "periode") as Periode) : "annee";
  const b = bornesPeriode(periode, new Date(), str(entree, "du") || null, str(entree, "au") || null);
  const axes = (Array.isArray(entree.par) ? entree.par : [str(entree, "par") || "bu"]).filter((a): a is AxeDepense => ["bu", "produit", "nature", "mois", "demandeur"].includes(String(a)));
  const lignes = await lignesDepensesAdPro(u, b.du, b.au);
  const comparer = oui(entree, "comparer") || /mois_precedent|annee_precedente/.test(str(entree, "comparer"));
  const avant = comparer ? await lignesDepensesAdPro(u, b.precedente.du, b.precedente.au) : null;
  const ag = agregerDepenses(lignes, axes.length ? axes : ["bu"], avant);
  return JSON.stringify({
    periode: { libelle: b.libelle, du: jour(b.du), auExclu: jour(b.au) },
    ...(avant ? { periodePrecedente: { libelle: b.precedente.libelle, du: jour(b.precedente.du), auExclu: jour(b.precedente.au) } } : {}),
    // Une ventilation par axe, À PLAT (`parBu`, `parProduit`…) : chacune devient un jeu du tour (K1) pour un graphique.
    totalDzd: ag.totalDzd, demandes: ag.demandes,
    ...(ag.periodePrecedenteDzd != null ? { periodePrecedenteDzd: ag.periodePrecedenteDzd, ecartDzd: ag.ecartDzd, ecartPct: ag.ecartPct } : {}),
    ...Object.fromEntries(ag.parAxe.map((a) => [`par${a.axe.charAt(0).toUpperCase()}${a.axe.slice(1)}`, a.valeurs])),
    lignes: lignes.map((l) => ({ ...l, le: jour(l.le) })),
    note: "Montants en DZD, calculés en base sur les demandes visibles (chaque nature selon son module et sa portée). Montant retenu : accordé, sinon proposé, sinon demandé. Pour un graphique : analyser_donnees sur ce jeu (`depenses_marketing.parBu`, `depenses_marketing.parProduit`… ou `depenses_marketing.lignes`).",
  });
}

/** Les fiches médecins en double, PROPOSÉES au Super Admin — jamais fusionnées par l'assistant (décision 0062). */
async function lireDoublonsMedecins(entree: Record<string, unknown>, u: CurrentUser): Promise<string> {
  if (!peutDeciderFusionMedecins(u)) return refus("Lecture indisponible.");
  // « Y a-t-il un doublon de KHELIF ? » : les paires dont l'une des fiches porte tous les mots dits.
  const mots = motsDuNom(typeof entree.nom === "string" ? entree.nom : "").map(plier);
  const porte = (nom: string) => mots.every((m) => plier(nom).includes(m));
  const ps = (await propositionsFusionMedecins(u)).filter((p) => !mots.length || porte(p.garde.name) || porte(p.absorbee.name));
  return JSON.stringify({
    total: ps.length,
    propositions: ps.slice(0, 40).map((p) => ({
      garder: p.garde.name, absorber: p.absorbee.name, raisons: p.raisons,
      recoit: p.champsRecus, rattachesAbsorbee: p.absorbee.rattaches, rattachesGardee: p.garde.rattaches,
      wilaya: p.garde.wilaya ?? p.absorbee.wilaya, specialite: p.garde.specialite ?? p.absorbee.specialite,
    })),
    lien: "/annuaires/medecins/doublons",
    consigne: "Tu PROPOSES seulement : chaque fusion se décide par le Super Admin, d'un clic ✓ (fusionner, réversible) ou ✗ (écarter) "
      + "sur la page « Fiches médecins en double » — donne son lien en Markdown. Tu ne fusionnes JAMAIS toi-même, et tu ne dis pas que c'est fait.",
  });
}

export function lecturesAnnuaireTerrain(): PowerTool[] {
  return [
    outil("doublons_medecins",
      "LES FICHES MÉDECINS EN DOUBLE de l'annuaire, à proposer au Super Admin : pour chaque paire, la fiche gardée, la fiche absorbée, "
      + "les champs reçus, ce qui est rattaché (visites, comptes rendus…). Pour « y a-t-il des doublons de médecins ? », "
      + "« propose-moi les fusions de fiches médecins ». Le Super Admin tranche (✓ / ✗) sur la page des doublons, jamais l'assistant.",
      { nom: { type: "string", description: "Facultatif : un nom de médecin (« KHELIF ») pour ne voir que ses doublons." } },
      "Doublons de médecins proposés", (u) => peutDeciderFusionMedecins(u), lireDoublonsMedecins),
    outil("annuaire_terrain",
      "L'ANNUAIRE MÉDICAL ET PHARMACEUTIQUE : médecins (spécialité, établissement, téléphone, délégué, secteur, dernière visite) et "
      + "pharmacies / établissements (adresse, téléphone, SECTEURS et DÉLÉGUÉS QUI LES COUVRENT, BU). Filtres : `quoi` (medecin, pharmacie, "
      + "hopital, clinique, cabinet, grossiste, etablissement, tous), `nom`, `wilaya`, `specialite`, `delegue`, `manquant` (telephone, "
      + "specialite, email, adresse, etablissement). Rend aussi les COMPTES exacts (total, couverts par un secteur). Pour « qui couvre "
      + "la pharmacie X ? », « les médecins de mon panel sans téléphone », « combien de pharmacies à Oran ? », « doublons d'Oran ».",
      {
        quoi: { type: "string", enum: ["tous", "medecin", "pharmacie", "hopital", "clinique", "cabinet", "grossiste", "etablissement"] },
        nom: { type: "string", description: "Nom (ou mots du nom) du médecin ou de l'établissement." },
        wilaya: { type: "string" }, specialite: { type: "string" }, delegue: { type: "string", description: "Nom du délégué titulaire." },
        manquant: { type: "string", enum: ["telephone", "specialite", "email", "adresse", "etablissement"] },
        inclureInactifs: { type: "boolean" }, limite: { type: "number" },
      },
      "Annuaire médical consulté", voitAnnuaire, lireAnnuaire),
    outil("visites_terrain",
      "LES VISITES MÉDICALES et leurs comptes rendus : qui a vu quel médecin et quand, combien de visites par délégué, par médecin, "
      + "la COUVERTURE (médecins visités / médecins de l'annuaire visible, en %). Filtres : `medecin`, `delegue`, `jours` (défaut 30) ou "
      + "`depuis` (AAAA-MM-JJ), `aVenir` (visites planifiées). Pour « quel délégué a vu le Dr X en dernier ? », « mes visites du mois », "
      + "« quel délégué a fait le plus de visites ? », « quelle part des médecins a été visitée ? ».",
      {
        medecin: { type: "string" }, delegue: { type: "string", description: "Nom du délégué ; omis = toutes les visites visibles (un délégué : les siennes)." },
        jours: { type: "number" }, depuis: { type: "string", description: "AAAA-MM-JJ." }, aVenir: { type: "boolean" },
      },
      "Visites consultées", (u) => userCan(u, "MEDICAL", "VIEW"), lireVisites),
    outil("depenses_marketing",
      "LES DÉPENSES MARKETING / AD & PRO (sponsorings, autres demandes, congrès nationaux, événements) ventilées `par` bu, produit, nature, "
      + "mois ou demandeur, sur une `periode` (annee, trimestre, mois, mois_precedent, annee_precedente, ou `du`/`au` AAAA-MM-JJ), avec "
      + "`comparer` (true) à la période précédente (écart et %). Totaux EXACTS calculés en base. Pour « nos dépenses par BU », « compare "
      + "ce mois avec le mois dernier », « quel produit a reçu le plus », un graphique ou un Excel des dépenses (puis analyser_donnees / exporter_donnees).",
      {
        par: { type: "array", items: { type: "string", enum: ["bu", "produit", "nature", "mois", "demandeur"] } },
        periode: { type: "string", enum: [...PERIODES] }, du: { type: "string" }, au: { type: "string" }, comparer: { type: "boolean" },
      },
      "Dépenses marketing analysées", peutDepenses, lireDepenses),
  ];
}
