import { createHash } from "crypto";
import { lireFeuilles } from "./feuilles";
import type { DoctorTitle, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { indexerEtablissements, cleDEtablissement } from "@/lib/annuaires/rattachement";
import { indexerSpecialites } from "@/lib/annuaires/specialites";
import { composeDoctorName } from "@/lib/medical/directory-grid";
import { titleFrom } from "@/lib/medical/directory-sheet";
import { ADVENTUM_COMPANY_ID } from "@/lib/company-defaut";
import { lireClasseur, proposerRegles, type Feuilles, type LectureClasseur, type PropositionRegles } from "./lecture-classeur";
import { rapprocher, typeDEtablissement, type Rapprochement } from "./rapprochement";
import { lireRegles, STATUTS, type InOut, type Regles, type Statut } from "./regles";
import { inOutDe, pivotDuSecteur, wilayaDuPraticien } from "./in-out";
import { gradeBrutDe } from "./tableau-praticiens";
import { secteurDuPraticien, type SecteurBu } from "./secteurs";

export { secteurDuPraticien, type SecteurBu };
import { clausePanelDuKam } from "@/lib/rbac";
import { segmenterPraticien, derniere, effaceDeSource, type ContexteSegmentation, type FaitsPraticien, type ResultatPraticien } from "./moteur";
import { affinitesEtablissements } from "@/modules/consommation/api";

/**
 * SEGMENTATION STUDIO — le côté BASE : charger une stratégie et ses faits, préparer puis appliquer
 * l'import d'un classeur. Les décisions vivent dans les modules purs (`regles`, `moteur`,
 * `lecture-classeur`, `rapprochement`) ; ici, on lit et on écrit, dans une transaction.
 */

export interface ProduitClasse { productId: string; rang: number; nom: string; dci: string }

export interface StrategieChargee {
  id: string;
  nom: string;
  statut: string;
  businessUnit: { id: string; name: string };
  produits: ProduitClasse[];
  regle: { id: string; version: number; contenu: unknown; regles: Regles | null; erreurs: string[]; publieeLe: Date; note: string | null; publieeParId: string | null } | null;
  /** Ce que le moteur lit autour des règles : spécialités visées par produit, affinité par établissement. */
  contexte: ContexteSegmentation;
}

export async function chargerStrategie(id: string): Promise<StrategieChargee | null> {
  const s = await prisma.segmentationStrategie.findUnique({
    where: { id },
    select: {
      id: true, nom: true, statut: true, businessUnit: { select: { id: true, name: true } },
      produits: { where: { jusqua: null }, orderBy: { rang: "asc" }, select: { productId: true, rang: true, product: { select: { canonicalName: true, dci: true } } } },
      regles: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, contenu: true, publieeLe: true, note: true, publieeParId: true } },
    },
  });
  if (!s) return null;
  const r = s.regles[0];
  const lu = r ? lireRegles(r.contenu) : null;
  const productIds = s.produits.map((p) => p.productId);
  return {
    id: s.id, nom: s.nom, statut: s.statut, businessUnit: s.businessUnit,
    produits: s.produits.map((p) => ({ productId: p.productId, rang: p.rang, nom: p.product.canonicalName, dci: p.product.dci })),
    regle: r ? { ...r, regles: lu?.ok ? lu.regles : null, erreurs: lu && !lu.ok ? lu.erreurs : [] } : null,
    contexte: await chargerContexte(s.businessUnit.id, productIds),
  };
}

/**
 * LE CONTEXTE RELIÉ d'une stratégie — lu à chaque calcul (un cycle le fige) :
 *   • les spécialités que chaque produit vise dans la BU (`PromoProductSpecialite` sur le `PromoProduct` BU × produit) ;
 *   • l'affinité de chaque établissement pour chaque produit, calculée sur la consommation importée.
 */
export async function chargerContexte(businessUnitId: string, productIds: string[]): Promise<ContexteSegmentation> {
  const promos = await prisma.promoProduct.findMany({
    where: { businessUnitId, productId: { in: productIds } },
    select: { productId: true, specialitesCibles: { select: { specialtyId: true, specialty: { select: { name: true } } } } },
  });
  const specialitesParProduit: Record<string, string[]> = {};
  const nomsSpecialites: Record<string, string> = {};
  for (const p of promos) {
    if (!p.productId) continue;
    const ids = p.specialitesCibles.map((s) => s.specialtyId);
    if (ids.length) specialitesParProduit[p.productId] = [...new Set([...(specialitesParProduit[p.productId] ?? []), ...ids])];
    for (const s of p.specialitesCibles) nomsSpecialites[s.specialtyId] = s.specialty.name;
  }
  const docs = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
  for (const d of docs) nomsSpecialites[d.id] ??= d.name;
  const affinite = await affinitesEtablissements(productIds);
  return { specialitesParProduit, nomsSpecialites, ...affinite };
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));
const estStatut = (s: string | null): s is Statut => !!s && (STATUTS as readonly string[]).includes(s);

export interface LignePanel {
  ficheId: string;
  doctorId: string;
  nom: string;
  /** Nom et prénom séparés (annuaire) — le nom d'affichage quand ils manquent. */
  nomFamille: string;
  prenom: string | null;
  grade: string;
  /** Le grade tel que le fichier l'écrivait quand la liste ne le connaît pas (« KOL »), sinon null. */
  gradeBrut: string | null;
  /** L'établissement RATTACHÉ (annuaire des établissements) ; null = aucun, ou un texte « à rattacher ». */
  institutionId: string | null;
  /** Sa wilaya (la sienne, sinon celle de son établissement) — null = inconnue. */
  wilaya: string | null;
  /** Son secteur dans la BU ; `secteurPose` = rangé à la main (sinon déduit de l'établissement). */
  secteurId: string | null;
  secteurNom: string | null;
  secteurPose: boolean;
  /** Les deux réponses en vigueur pour le produit #1 (les plus récentes), null = non renseignée. */
  q1: number | null;
  q2: number | null;
  etablissement: string | null;
  specialite: string | null;
  specialiteId: string | null;
  /** IN = dans la wilaya pivot d'un KAM qui le couvre ; OUT = ailleurs ; null = inconnu. */
  inOut: InOut | null;
  statut: Statut | null;
  zone: string | null;
  derniereObservation: Date | null;
  resultat: ResultatPraticien | null;
}

/**
 * Les FAITS de la stratégie, praticien par praticien, dans la portée donnée (`portee` : la clause
 * de l'annuaire qui borne ce que la personne voit — le KAM, son panel).
 */
export async function chargerFaits(strategieId: string, portee: Prisma.MedicalDoctorWhereInput = {}): Promise<{ faits: FaitsPraticien[]; lignes: Omit<LignePanel, "resultat">[] }> {
  const strat = await prisma.segmentationStrategie.findUnique({
    where: { id: strategieId },
    select: { businessUnitId: true, produits: { where: { jusqua: null }, orderBy: { rang: "asc" }, take: 1, select: { productId: true } } },
  });
  const p1 = strat?.produits[0]?.productId ?? null;
  const secteurs = strat ? await chargerSecteurs(strat.businessUnitId) : [];
  const fiches = await prisma.segmentationFiche.findMany({
    where: { strategieId, retireeLe: null, doctor: { archivedAt: null, ...portee } },
    select: {
      id: true, statut: true, zone: true, secteurId: true,
      doctor: {
        select: {
          id: true, name: true, lastName: true, firstName: true, title: true, specialtyId: true, institutionId: true, serviceId: true, delegateId: true, wilaya: true,
          institutionRef: { select: { name: true, wilaya: true } }, institution: true, comments: true,
          specialtyRef: { select: { name: true } }, specialty: true,
          segmentationObservations: {
            where: { OR: [{ strategieId }, { strategieId: null }] },
            select: { productId: true, potentiel: true, prescriptionsSur10: true, observeLe: true, source: true },
            orderBy: { observeLe: "desc" }, take: 20,
          },
          segmentationDerogations: {
            where: { strategieId, leveeLe: null },
            select: { nature: true, productId: true, valeur: true, motif: true, expireLe: true },
          },
        },
      },
    },
    orderBy: { doctor: { name: "asc" } },
  });
  // LE SECTEUR : posé à la main sur la fiche, sinon celui qui couvre son établissement / son service (ou son KAM).
  const secteurDe = new Map<string, SecteurBu | null>();
  for (const f of fiches) {
    const pose = f.secteurId ? secteurs.find((s) => s.id === f.secteurId) ?? null : null;
    secteurDe.set(f.doctor.id, pose ?? secteurDuPraticien(f.doctor, secteurs));
  }
  // IN / OUT : la wilaya du praticien (sinon celle de son établissement) face à la wilaya de la ville pivot de SON
  // secteur ; sans ville pivot de secteur, l'ancienne lecture par les KAM qui le couvrent.
  const wilayaDe = (d: (typeof fiches)[number]["doctor"]) => wilayaDuPraticien({ wilaya: d.wilaya, wilayaEtablissement: d.institutionRef?.wilaya, etablissement: d.institutionRef?.name ?? d.institution });
  const sansPivot = fiches.filter((f) => !secteurDe.get(f.doctor.id)?.pivot);
  const parKam = await inOutDesPraticiens(strategieId, sansPivot.map((f) => ({ id: f.doctor.id, wilaya: wilayaDe(f.doctor) })));
  const inOutDuPraticien = (d: (typeof fiches)[number]["doctor"]): InOut | null => {
    const pivot = secteurDe.get(d.id)?.pivot ?? null;
    return pivot ? inOutDe(wilayaDe(d), [pivot]) : parKam.get(d.id) ?? null;
  };
  const faits: FaitsPraticien[] = [];
  const lignes: Omit<LignePanel, "resultat">[] = [];
  for (const f of fiches) {
    const d = f.doctor;
    const secteur = secteurDe.get(d.id) ?? null;
    const io = inOutDuPraticien(d);
    const observations = d.segmentationObservations.map((o) => ({ productId: o.productId, potentiel: num(o.potentiel), prescriptionsSur10: num(o.prescriptionsSur10), observeLe: o.observeLe, efface: effaceDeSource(o.source) }));
    faits.push({
      doctorId: d.id, statut: estStatut(f.statut) ? f.statut : null, zone: f.zone,
      specialiteId: d.specialtyId, institutionId: d.institutionId, inOut: io,
      secteurId: secteur?.id ?? null, secteurNom: secteur?.nom ?? null,
      observations,
      derogations: d.segmentationDerogations.filter((x) => x.nature === "CIBLAGE" || x.nature === "SEGMENT").map((x) => ({ nature: x.nature as "CIBLAGE" | "SEGMENT", productId: x.productId, valeur: x.valeur, motif: x.motif, expireLe: x.expireLe })),
    });
    lignes.push({
      ficheId: f.id, doctorId: d.id, nom: d.name,
      nomFamille: d.lastName?.trim() || d.name,
      prenom: d.lastName?.trim() ? d.firstName?.trim() || null : null,
      grade: d.title,
      gradeBrut: d.title === "AUTRE" ? gradeBrutDe(d.comments) : null,
      institutionId: d.institutionRef ? d.institutionId : null,
      wilaya: wilayaDe(d),
      etablissement: d.institutionRef?.name ?? d.institution ?? null,
      specialite: d.specialtyRef?.name ?? d.specialty ?? null,
      specialiteId: d.specialtyId,
      statut: estStatut(f.statut) ? f.statut : null, zone: f.zone, inOut: io,
      secteurId: secteur?.id ?? null, secteurNom: secteur?.nom ?? null, secteurPose: !!f.secteurId && !!secteur,
      q1: p1 ? derniere(observations, "potentiel", p1)?.valeur ?? null : null,
      q2: p1 ? derniere(observations, "prescriptionsSur10", p1)?.valeur ?? null : null,
      derniereObservation: d.segmentationObservations[0]?.observeLe ?? null,
    });
  }
  return { faits, lignes };
}

/** Les secteurs d'une BU — actifs d'abord, par nom ; un secteur inactif ne sert qu'aux fiches qui y sont rangées. */
export async function chargerSecteurs(businessUnitId: string): Promise<SecteurBu[]> {
  const s = await prisma.salesSector.findMany({
    where: { businessUnitId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true, name: true, city: true, wilayaPivot: true, isActive: true,
      rep: { select: { id: true, name: true } },
      reps: { select: { rep: { select: { id: true, name: true } } } },
      institutions: { select: { institutionId: true, tousLesServices: true, services: { select: { serviceId: true } } } },
    },
  });
  return s.map((x) => {
    const kams = new Map<string, string>();
    if (x.rep) kams.set(x.rep.id, x.rep.name);
    for (const r of x.reps) kams.set(r.rep.id, r.rep.name);
    return {
      id: x.id, nom: x.name, actif: x.isActive, ville: x.city, pivot: pivotDuSecteur(x),
      kams: [...kams].map(([id, nom]) => ({ id, nom })),
      etablissements: x.institutions.map((i) => ({ institutionId: i.institutionId, tous: i.tousLesServices, services: i.services.map((v) => v.serviceId) })),
    };
  });
}

/**
 * IN / OUT de chaque praticien : la wilaya PIVOT de chaque KAM de la BU (ville pivot de son territoire propre), et les
 * praticiens que chacun couvre (secteur ∪ rattachement — `clausePanelDuKam`, la règle unique du panel).
 */
async function inOutDesPraticiens(strategieId: string, praticiens: { id: string; wilaya: string | null }[]): Promise<Map<string, InOut | null>> {
  const out = new Map<string, InOut | null>();
  if (praticiens.length === 0) return out;
  const s = await prisma.segmentationStrategie.findUnique({ where: { id: strategieId }, select: { businessUnitId: true } });
  if (!s) return out;
  const reps = await prisma.salesRepProfile.findMany({ where: { businessUnitId: s.businessUnitId, isActive: true }, select: { repId: true } });
  const secteurs = await prisma.salesSector.findMany({ where: { businessUnitId: s.businessUnitId, isActive: true, repId: { in: reps.map((r) => r.repId) } }, select: { repId: true, city: true, wilayaPivot: true } });
  const pivots = new Map<string, string | null>();
  for (const x of secteurs) if (x.repId) pivots.set(x.repId, pivotDuSecteur(x));
  const ids = praticiens.map((p) => p.id);
  const pivotsParPraticien = new Map<string, (string | null)[]>();
  for (const r of reps) {
    const pivot = pivots.get(r.repId) ?? null;
    const couverts = await prisma.medicalDoctor.findMany({ where: { AND: [clausePanelDuKam(r.repId), { id: { in: ids } }] }, select: { id: true } });
    for (const c of couverts) pivotsParPraticien.set(c.id, [...(pivotsParPraticien.get(c.id) ?? []), pivot]);
  }
  for (const p of praticiens) out.set(p.id, inOutDe(p.wilaya, pivotsParPraticien.get(p.id) ?? []));
  return out;
}

/** Le panel calculé : chaque ligne avec son résultat (null si la stratégie n'a pas encore de règles valides). */
export async function chargerPanel(strategie: StrategieChargee, portee: Prisma.MedicalDoctorWhereInput = {}): Promise<LignePanel[]> {
  const { faits, lignes } = await chargerFaits(strategie.id, portee);
  const regles = strategie.regle?.regles ?? null;
  const maintenant = new Date();
  return lignes.map((l, i) => ({ ...l, resultat: regles ? segmenterPraticien(faits[i], regles, maintenant, strategie.contexte) : null }));
}

// ─────────────────────────────── IMPORT D'UN CLASSEUR ───────────────────────────────

/** Les feuilles d'un classeur — plage recalculée sur les cellules remplies (`feuilles.ts`). */
export { lireFeuilles };

export interface ApercuImport {
  ok: true;
  empreinte: string;
  dejaImporte: boolean;
  feuille: string;
  colonnes: { texte: string; champ: string | null }[];
  lignes: number;
  existants: number;
  nouveaux: number;
  ambigus: { ligne: number; nom: string; candidats: number }[];
  doublons: { ligne: number; nom: string; ligneOrigine: number }[];
  conflits: string[];
  etablissementsACreer: string[];
  etablissementsAmbigus: string[];
  specialitesACreer: string[];
  observations: number;
  nonCiblesDuFichier: number;
  produitMentionne: string | null;
  produitConcorde: boolean;
  /** La proposition de règles (si la stratégie n'a pas encore de version publiée). */
  regles: PropositionRegles | null;
  anomalies: string[];
  /** « Région » du fichier : celles qui portent le nom d'un secteur de la BU y rangent la fiche ; les autres restent une zone libre. */
  regionsSecteurs: string[];
  regionsSansSecteur: string[];
}

interface Prepare {
  apercu: ApercuImport;
  lecture: LectureClasseur;
  rappro: Map<number, Rapprochement>;
  etabDe: (nom: string | null) => { id: string | null; creer: string | null };
  specDe: (nom: string | null) => { id: string | null; creer: string | null };
  secteurDeRegion: (region: string | null) => string | null;
  connus: Map<string, { institutionId: string | null; specialtyId: string | null; title: string; lastName: string | null; firstName: string | null; region: string | null }>;
}

async function preparer(strategie: StrategieChargee, buffer: Buffer): Promise<Prepare | { ok: false; error: string }> {
  const feuilles = lireFeuilles(buffer);
  const lecture = lireClasseur(feuilles);
  if (!lecture) return { ok: false, error: "Aucune feuille de ce classeur n'a la forme d'une segmentation (colonnes Nom, Prénom, Établissement, Statut…)." };
  if (lecture.lignes.length === 0) return { ok: false, error: `La feuille « ${lecture_nom(lecture)} » n'a aucune ligne de praticien.` };
  const empreinte = createHash("sha256").update(buffer).digest("hex");
  const deja = await prisma.segmentationImport.findUnique({ where: { strategieId_empreinte: { strategieId: strategie.id, empreinte } }, select: { id: true } });

  const etabs = await prisma.medicalInstitution.findMany({ select: { id: true, name: true, isActive: true, wilaya: true } });
  const trouverEtab = indexerEtablissements(etabs);
  const etablissementsACreer = new Set<string>();
  const etablissementsAmbigus = new Set<string>();
  const etabDe = (nom: string | null) => {
    if (!nom) return { id: null, creer: null };
    const r = trouverEtab(nom);
    if (r.statut === "trouve") return { id: r.etablissement.id, creer: null };
    if (r.statut === "inconnu") { etablissementsACreer.add(nom); return { id: null, creer: nom }; }
    etablissementsAmbigus.add(nom);
    return { id: null, creer: null };
  };
  const specs = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
  const trouverSpec = indexerSpecialites(specs);
  const specialitesACreer = new Map<string, string>();
  const specDe = (nom: string | null) => {
    if (!nom) return { id: null, creer: null };
    const r = trouverSpec(nom);
    if (r.statut === "trouve") return { id: r.specialite.id, creer: null };
    const cle = cleDEtablissement(nom);
    if (!specialitesACreer.has(cle)) specialitesACreer.set(cle, nom);
    return { id: null, creer: specialitesACreer.get(cle)! };
  };

  const docs = await prisma.medicalDoctor.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, lastName: true, firstName: true, institutionId: true, specialtyId: true, title: true, region: true },
  });
  const connus = new Map(docs.map((d) => [d.id, { institutionId: d.institutionId, specialtyId: d.specialtyId, title: d.title, lastName: d.lastName, firstName: d.firstName, region: d.region }]));
  for (const l of lecture.lignes) { etabDe(l.etablissement); specDe(l.specialite); }
  const rappro = rapprocher(lecture.lignes, docs, (nom) => etabDe(nom).id);

  const conflits: string[] = [];
  let existants = 0, nouveaux = 0, observations = 0, nonCibles = 0;
  const ambigus: ApercuImport["ambigus"] = [];
  const doublons: ApercuImport["doublons"] = [];
  for (const l of lecture.lignes) {
    const r = rappro.get(l.ligne)!;
    const nom = [l.nom, l.prenom].filter(Boolean).join(" ");
    if (r.statut === "ambigu") { ambigus.push({ ligne: l.ligne, nom, candidats: r.candidats.length }); continue; }
    if (r.statut === "doublon") { doublons.push({ ligne: l.ligne, nom, ligneOrigine: r.ligneOrigine }); continue; }
    if (r.statut === "existant") {
      existants++;
      const c = connus.get(r.doctorId)!;
      const e = etabDe(l.etablissement).id;
      if (e && c.institutionId && c.institutionId !== e) conflits.push(`Ligne ${l.ligne} (${nom}) : l'annuaire le rattache à un autre établissement que « ${l.etablissement} » — l'annuaire est gardé.`);
      const s = specDe(l.specialite).id;
      if (s && c.specialtyId && c.specialtyId !== s) conflits.push(`Ligne ${l.ligne} (${nom}) : spécialité différente de « ${l.specialite} » dans l'annuaire — l'annuaire est gardé.`);
    } else nouveaux++;
    if (l.potentiel !== null || l.sur10 !== null) observations++;
    if (l.segmentFichier === "NA") nonCibles++;
  }
  // Même nom dans deux établissements du fichier : deux fiches, mais à vérifier.
  const parNom = new Map<string, string[]>();
  for (const l of lecture.lignes) { const k = [l.nom, l.prenom].filter(Boolean).join(" ").toLowerCase(); parNom.set(k, [...(parNom.get(k) ?? []), `${l.etablissement ?? "?"} (ligne ${l.ligne})`]); }
  for (const [k, v] of parNom) if (v.length > 1 && new Set(v.map((x) => x.replace(/ \(ligne \d+\)$/, ""))).size > 1) conflits.push(`« ${k} » apparaît dans plusieurs établissements : ${v.join(", ")} — vérifiez qu'il s'agit bien de personnes distinctes.`);

  const p1 = strategie.produits[0];
  const mention = lecture.produitMentionne;
  const produitConcorde = !mention || !p1 || cleDEtablissement(p1.dci).includes(mention.split(" ")[0]) || cleDEtablissement(p1.nom).includes(mention.split(" ")[0]);
  const regles = !strategie.regle && p1 ? proposerRegles(lecture, feuilles, p1.productId) : null;

  // « RÉGION » → SECTEUR DE LA BU quand le nom concorde (casse et accents ignorés) ; sinon zone libre, signalée.
  const secteurs = (await chargerSecteurs(strategie.businessUnit.id)).filter((s) => s.actif);
  const parNomSecteur = new Map(secteurs.map((s) => [cleDEtablissement(s.nom), s.id]));
  const secteurDeRegion = (region: string | null) => (region ? parNomSecteur.get(cleDEtablissement(region)) ?? null : null);
  const regions = [...new Set(lecture.lignes.map((l) => l.zone).filter((z): z is string => !!z))];

  return {
    lecture, rappro, etabDe, specDe, connus, secteurDeRegion,
    apercu: {
      ok: true, empreinte, dejaImporte: !!deja, feuille: lecture.feuille,
      colonnes: lecture.entete.filter((c) => c.texte).map((c) => ({ texte: c.texte, champ: c.champ })),
      lignes: lecture.lignes.length, existants, nouveaux, ambigus, doublons, conflits,
      etablissementsACreer: [...etablissementsACreer], etablissementsAmbigus: [...etablissementsAmbigus],
      specialitesACreer: [...specialitesACreer.values()], observations, nonCiblesDuFichier: nonCibles,
      produitMentionne: mention, produitConcorde, regles, anomalies: lecture.anomalies,
      regionsSecteurs: regions.filter((r) => secteurDeRegion(r)), regionsSansSecteur: regions.filter((r) => !secteurDeRegion(r)),
    },
  };
}

const lecture_nom = (l: LectureClasseur) => l.feuille;

export async function apercuImport(strategieId: string, buffer: Buffer): Promise<ApercuImport | { ok: false; error: string }> {
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  if (s.produits.length === 0) return { ok: false, error: "Classez d'abord au moins un produit dans la stratégie." };
  const p = await preparer(s, buffer);
  return "apercu" in p ? p.apercu : p;
}

export interface BilanImport { ok: true; importId: string; crees: number; misAJour: number; observations: number; etablissementsCrees: number; specialitesCreees: number; reglePubliee: number | null }

/**
 * APPLIQUE l'import, en UNE transaction : référentiels manquants, praticiens (création, ou complément des
 * champs VIDES d'une fiche existante — jamais d'écrasement), fiches de la stratégie, observations
 * historisées, décisions « non ciblé » du fichier, et — si la stratégie n'a pas encore de règles — la
 * version 1 telle que la personne l'a relue.
 */
export async function appliquerImport(
  auteurId: string, strategieId: string, buffer: Buffer, nomFichier: string,
  opts: { reglesContenu?: unknown },
): Promise<BilanImport | { ok: false; error: string }> {
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const p1 = s.produits[0];
  if (!p1) return { ok: false, error: "Classez d'abord au moins un produit dans la stratégie." };
  const prep = await preparer(s, buffer);
  if (!("apercu" in prep)) return prep;
  const { apercu, lecture, rappro, connus } = prep;
  if (apercu.dejaImporte) return { ok: false, error: "Ce fichier a déjà été importé dans cette stratégie — rien n'a été ajouté une seconde fois." };
  let reglesV1: Regles | null = null;
  if (!s.regle) {
    const lu = lireRegles(opts.reglesContenu ?? apercu.regles?.contenu);
    if (!lu.ok) return { ok: false, error: `Règles à compléter avant l'import : ${lu.erreurs.join(" ")}` };
    reglesV1 = lu.regles;
  }

  return prisma.$transaction(async (tx) => {
    const imp = await tx.segmentationImport.create({
      data: { strategieId, nomFichier, empreinte: apercu.empreinte, taille: buffer.length, feuille: apercu.feuille, rapport: apercu as unknown as Prisma.InputJsonValue, auteurId },
      select: { id: true },
    });
    // Référentiels manquants.
    const etabCree = new Map<string, string>();
    for (const nom of apercu.etablissementsACreer) {
      const zone = lecture.lignes.find((l) => l.etablissement === nom)?.zone ?? null;
      const e = await tx.medicalInstitution.create({ data: { name: nom, type: typeDEtablissement(nom), region: zone, createdById: auteurId, notes: `Créé par l'import de segmentation « ${nomFichier} ».` }, select: { id: true } });
      etabCree.set(cleDEtablissement(nom), e.id);
    }
    const specCree = new Map<string, string>();
    for (const nom of apercu.specialitesACreer) {
      const e = await tx.medicalSpecialty.upsert({ where: { name: nom }, update: {}, create: { name: nom, createdById: auteurId }, select: { id: true } });
      specCree.set(cleDEtablissement(nom), e.id);
    }
    const etabId = (nom: string | null) => (nom ? prep.etabDe(nom).id ?? etabCree.get(cleDEtablissement(nom)) ?? null : null);
    const specId = (nom: string | null) => (nom ? prep.specDe(nom).id ?? specCree.get(cleDEtablissement(nom)) ?? null : null);

    let crees = 0, misAJour = 0, observations = 0;
    for (const l of lecture.lignes) {
      const r = rappro.get(l.ligne)!;
      if (r.statut === "ambigu" || r.statut === "doublon") continue;
      const institutionId = etabId(l.etablissement);
      const specialtyId = specId(l.specialite);
      const title = titleFrom(l.grade);
      let doctorId: string;
      if (r.statut === "existant") {
        doctorId = r.doctorId;
        const c = connus.get(doctorId)!;
        const data: Prisma.MedicalDoctorUncheckedUpdateInput = {};
        if (!c.institutionId && institutionId) { data.institutionId = institutionId; data.institution = l.etablissement; }
        if (!c.specialtyId && specialtyId) { data.specialtyId = specialtyId; data.specialty = l.specialite; }
        if (c.title === "AUTRE" && title !== "AUTRE") data.title = title as DoctorTitle;
        if (!c.lastName && !c.firstName) { data.lastName = l.nom; data.firstName = l.prenom; }
        if (!c.region && l.zone) data.region = l.zone;
        if (Object.keys(data).length) { await tx.medicalDoctor.update({ where: { id: doctorId }, data: { ...data, updatedById: auteurId } }); misAJour++; }
      } else {
        const d = await tx.medicalDoctor.create({
          data: {
            name: composeDoctorName(l.prenom, l.nom), lastName: l.nom, firstName: l.prenom,
            title: title as DoctorTitle, sector: "HOSPITAL",
            institutionId, institution: l.etablissement, specialtyId, specialty: l.specialite,
            region: l.zone, companyId: ADVENTUM_COMPANY_ID, createdById: auteurId,
          },
          select: { id: true },
        });
        doctorId = d.id;
        crees++;
      }
      // La « Région » qui nomme un secteur de la BU y range la fiche ; une région inconnue garde le secteur déjà posé.
      const secteurId = prep.secteurDeRegion(l.zone);
      await tx.segmentationFiche.upsert({
        where: { strategieId_doctorId: { strategieId, doctorId } },
        update: { statut: l.statut, zone: l.zone, ...(secteurId ? { secteurId } : {}), source: "IMPORT", importId: imp.id, ligneSource: l.ligne, retireeLe: null, updatedById: auteurId },
        create: { strategieId, doctorId, statut: l.statut, zone: l.zone, secteurId, source: "IMPORT", importId: imp.id, ligneSource: l.ligne, createdById: auteurId },
      });
      if (l.potentiel !== null || l.sur10 !== null) {
        await tx.hcpObservation.create({
          data: {
            doctorId, strategieId, productId: p1.productId, potentiel: l.potentiel, prescriptionsSur10: l.sur10,
            metrique: lecture.metrique, source: "IMPORT", importId: imp.id, ligneSource: l.ligne, auteurId,
            commentaire: `Import « ${nomFichier} », ligne ${l.ligne}.`,
          },
        });
        observations++;
      }
      // « NA » du fichier n'est plus une décision de ciblage (Direction, 07/10) : NA veut dire « une réponse manque »,
      // et la lettre se RECALCULE depuis Q1 et Q2 (0 patient = non ciblé). Rien n'est forcé par l'import.
    }
    let reglePubliee: number | null = null;
    if (reglesV1) {
      await tx.segmentationRegle.create({ data: { strategieId, version: 1, contenu: reglesV1 as unknown as Prisma.InputJsonValue, note: `Version proposée par l'import « ${nomFichier} » et relue avant publication.`, publieeParId: auteurId } });
      reglePubliee = 1;
    }
    return { ok: true as const, importId: imp.id, crees, misAJour, observations, etablissementsCrees: etabCree.size, specialitesCreees: specCree.size, reglePubliee };
  }, { timeout: 120_000, maxWait: 20_000 });
}

/**
 * L'IMPACT D'UN IMPORT DE CONSOMMATION SUR LA SEGMENTATION, avant de le valider (§25 « segmentation impact
 * preview ») : pour chaque stratégie dont un produit tire son affinité de l'établissement, combien de segments
 * changeraient si les lignes de cet import comptaient. Rien n'est écrit.
 */
export async function impactConsommation(importId: string): Promise<{ strategie: string; praticiens: number; changements: number }[]> {
  const strategies = await prisma.segmentationStrategie.findMany({ where: { statut: "ACTIVE" }, select: { id: true } });
  const out: { strategie: string; praticiens: number; changements: number }[] = [];
  for (const { id } of strategies) {
    const s = await chargerStrategie(id);
    const regles = s?.regle?.regles;
    if (!s || !regles || !regles.produits.some((p) => (p.sourceAffinite ?? "DECLAREE") !== "DECLAREE")) continue;
    const apres: ContexteSegmentation = { ...s.contexte, ...(await affinitesEtablissements(s.produits.map((p) => p.productId), importId)) };
    const { faits } = await chargerFaits(s.id);
    const maintenant = new Date();
    let praticiens = 0, changements = 0;
    for (const f of faits) {
      const a = segmenterPraticien(f, regles, maintenant, s.contexte), b = segmenterPraticien(f, regles, maintenant, apres);
      const n = a.produits.filter((p, i) => p.etat !== b.produits[i]?.etat).length;
      if (n) { praticiens++; changements += n; }
    }
    out.push({ strategie: s.nom, praticiens, changements });
  }
  return out;
}