import { createHash } from "crypto";
import type { DoctorTitle, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reposerWilayaCode } from "@/lib/lieux/rattachement-prisma";
import { indexerSpecialites, cleDeSpecialite } from "@/lib/annuaires/specialites";
import { composeDoctorName } from "@/lib/medical/directory-grid";
import { titleFrom } from "@/lib/medical/directory-sheet";
import { ADVENTUM_COMPANY_ID } from "@/lib/company-defaut";
import { lireClasseur, proposerRegles, methodeDuFichier, reglesDuTexte, type LectureClasseur, type LigneClasseur } from "./lecture-classeur";
import { rapprocher, type Rapprochement } from "./rapprochement";
import { lireRegles, STATUTS, METHODE_LABELS, pct, type Lettre, type Regles, type Statut } from "./regles";
import { segmenterPraticien, derniere, effaceDeSource, type ContexteSegmentation, type Derogation, type FaitsPraticien, type Observation } from "./moteur";
import { secteurDuPraticien } from "./secteurs";
import { chargerContexte, chargerSecteurs, chargerStrategie, type StrategieChargee } from "./service";
import { lireFeuilles } from "./feuilles";
import {
  indexerEtablissementsSouple, cleSoupleEtablissement, wilayaDeLEtablissement, typeDEtablissementSouple, specialitesDuFichier,
  buDuFichier, annuaireDeLaBu, planDeLettre, motifLettreFichier, ajusterDecisions, memeReponse, compterLettres,
  type LettreFichier, type PlanLettre,
} from "./plan-import";

/**
 * IMPORTER LE CLASSEUR DE LA DIRECTION « EN UNE FOIS » (Direction, 08/10) — le côté BASE.
 *
 * Un fichier, une BU : la stratégie est créée si elle manque, le produit nommé par la question Q2 (« … sous
 * raltegravir ») est classé, les règles sont LUES dans la feuille (seuils, méthode Q2 ÷ Q1, NA = non applicable, grille
 * et capacité des KAM) et publiées, chaque ligne retrouve son praticien dans l'annuaire (ou le crée dans l'annuaire de
 * la BU, avec sa spécialité, son grade, son établissement et sa wilaya RELIÉS), sa fiche (statut, zone), ses réponses
 * Q1/Q2 historisées — et la lettre du FICHIER fait foi : quand le calcul en donne une autre, elle est gardée comme
 * décision motivée. Le résultat est exactement le fichier ; l'aperçu le dit avant que rien ne s'écrive.
 *
 * Réimporter le même fichier ne fait rien (empreinte). Un fichier MIS À JOUR met à jour réponses, statuts et lettres,
 * et dit ce qui change. Jamais un praticien en double.
 */

export interface ApercuDirection {
  ok: true;
  empreinte: string;
  dejaImporte: boolean;
  feuille: string;
  businessUnit: { id: string; nom: string };
  strategie: { id: string; nom: string } | null;
  produit: { id: string; nom: string } | null;
  produitMentionne: string | null;
  produitConcorde: boolean;
  annuaire: { id: string | null; nom: string };
  praticiens: number;
  nouveaux: number;
  existants: number;
  ambigus: { ligne: number; nom: string; candidats: number }[];
  doublons: { ligne: number; nom: string; ligneOrigine: number }[];
  etablissements: { rattaches: number; crees: { nom: string; wilaya: string | null }[]; aTrancher: string[] };
  specialites: { rattachees: number; creees: string[]; aTrancher: string[] };
  /** Les lettres APRÈS l'import (celles du fichier). */
  lettres: Record<Lettre, number>;
  /** Les lettres que le calcul donne autrement que le fichier — gardées telles quelles. */
  ecarts: { ligne: number; nom: string; zone: string | null; fichier: string; calcule: string }[];
  /** NA dans le fichier, une lettre au calcul (NA ne se force pas : la lettre calculée s'applique). */
  naSignales: { ligne: number; nom: string; calcule: string }[];
  /** Lettres forcées en vigueur que le fichier contredit — levées (jamais effacées). */
  decisionsALever: number;
  secteurs: { avec: number; sans: number; regionsSansSecteur: string[] };
  regles: { action: "publier" | "garder" | "aucune"; version: number | null; provenance: string[]; erreurs: string[] };
  /** Réimport d'un fichier mis à jour : ce qui change (null = premier import de la BU). */
  changements: { reponses: number; statuts: number; nouveauxAuPanel: number; lettres: { nom: string; avant: string; apres: string }[] } | null;
  anomalies: string[];
}

export interface BilanDirection {
  ok: true;
  strategieId: string;
  rien: boolean;
  crees: number;
  completes: number;
  fiches: number;
  observations: number;
  lettresGardees: number;
  decisionsLevees: number;
  etablissementsCrees: number;
  specialitesCreees: number;
  reglesVersion: number | null;
  annuaire: string;
}

type Echec = { ok: false; error: string };

interface Ligne {
  l: LigneClasseur;
  nom: string;
  r: Rapprochement;
  institutionId: string | null;
  etabACreer: string | null;
  specialtyId: string | null;
  specACreer: string | null;
  secteurId: string | null;
  secteurNom: string | null;
  secteurDeRegion: string | null;
  lettreCalculee: Lettre | null;
  plan: PlanLettre;
}

interface Prepare {
  apercu: ApercuDirection;
  lecture: LectureClasseur;
  lignes: Ligne[];
  strategie: StrategieChargee | null;
  productId: string | null;
  bu: { id: string; name: string; companyId: string | null };
  reglesAPublier: Regles | null;
  noteRegles: string;
  docs: Map<string, { institutionId: string | null; specialtyId: string | null; title: string; lastName: string | null; firstName: string | null; region: string | null; wilaya: string | null }>;
  obsParDoc: Map<string, Observation[]>;
  decisionsParDoc: Map<string, { id: string; nature: string; valeur: string }[]>;
  etabsACreer: Map<string, { nom: string; wilaya: string | null; zone: string | null }>;
  specsACreer: Map<string, string>;
  wilayaEtab: Map<string, string | null>;
}

const lettreFichier = (s: LigneClasseur["segmentFichier"]): LettreFichier | null => s;
const estStatut = (s: string | null | undefined): s is Statut => !!s && (STATUTS as readonly string[]).includes(s);

/** Les BU actives, avec les spécialités qu'elles visent — pour l'écran et pour reconnaître celle du fichier. */
export async function busPourImport(): Promise<{ id: string; name: string; specialites: string[] }[]> {
  const bus = await prisma.businessUnit.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, specialites: { select: { specialty: { select: { name: true } } } } },
  });
  return bus.map((b) => ({ id: b.id, name: b.name, specialites: b.specialites.map((s) => s.specialty.name) }));
}

async function preparer(buffer: Buffer, nomFichier: string, businessUnitId: string | null): Promise<Prepare | Echec> {
  const feuilles = lireFeuilles(buffer);
  const lecture = lireClasseur(feuilles);
  if (!lecture) return { ok: false, error: "Aucune feuille de ce classeur n'a la forme d'une segmentation (Région, CDR, Nom, Prénom, Statut, Question 1…)." };
  if (lecture.lignes.length === 0) return { ok: false, error: `La feuille « ${lecture.feuille} » n'a aucune ligne de praticien.` };

  // ── LA BU : celle choisie, sinon celle que nomme la spécialité dominante du fichier.
  const bus = await busPourImport();
  const buId = businessUnitId && bus.some((b) => b.id === businessUnitId) ? businessUnitId : buDuFichier(bus, lecture.lignes.map((l) => l.specialite));
  if (!buId) return { ok: false, error: "Choisissez la Business Unit du fichier." };
  const bu = await prisma.businessUnit.findUnique({ where: { id: buId }, select: { id: true, name: true, companyId: true } });
  if (!bu) return { ok: false, error: "Business Unit introuvable." };
  const anomalies = [...lecture.anomalies];

  // ── LA STRATÉGIE de la BU (une seule active) et son produit #1 — sinon le produit nommé par la question Q2.
  const s0 = await prisma.segmentationStrategie.findFirst({ where: { businessUnitId: bu.id, statut: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const strategie = s0 ? await chargerStrategie(s0.id) : null;
  const mention = lecture.produitMentionne;
  const radical = mention ? cleSoupleEtablissement(mention).split(" ")[0] : "";
  const nomme = (...t: (string | null | undefined)[]) => !!radical && t.some((x) => cleSoupleEtablissement(String(x ?? "")).includes(radical));
  let produit: { id: string; nom: string } | null = null;
  let produitConcorde = true;
  if (strategie?.produits[0]) {
    const p = strategie.produits[0];
    produit = { id: p.productId, nom: p.nom };
    produitConcorde = !mention || nomme(p.nom, p.dci);
    if (!produitConcorde) anomalies.push(`Le fichier parle de « ${mention} » ; le produit #1 de la stratégie est ${p.nom} : les réponses Q2 lui seront attribuées.`);
  } else {
    const catalogue = await prisma.promoProduct.findMany({
      where: { businessUnitId: bu.id, isActive: true, productId: { not: null } },
      select: { name: true, productId: true, canonicalProduct: { select: { canonicalName: true, dci: true } } },
    });
    const c = catalogue.find((x) => nomme(x.name, x.canonicalProduct?.canonicalName, x.canonicalProduct?.dci));
    if (c?.productId) produit = { id: c.productId, nom: c.canonicalProduct?.canonicalName ?? c.name };
    else produitConcorde = false;
  }
  const productId = produit?.id ?? null;

  // L'empreinte : le même fichier ne s'importe qu'une fois — sauf s'il l'a été SANS produit (les réponses manquaient).
  const empreinte = createHash("sha256").update(buffer).digest("hex") + (productId ? "" : ":sans-produit");
  const deja = strategie ? await prisma.segmentationImport.findUnique({ where: { strategieId_empreinte: { strategieId: strategie.id, empreinte } }, select: { id: true } }) : null;

  // ── ÉTABLISSEMENTS : nom exact, puis nom « souple » (« CHU d'Oran » ≡ « CHU Oran ») ; sinon créés avec leur wilaya.
  const etabs = await prisma.medicalInstitution.findMany({ select: { id: true, name: true, isActive: true, wilaya: true } });
  const trouverEtab = indexerEtablissementsSouple(etabs);
  const wilayaEtab = new Map(etabs.map((e) => [e.id, e.wilaya]));
  const etabsACreer = new Map<string, { nom: string; wilaya: string | null; zone: string | null }>();
  const aTrancher = new Set<string>();
  const rattaches = new Set<string>();
  /** Résout un nom ; `noter` = la ligne en a besoin (compté, et créé s'il manque). */
  const etabDe = (nom: string | null, zone: string | null, noter: boolean): { id: string | null; creer: string | null } => {
    if (!nom) return { id: null, creer: null };
    const r = trouverEtab(nom);
    if (r.statut === "trouve") { if (noter) rattaches.add(r.etablissement.id); return { id: r.etablissement.id, creer: null }; }
    if (!noter) return { id: null, creer: null };
    if (r.statut === "inconnu") {
      const cle = cleSoupleEtablissement(nom);
      if (!etabsACreer.has(cle)) etabsACreer.set(cle, { nom, wilaya: wilayaDeLEtablissement(nom), zone });
      return { id: null, creer: cle };
    }
    aTrancher.add(r.statut === "inactif" ? `${nom} (désactivé dans l'annuaire)` : `${nom} (${r.candidats.length} établissements possibles)`);
    return { id: null, creer: null };
  };

  // ── SPÉCIALITÉS : reliées au référentiel ; les écritures d'une même spécialité n'en font qu'une.
  const specs = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
  const trouverSpec = indexerSpecialites(specs);
  const libelles = specialitesDuFichier(lecture.lignes.map((l) => l.specialite));
  const specsACreer = new Map<string, string>();
  const specsRattachees = new Set<string>();
  const specsATrancher = new Set<string>();
  const specDe = (nom: string | null): { id: string | null; creer: string | null } => {
    if (!nom) return { id: null, creer: null };
    const r = trouverSpec(nom);
    if (r.statut === "trouve") { specsRattachees.add(r.specialite.id); return { id: r.specialite.id, creer: null }; }
    if (r.statut === "vide") return { id: null, creer: null };
    if (r.statut === "ambigu") { specsATrancher.add(nom); return { id: null, creer: null }; }
    const cle = cleDeSpecialite(nom);
    specsACreer.set(cle, libelles.get(cle) ?? nom);
    return { id: null, creer: cle };
  };

  // ── PRATICIENS : rapprochés de l'annuaire (nom + prénom, établissement pour départager).
  const docsBruts = await prisma.medicalDoctor.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, lastName: true, firstName: true, institutionId: true, specialtyId: true, title: true, region: true, wilaya: true, serviceId: true, delegateId: true },
  });
  const docs = new Map(docsBruts.map((d) => [d.id, d]));
  const rappro = rapprocher(lecture.lignes, docsBruts, (nom) => etabDe(nom, null, false).id);
  const ids = [...new Set([...rappro.values()].flatMap((r) => (r.statut === "existant" ? [r.doctorId] : [])))];

  // ── CE QUI EXISTE DÉJÀ pour ces praticiens dans la stratégie : fiches, réponses, décisions en vigueur.
  const fiches = strategie ? await prisma.segmentationFiche.findMany({ where: { strategieId: strategie.id, doctorId: { in: ids } }, select: { doctorId: true, statut: true, zone: true, secteurId: true, retireeLe: true } }) : [];
  const ficheDe = new Map(fiches.map((f) => [f.doctorId, f]));
  const obs = ids.length ? await prisma.hcpObservation.findMany({
    where: { doctorId: { in: ids }, OR: [{ strategieId: strategie?.id ?? "__aucune" }, { strategieId: null }] },
    select: { doctorId: true, productId: true, potentiel: true, prescriptionsSur10: true, observeLe: true, source: true },
  }) : [];
  const obsParDoc = new Map<string, Observation[]>();
  for (const o of obs) obsParDoc.set(o.doctorId, [...(obsParDoc.get(o.doctorId) ?? []), { productId: o.productId, potentiel: o.potentiel === null ? null : Number(o.potentiel), prescriptionsSur10: o.prescriptionsSur10 === null ? null : Number(o.prescriptionsSur10), observeLe: o.observeLe, efface: effaceDeSource(o.source) }]);
  const decs = strategie && ids.length ? await prisma.segmentationDerogation.findMany({
    where: { strategieId: strategie.id, doctorId: { in: ids }, leveeLe: null, OR: [{ nature: "CIBLAGE" }, { nature: "SEGMENT", productId }] },
    select: { id: true, doctorId: true, nature: true, valeur: true, motif: true, expireLe: true, productId: true },
  }) : [];
  const decisionsParDoc = new Map<string, typeof decs>();
  for (const d of decs) decisionsParDoc.set(d.doctorId, [...(decisionsParDoc.get(d.doctorId) ?? []), d]);

  // ── SECTEURS : la « Région » qui nomme un secteur de la BU, sinon le secteur qui couvre l'établissement.
  const secteurs = await chargerSecteurs(bu.id);
  const actifs = secteurs.filter((s) => s.actif);
  const parNomSecteur = new Map(actifs.map((s) => [cleSoupleEtablissement(s.nom), s]));
  const secteurDeZone = (zone: string) => { const s = parNomSecteur.get(cleSoupleEtablissement(zone)); return s ? { id: s.id, nom: s.nom } : null; };

  // ── LES RÈGLES : celles en vigueur, ALIGNÉES sur ce que le fichier énonce ; sinon la v1 lue dans la feuille.
  const provenance: string[] = [];
  let erreursRegles: string[] = [];
  let reglesApres: Regles | null = null;
  let reglesAPublier: Regles | null = null;
  let action: ApercuDirection["regles"]["action"] = "aucune";
  let version: number | null = null;
  const enVigueur = strategie?.regle?.regles ?? null;
  if (!productId) {
    provenance.push(`Produit${mention ? ` « ${mention} »` : ""} absent du catalogue de la BU : annuaire et panel importés ; règles, réponses et lettres à importer de nouveau une fois le produit ajouté (Force de vente › Business Units).`);
  } else if (enVigueur && enVigueur.produits.some((p) => p.productId === productId)) {
    const aligne = aligner(enVigueur, productId, lecture, provenance);
    reglesApres = aligne;
    if (JSON.stringify(aligne) !== JSON.stringify(enVigueur)) { reglesAPublier = aligne; action = "publier"; version = (strategie!.regle!.version ?? 0) + 1; }
    else { action = "garder"; version = strategie!.regle!.version; provenance.push(`Règles v${version} en vigueur : déjà conformes au fichier.`); }
  } else {
    const p = proposerRegles(lecture, feuilles, productId, { exceptionsDeduites: false, grille: true, secteurDeZone });
    provenance.push(...p.provenance);
    const lu = lireRegles(p.contenu);
    if (lu.ok) { reglesApres = lu.regles; reglesAPublier = lu.regles; action = "publier"; version = (strategie?.regle?.version ?? 0) + 1; }
    else erreursRegles = lu.erreurs;
  }
  const contexte: ContexteSegmentation = productId ? await chargerContexte(bu.id, [productId]) : {};
  const maintenant = new Date();

  // ── LIGNE PAR LIGNE : la lettre calculée avec les réponses du fichier, et ce que l'import fait de celle du fichier.
  const lignes: Ligne[] = [];
  const ambigus: ApercuDirection["ambigus"] = [];
  const doublons: ApercuDirection["doublons"] = [];
  const ecarts: ApercuDirection["ecarts"] = [];
  const naSignales: ApercuDirection["naSignales"] = [];
  const lettresApres: Lettre[] = [];
  const changementsLettres: { nom: string; avant: string; apres: string }[] = [];
  let reponses = 0, statuts = 0, nouveauxAuPanel = 0, avecSecteur = 0, decisionsALever = 0;
  const regionsSansSecteur = new Set<string>();
  for (const l of lecture.lignes) {
    const r = rappro.get(l.ligne)!;
    const nom = [l.nom, l.prenom].filter(Boolean).join(" ");
    if (r.statut === "ambigu") { ambigus.push({ ligne: l.ligne, nom, candidats: r.candidats.length }); continue; }
    if (r.statut === "doublon") { doublons.push({ ligne: l.ligne, nom, ligneOrigine: r.ligneOrigine }); continue; }
    const doc = r.statut === "existant" ? docs.get(r.doctorId)! : null;
    // L'annuaire est gardé : l'établissement et la spécialité du fichier ne servent qu'aux champs VIDES.
    const e = doc?.institutionId ? { id: null, creer: null } : etabDe(l.etablissement, l.zone, true);
    const sp = doc?.specialtyId ? { id: null, creer: null } : specDe(l.specialite);
    if (doc?.institutionId) rattaches.add(doc.institutionId);
    const institutionId = doc?.institutionId ?? e.id;
    const specialtyId = doc?.specialtyId ?? sp.id;
    const fiche = doc ? ficheDe.get(doc.id) : undefined;
    const parRegion = l.zone ? secteurDeZone(l.zone) : null;
    const couvert = parRegion ? null : secteurDuPraticien({ institutionId, serviceId: doc?.serviceId ?? null, delegateId: doc?.delegateId ?? null }, secteurs);
    const secteur = parRegion ?? (couvert ? { id: couvert.id, nom: couvert.nom } : null);
    if (secteur) avecSecteur++; else if (l.zone) regionsSansSecteur.add(l.zone);

    const obsAvant = doc ? obsParDoc.get(doc.id) ?? [] : [];
    const obsFichier: Observation[] = productId && (l.potentiel !== null || l.sur10 !== null) ? [{ productId, potentiel: l.potentiel, prescriptionsSur10: l.sur10, observeLe: maintenant }] : [];
    const enCours = (doc ? decisionsParDoc.get(doc.id) ?? [] : []);
    const derogs: Derogation[] = enCours.filter((d) => d.nature === "CIBLAGE" || d.nature === "SEGMENT").map((d) => ({ nature: d.nature as "CIBLAGE" | "SEGMENT", productId: d.productId, valeur: d.valeur, motif: d.motif, expireLe: d.expireLe }));
    const faits: FaitsPraticien = {
      doctorId: doc?.id ?? `ligne-${l.ligne}`, statut: l.statut, zone: l.zone, observations: [...obsAvant, ...obsFichier], derogations: [],
      specialiteId: specialtyId ?? (sp.creer ? `nouvelle:${sp.creer}` : null), institutionId: institutionId ?? null, inOut: null,
      secteurId: secteur?.id ?? null, secteurNom: secteur?.nom ?? null,
    };
    let lettreCalculee: Lettre | null = null;
    let plan: PlanLettre = { action: "aucune" };
    if (reglesApres) {
      const calc = segmenterPraticien(faits, reglesApres, maintenant, contexte);
      lettreCalculee = calc.lettreCalculee;
      plan = planDeLettre(lettreFichier(l.segmentFichier), lettreCalculee);
      const apres: Lettre = plan.action === "garder" ? plan.valeur : plan.action === "calcul" ? lettreCalculee : segmenterPraticien({ ...faits, derogations: derogs }, reglesApres, maintenant, contexte).lettre;
      lettresApres.push(apres);
      if (plan.action === "garder") ecarts.push({ ligne: l.ligne, nom, zone: l.zone, fichier: plan.valeur, calcule: lettreCalculee });
      if (plan.action === "signaler") naSignales.push({ ligne: l.ligne, nom, calcule: lettreCalculee });
      if (productId) decisionsALever += ajusterDecisions(plan, enCours.map((d) => ({ id: d.id, nature: d.nature, valeur: d.valeur }))).lever.length;
      // Ce qui change pour un praticien déjà au panel (réimport d'un fichier mis à jour).
      if (doc && fiche && !fiche.retireeLe && enVigueur) {
        const avant = segmenterPraticien({ ...faits, statut: estStatut(fiche.statut) ? fiche.statut : null, zone: fiche.zone, observations: obsAvant, derogations: derogs }, enVigueur, maintenant, contexte).lettre;
        if (avant !== apres) changementsLettres.push({ nom, avant, apres });
      }
    }
    if (!fiche || fiche.retireeLe) nouveauxAuPanel++;
    else {
      if ((fiche.statut ?? null) !== (l.statut ?? null)) statuts++;
      if (productId && doc) {
        const q1 = derniere(obsAvant, "potentiel", productId)?.valeur ?? null, q2 = derniere(obsAvant, "prescriptionsSur10", productId)?.valeur ?? null;
        if ((l.potentiel !== null && !memeReponse(q1, l.potentiel)) || (l.sur10 !== null && !memeReponse(q2, l.sur10))) reponses++;
      }
    }
    lignes.push({
      l, nom, r, institutionId, etabACreer: e.creer, specialtyId, specACreer: sp.creer,
      secteurId: secteur?.id ?? null, secteurNom: secteur?.nom ?? null, secteurDeRegion: parRegion?.id ?? null, lettreCalculee, plan,
    });
  }
  if (productId && reglesApres === null && erreursRegles.length === 0 && action === "aucune") provenance.push("Aucune règle lisible.");
  for (const n of naSignales) anomalies.push(`Ligne ${n.ligne} (${n.nom}) : NA dans le fichier, ${n.calcule} au calcul — NA ne se force pas, la lettre calculée s'applique.`);

  // ── L'ANNUAIRE de la BU : celui qui porte son nom, sinon un annuaire « BU <nom> » créé avec l'import.
  const annuaires = await prisma.medicalDirectory.findMany({ select: { id: true, name: true } });
  const annuaireId = annuaireDeLaBu(annuaires, bu.name);
  const annuaire = annuaireId ? { id: annuaireId, nom: annuaires.find((a) => a.id === annuaireId)!.name } : { id: null, nom: `BU ${bu.name}` };

  const premier = !strategie || (await prisma.segmentationFiche.count({ where: { strategieId: strategie.id } })) === 0;
  const nouveaux = lignes.filter((x) => x.r.statut === "nouveau").length;
  const apercu: ApercuDirection = {
    ok: true, empreinte, dejaImporte: !!deja, feuille: lecture.feuille,
    businessUnit: { id: bu.id, nom: bu.name },
    strategie: strategie ? { id: strategie.id, nom: strategie.nom } : null,
    produit, produitMentionne: mention, produitConcorde, annuaire,
    praticiens: lecture.lignes.length, nouveaux, existants: lignes.length - nouveaux, ambigus, doublons,
    etablissements: {
      rattaches: rattaches.size,
      crees: [...etabsACreer.values()].map((x) => ({ nom: x.nom, wilaya: x.wilaya })),
      aTrancher: [...aTrancher],
    },
    specialites: { rattachees: specsRattachees.size, creees: [...specsACreer.values()], aTrancher: [...specsATrancher] },
    lettres: compterLettres(lettresApres), ecarts, naSignales, decisionsALever,
    secteurs: { avec: avecSecteur, sans: lignes.length - avecSecteur, regionsSansSecteur: [...regionsSansSecteur] },
    regles: { action, version, provenance, erreurs: erreursRegles },
    changements: premier ? null : { reponses, statuts, nouveauxAuPanel, lettres: changementsLettres },
    anomalies,
  };
  const noteRegles = `Lues dans « ${nomFichier} » (feuille ${lecture.feuille}) à l'import.`;
  return {
    apercu, lecture, lignes, strategie, productId, bu, reglesAPublier, noteRegles,
    docs: new Map(docsBruts.map((d) => [d.id, d])), obsParDoc,
    decisionsParDoc: new Map([...decisionsParDoc].map(([k, v]) => [k, v.map((d) => ({ id: d.id, nature: d.nature, valeur: d.valeur }))])),
    etabsACreer, specsACreer, wilayaEtab,
  };
}

/**
 * LES RÈGLES EN VIGUEUR, ALIGNÉES sur ce que le fichier ÉNONCE pour le produit : méthode d'affinité (la colonne « % »
 * = Q2 ÷ Q1), seuils écrits, comparaison stricte, NA = non applicable, repère. Le reste (grille, capacité, exceptions
 * de secteur) est gardé tel quel. Chaque différence est dite.
 */
function aligner(regles: Regles, productId: string, lecture: LectureClasseur, provenance: string[]): Regles {
  const out: Regles = structuredClone(regles);
  const p = out.produits.find((x) => x.productId === productId)!;
  const txt = reglesDuTexte(lecture.texte);
  const meth = methodeDuFichier(lecture.lignes).methode;
  if (meth && p.methodeAffinite !== meth) { provenance.push(`Méthode d'affinité : ${METHODE_LABELS[meth]} (au lieu de ${METHODE_LABELS[p.methodeAffinite]}) — la colonne « % » du fichier.`); p.methodeAffinite = meth; }
  if (txt.seuilPotentiel !== null && p.seuilPotentiel !== txt.seuilPotentiel) { provenance.push(`Haut potentiel : à partir de ${txt.seuilPotentiel} (au lieu de ${p.seuilPotentiel}) — lu dans la feuille.`); p.seuilPotentiel = txt.seuilPotentiel; }
  if (txt.seuilAffinite !== null && Math.abs(p.seuilAffinite - txt.seuilAffinite) > 1e-9) { provenance.push(`Affinité : ${pct(txt.seuilAffinite)} (au lieu de ${pct(p.seuilAffinite)}) — lu dans la feuille.`); p.seuilAffinite = txt.seuilAffinite; }
  if (txt.seuilAffinite !== null && p.comparaisonAffinite !== txt.comparaisonAffinite) { provenance.push(`Affinité ${txt.comparaisonAffinite === ">" ? "strictement au-delà du seuil" : "à partir du seuil"} — lu dans la feuille.`); p.comparaisonAffinite = txt.comparaisonAffinite; }
  if (txt.reference && (!p.reference || Math.abs(p.reference.valeur - txt.reference.valeur) > 1e-9)) { provenance.push(`Repère : moyenne ${txt.reference.annee} de ${pct(txt.reference.valeur)} — lu dans la feuille.`); p.reference = txt.reference; }
  const na = txt.naNonApplicable && lecture.lignes.some((l) => l.segmentFichier === "NA" && l.potentiel === 0);
  if (na && !out.ciblage.potentielNulNA) { provenance.push("0 patient déclaré → NA (non applicable) — défini dans la feuille."); out.ciblage.potentielNulNA = true; }
  if (!out.h.statuts.includes("DECIDEUR") && lecture.lignes.some((l) => l.statut === "DECIDEUR" && l.segmentFichier === "H")) { provenance.push("Décideur → H — d'après les lignes classées H."); out.h.statuts = [...out.h.statuts, "DECIDEUR"]; }
  return out;
}

export async function apercuImportDirection(buffer: Buffer, nomFichier: string, businessUnitId: string | null): Promise<ApercuDirection | Echec> {
  const p = await preparer(buffer, nomFichier, businessUnitId);
  return "apercu" in p ? p.apercu : p;
}

/**
 * APPLIQUE l'import en UNE transaction : stratégie et produit classé, annuaire de la BU, spécialités et établissements
 * manquants, praticiens (créés, ou complétés sur leurs champs VIDES — jamais écrasés), fiches, réponses historisées
 * (seulement celles qui changent), règles publiées, et les lettres du fichier gardées là où le calcul diffère.
 */
export async function appliquerImportDirection(
  auteurId: string, buffer: Buffer, nomFichier: string, businessUnitId: string | null, opts: { peutForcer: boolean },
): Promise<BilanDirection | Echec> {
  const prep = await preparer(buffer, nomFichier, businessUnitId);
  if (!("apercu" in prep)) return prep;
  const { apercu, lecture, lignes, bu, productId } = prep;
  const vide = { crees: 0, completes: 0, fiches: 0, observations: 0, lettresGardees: 0, decisionsLevees: 0, etablissementsCrees: 0, specialitesCreees: 0, reglesVersion: null, annuaire: apercu.annuaire.nom };
  if (apercu.dejaImporte && prep.strategie) return { ok: true, strategieId: prep.strategie.id, rien: true, ...vide };
  // Garder une lettre du fichier (ou lever une lettre forcée) revient à FORCER : le droit du Super Admin.
  if ((apercu.ecarts.length > 0 || apercu.decisionsALever > 0) && !opts.peutForcer) {
    return { ok: false, error: `Ce fichier porte ${apercu.ecarts.length + apercu.decisionsALever} lettre(s) posée(s) à la main : les garder demande le droit de forcer le potentiel (Super Admin).` };
  }
  const maintenant = new Date();
  const motif = motifLettreFichier(nomFichier, maintenant);

  // LES FICHES TOUCHÉES, pour la double écriture des lieux (refonte V2-D), faite APRÈS la transaction.
  const lieux = { medecins: [] as string[], etablissements: [] as string[] };
  const resultat = await prisma.$transaction(async (tx) => {
    // 1. La stratégie de la BU, et son produit #1.
    let strategieId = prep.strategie?.id ?? null;
    if (!strategieId) {
      const s = await tx.segmentationStrategie.create({
        data: { businessUnitId: bu.id, nom: `Segmentation ${bu.name}`, createdById: auteurId, ...(productId ? { produits: { create: [{ productId, rang: 1, createdById: auteurId }] } } : {}) },
        select: { id: true },
      });
      strategieId = s.id;
    } else if (productId && prep.strategie!.produits.length === 0) {
      await tx.segmentationStrategieProduit.create({ data: { strategieId, productId, rang: 1, createdById: auteurId } });
    }
    const imp = await tx.segmentationImport.create({
      data: { strategieId, nomFichier, empreinte: apercu.empreinte, taille: buffer.length, feuille: apercu.feuille, rapport: apercu as unknown as Prisma.InputJsonValue, auteurId },
      select: { id: true },
    });

    // 2. L'annuaire de la BU.
    const directoryId = apercu.annuaire.id ?? (await tx.medicalDirectory.create({
      data: { name: apercu.annuaire.nom, description: `Praticiens de la BU ${bu.name} — créé par l'import de segmentation « ${nomFichier} ».`, companyId: bu.companyId, createdById: auteurId },
      select: { id: true },
    })).id;

    // 3. Référentiels manquants : spécialités, établissements (avec leur wilaya quand le nom la dit).
    const specCree = new Map<string, string>();
    for (const [cle, nom] of prep.specsACreer) {
      const s = await tx.medicalSpecialty.upsert({ where: { name: nom }, update: {}, create: { name: nom, createdById: auteurId }, select: { id: true } });
      specCree.set(cle, s.id);
    }
    const etabCree = new Map<string, { id: string; wilaya: string | null }>();
    for (const [cle, e] of prep.etabsACreer) {
      const x = await tx.medicalInstitution.create({
        data: { name: e.nom, type: typeDEtablissementSouple(e.nom), wilaya: e.wilaya, region: e.zone, createdById: auteurId, notes: `Créé par l'import de segmentation « ${nomFichier} ».` },
        select: { id: true },
      });
      etabCree.set(cle, { id: x.id, wilaya: e.wilaya });
      lieux.etablissements.push(x.id);
    }

    // 4. Les lignes.
    let crees = 0, completes = 0, fiches = 0, observations = 0, lettresGardees = 0, decisionsLevees = 0;
    for (const x of lignes) {
      const { l } = x;
      const institutionId = x.institutionId ?? (x.etabACreer ? etabCree.get(x.etabACreer)?.id ?? null : null);
      const wilaya = x.institutionId ? prep.wilayaEtab.get(x.institutionId) ?? null : x.etabACreer ? etabCree.get(x.etabACreer)?.wilaya ?? null : null;
      const specialtyId = x.specialtyId ?? (x.specACreer ? specCree.get(x.specACreer) ?? null : null);
      const specialite = x.specACreer ? prep.specsACreer.get(x.specACreer) ?? l.specialite : l.specialite;
      const title = titleFrom(l.grade) as DoctorTitle;
      let doctorId: string;
      if (x.r.statut === "existant") {
        doctorId = x.r.doctorId;
        const c = prep.docs.get(doctorId)!;
        const data: Prisma.MedicalDoctorUncheckedUpdateInput = {};
        if (!c.institutionId && institutionId) { data.institutionId = institutionId; data.institution = l.etablissement; }
        if (!c.specialtyId && specialtyId) { data.specialtyId = specialtyId; data.specialty = specialite; }
        if (c.title === "AUTRE" && title !== "AUTRE") data.title = title;
        if (!c.lastName && !c.firstName) { data.lastName = l.nom; data.firstName = l.prenom; }
        if (!c.region && l.zone) data.region = l.zone;
        if (!c.wilaya && wilaya) data.wilaya = wilaya;
        if (Object.keys(data).length) { await tx.medicalDoctor.update({ where: { id: doctorId }, data: { ...data, updatedById: auteurId } }); completes++; }
      } else {
        const d = await tx.medicalDoctor.create({
          data: {
            name: composeDoctorName(l.prenom, l.nom), lastName: l.nom, firstName: l.prenom, title, sector: "HOSPITAL",
            institutionId, institution: l.etablissement, specialtyId, specialty: specialite, region: l.zone, wilaya,
            directoryId, companyId: bu.companyId ?? ADVENTUM_COMPANY_ID, createdById: auteurId,
            // Un grade que la liste ne connaît pas (« KOL », « Retraité ») reste lisible tel que le fichier l'écrit.
            ...(title === "AUTRE" && l.grade ? { comments: `Grade : ${l.grade}` } : {}),
          },
          select: { id: true },
        });
        doctorId = d.id;
        crees++;
      }
      lieux.medecins.push(doctorId);
      await tx.segmentationFiche.upsert({
        where: { strategieId_doctorId: { strategieId, doctorId } },
        update: { statut: l.statut, zone: l.zone, ...(x.secteurDeRegion ? { secteurId: x.secteurDeRegion } : {}), source: "IMPORT", importId: imp.id, ligneSource: l.ligne, retireeLe: null, updatedById: auteurId },
        create: { strategieId, doctorId, statut: l.statut, zone: l.zone, secteurId: x.secteurDeRegion, source: "IMPORT", importId: imp.id, ligneSource: l.ligne, createdById: auteurId },
      });
      fiches++;
      // Les réponses : historisées, seulement quand elles changent (réimporter le même chiffre n'ajoute rien).
      if (productId && (l.potentiel !== null || l.sur10 !== null)) {
        const avant = prep.obsParDoc.get(doctorId) ?? [];
        const q1 = derniere(avant, "potentiel", productId)?.valeur ?? null, q2 = derniere(avant, "prescriptionsSur10", productId)?.valeur ?? null;
        if ((l.potentiel !== null && !memeReponse(q1, l.potentiel)) || (l.sur10 !== null && !memeReponse(q2, l.sur10))) {
          await tx.hcpObservation.create({
            data: {
              doctorId, strategieId, productId, potentiel: l.potentiel, prescriptionsSur10: l.sur10, metrique: lecture.metrique,
              source: "IMPORT", importId: imp.id, ligneSource: l.ligne, auteurId, observeLe: maintenant, commentaire: `Import « ${nomFichier} », ligne ${l.ligne}.`,
            },
          });
          observations++;
        }
      }
      // La lettre du fichier : gardée là où le calcul diffère ; une décision contraire en vigueur est levée.
      if (productId && x.lettreCalculee) {
        const { lever, poser } = ajusterDecisions(x.plan, prep.decisionsParDoc.get(doctorId) ?? []);
        if (lever.length) { await tx.segmentationDerogation.updateMany({ where: { id: { in: lever } }, data: { leveeLe: maintenant, leveeParId: auteurId } }); decisionsLevees += lever.length; }
        if (poser) {
          await tx.segmentationDerogation.create({ data: { strategieId, doctorId, nature: "SEGMENT", productId, valeur: poser, valeurCalculee: x.lettreCalculee, motif, source: "IMPORT", importId: imp.id, auteurId } });
          lettresGardees++;
        }
      }
    }

    // 5. Les règles lues dans le fichier.
    let reglesVersion: number | null = null;
    if (prep.reglesAPublier && apercu.regles.version) {
      await tx.segmentationRegle.create({ data: { strategieId, version: apercu.regles.version, contenu: prep.reglesAPublier as unknown as Prisma.InputJsonValue, note: prep.noteRegles, publieeParId: auteurId } });
      reglesVersion = apercu.regles.version;
    }
    return {
      ok: true as const, strategieId, rien: false, crees, completes, fiches, observations, lettresGardees, decisionsLevees,
      etablissementsCrees: etabCree.size, specialitesCreees: specCree.size, reglesVersion, annuaire: apercu.annuaire.nom,
    };
  }, { timeout: 300_000, maxWait: 20_000 });
  await reposerWilayaCode("MedicalInstitution", lieux.etablissements);
  await reposerWilayaCode("MedicalDoctor", lieux.medecins);
  return resultat;
}

