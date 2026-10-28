import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { RaisonneurInstrumente } from "@/platform/in-process/missions/provider-waterfall";
import {
  jouer, jetonUnique, preconditionAbsence,
  type ResultatMission, type Scenario, arreterMissionsDeDiagnostic } from "@/platform/in-process/missions/provider-smoke";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DEEP LIVE SMOKE — 60 à 80 missions VARIÉES, construites sur les VRAIES données de l'ERP.
 *
 *   npm run adam:smoke:deep        (Shell Render — OPENAI_API_KEY doit être présente)
 *
 * ── POURQUOI IL EXISTE ───────────────────────────────────────────────────────────────────
 *
 * Le trio du smoke fournisseur (SATISFIABLE / PREUVE_ABSENCE / RECOURS) prouve la CHAÎNE. Il
 * ne dit pas si Adam TIENT sur la variété réelle du métier : dossiers réglementaires, RH,
 * finances, courriers, legal, marchés PCH, Drive, comparaisons, agrégations, éventails. C'est
 * cette question-là que ce banc pose — et il la pose sur ce que la base CONTIENT, jamais sur
 * des données inventées.
 *
 * ── LES RÈGLES QU'IL S'IMPOSE ────────────────────────────────────────────────────────────
 *
 *   1. AUCUNE DONNÉE SIMULÉE. L'inventaire lit la base ; chaque énoncé cite un enregistrement
 *      RÉEL (titre de dossier, DCI, nom d'employé, nom de fichier…). Un genre sans donnée est
 *      ÉCARTÉ et le rapport le DIT — jamais rempli avec du faux (§78).
 *   2. MÊME HARNAIS QUE LE SMOKE FOURNISSEUR. Chaque mission passe par `jouer` : même plafond
 *      ANALYZE, même garde d'artefacts, même conduite jusqu'à l'état stable, même cascade.
 *      Un second harnais serait un second témoin — qui divergerait un jour du premier.
 *   3. UN INSTRUMENT PAR MISSION. Le marquage par tranche de `RaisonneurInstrumente` suppose
 *      un scénario COURANT ; avec des missions concurrentes, les appels se mélangeraient.
 *      Chaque mission décore donc le vrai raisonneur avec SON instrument, et l'agrégat se
 *      fait par addition — jamais par lecture d'un état partagé.
 *   4. TROIS VERDICTS, PAS DEUX. SUCCÈS (la mission conclut, objectif jugé atteint) ;
 *      CONCLUSION HONNÊTE (elle s'arrête proprement en DISANT pourquoi — un refus motivé
 *      n'est pas une panne, §10) ; DÉFAUT (instable, point fixe, artefact sous plafond de
 *      lecture, effet dépassé, ou COMPLETED sans objectif atteint — une incohérence). Le code
 *      de sortie ne sanctionne que les DÉFAUTS.
 *   5. LE NETTOYAGE NE TOUCHE QUE SES PROPRES MISSIONS — les identifiants créés par CE run,
 *      et rien d'autre. `DEEP_SMOKE_GARDER=1` les conserve pour inspection.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/* ────────────────────────────── L'INVENTAIRE DU RÉEL ────────────────────────────── */

export interface Echantillons {
  dossiers: { reference: string; title: string }[];
  produits: { dci: string; brandName: string | null }[];
  employes: { fullName: string }[];
  fichiers: { name: string }[];
  courriers: { title: string }[];
  partenaires: { name: string }[];
  legals: { title: string }[];
  factures: { title: string }[];
  paiements: { title: string }[];
  taches: { title: string }[];
  marches: { reference: string; title: string | null }[];
  departements: { name: string }[];
  /** Comptes MESURÉS avant tout lancement. -1 = non mesuré, jamais zéro par défaut (§78). */
  comptes: { dossiers: number; produits: number; employesActifs: number; auditsSeptJours: number };
}

/** Lit la base RÉELLE. Chaque source est défensive : une table illisible rend vide/-1, pas une panne. */
export async function inventorier(): Promise<Echantillons> {
  const semaine = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [dossiers, produits, employes, fichiers, courriers, partenaires, legals, factures, paiements, taches, marches, departements] =
    await Promise.all([
      prisma.regulatoryDossier.findMany({ select: { reference: true, title: true }, take: 6 }).catch(sansBloquer("deep-smoke.inventorier.regulatoryDossier", [])),
      prisma.regulatoryProduct.findMany({ select: { dci: true, brandName: true }, take: 8 }).catch(sansBloquer("deep-smoke.inventorier.regulatoryProduct", [])),
      prisma.employee.findMany({ where: { isActive: true }, select: { fullName: true }, take: 6 }).catch(sansBloquer("deep-smoke.inventorier.employee", [])),
      prisma.driveNode.findMany({ where: { isTrashed: false, NOT: { mimeType: null } }, select: { name: true }, take: 6 }).catch(sansBloquer("deep-smoke.inventorier.driveNode", [])),
      prisma.mailEntry.findMany({ select: { title: true }, take: 4 }).catch(sansBloquer("deep-smoke.inventorier.mailEntry", [])),
      prisma.mailPartner.findMany({ where: { isActive: true }, select: { name: true }, take: 3 }).catch(sansBloquer("deep-smoke.inventorier.mailPartner", [])),
      prisma.legalDocument.findMany({ select: { title: true }, take: 4 }).catch(sansBloquer("deep-smoke.inventorier.legalDocument", [])),
      prisma.legalDocument.findMany({ where: { kind: "INVOICE" }, select: { title: true }, take: 3 }).catch(sansBloquer("deep-smoke.inventorier.legalDocument", [])),
      prisma.paymentRequest.findMany({ select: { title: true }, take: 3 }).catch(sansBloquer("deep-smoke.inventorier.paymentRequest", [])),
      prisma.task.findMany({ select: { title: true }, take: 4 }).catch(sansBloquer("deep-smoke.inventorier.task", [])),
      prisma.pchTender.findMany({ select: { reference: true, title: true }, take: 3 }).catch(sansBloquer("deep-smoke.inventorier.pchTender", [])),
      prisma.department.findMany({ select: { name: true }, take: 5 }).catch(sansBloquer("deep-smoke.inventorier.department", [])),
    ]);
  const [cDossiers, cProduits, cEmployes, cAudits] = await Promise.all([
    prisma.regulatoryDossier.count().catch(sansBloquer("deep-smoke.inventorier.regulatoryDossier", -1)),
    prisma.regulatoryProduct.count().catch(sansBloquer("deep-smoke.inventorier.regulatoryProduct", -1)),
    prisma.employee.count({ where: { isActive: true } }).catch(sansBloquer("deep-smoke.inventorier.employee", -1)),
    prisma.auditLog.count({ where: { createdAt: { gte: semaine } } }).catch(sansBloquer("deep-smoke.inventorier.auditLog", -1)),
  ]);
  return {
    dossiers, produits, employes, fichiers, courriers, partenaires, legals, factures,
    paiements, taches, marches, departements,
    comptes: { dossiers: cDossiers, produits: cProduits, employesActifs: cEmployes, auditsSeptJours: cAudits },
  };
}

/* ────────────────────────────── LA GÉNÉRATION DES MISSIONS ────────────────────────────── */

export interface ScenarioProfond extends Scenario {
  /**
   * CONCLUT = la conclusion est structurellement possible quoi que contienne la base (une
   * preuve d'absence ou de présence se conclut dans les deux cas) — un non-COMPLETED y pèse
   * plus lourd au rapport. OBSERVE = l'issue dépend des données et du juge ; on observe.
   */
  attendu: "CONCLUT" | "OBSERVE";
}

export interface GenreEcarte { genre: string; raison: string }

/**
 * CONSTRUIT les missions à partir de l'inventaire — fonction PURE (les `verifier` sont des
 * fermetures jouées plus tard) : la variété se teste sans base et sans modèle.
 *
 * L'assemblage est un TOUR DE RÔLE entre genres : si la cible impose de couper, on coupe
 * partout un peu — jamais un genre entier.
 */
export function genererScenarios(
  inv: Echantillons,
  jeton: string = jetonUnique(),
  cible = 70,
): { scenarios: ScenarioProfond[]; ecartes: GenreEcarte[] } {
  const genres: ScenarioProfond[][] = [];
  const ecartes: GenreEcarte[] = [];
  const genre = (nom: string, liste: ScenarioProfond[], raisonSiVide: string) => {
    if (liste.length > 0) genres.push(liste);
    else ecartes.push({ genre: nom, raison: raisonSiVide });
  };
  const sc = (genre: string, titre: string, demande: string, verite: string, attendu: "CONCLUT" | "OBSERVE", verifier?: Scenario["verifier"]): ScenarioProfond =>
    ({ genre, titre, demande, verite, attendu, ...(verifier ? { verifier } : {}) });

  // 1 — PREUVE D'ABSENCE (×3) : le jeton garantit l'absence ; la précondition la COMPTE avant.
  genre("PREUVE_ABSENCE", ["A", "B", "C"].map((s) => {
    const t = `Zorbamyxine-K7-${jeton}${s}`;
    return sc("PREUVE_ABSENCE", `absence ${s}`,
      `Vérifie si nous avons quoi que ce soit sur la molécule « ${t} » : produit, dossier réglementaire, marché, document. L'objectif est de DÉMONTRER l'absence : conclus en citant chaque source vérifiée.`,
      `« ${t} » absent des quatre sources citées (comptées avant lancement).`,
      "CONCLUT", () => preconditionAbsence(t));
  }), "jamais vide — le jeton est fabriqué");

  // 2 — RECHERCHE MULTI-SOURCES sur un produit RÉEL : candidat naturel du chemin direct.
  genre("RECHERCHE_PRODUIT", inv.produits.slice(0, 8).map((p, i) => sc(
    "RECHERCHE_PRODUIT", `recherche ${p.dci}`,
    `Vérifie si nous avons quoi que ce soit sur « ${p.dci} » : produit, dossier réglementaire, marché, document. Conclus en citant chaque source vérifiée.`,
    `« ${p.dci} » existe au moins dans RegulatoryProduct (échantillon n° ${i + 1} de l'inventaire).`,
    "CONCLUT")), "aucun produit Regulatory en base");

  // 3 — POINT SUR UN DOSSIER RÉEL.
  genre("POINT_DOSSIER", inv.dossiers.slice(0, 6).map((d) => sc(
    "POINT_DOSSIER", `point ${d.reference}`,
    `Fais le point sur le dossier réglementaire « ${d.title} » (référence ${d.reference}) : où en est-il, quelles étapes restent, et que faut-il faire ensuite ?`,
    `le dossier ${d.reference} existe en base.`, "OBSERVE")), "aucun dossier réglementaire en base");

  // 4 — HISTORIQUE D'UN DOSSIER (qui a fait quoi, quand).
  genre("HISTORIQUE_DOSSIER", inv.dossiers.slice(0, 3).map((d) => sc(
    "HISTORIQUE_DOSSIER", `historique ${d.reference}`,
    `Raconte l'historique du dossier « ${d.title} » (${d.reference}) : qui a fait quoi et quand, depuis sa création.`,
    `le dossier ${d.reference} existe en base.`, "OBSERVE")), "aucun dossier réglementaire en base");

  // 5 — SYNTHÈSE GLOBALE REGULATORY (le SATISFIABLE historique, conservé).
  genre("SYNTHESE_REGULATORY", inv.comptes.dossiers > 0 ? [sc(
    "SYNTHESE_REGULATORY", "synthèse dossiers",
    "Fais le point sur les dossiers réglementaires en cours : liste-les avec leur statut, et dis-moi lequel demande le plus d'attention et pourquoi.",
    `RegulatoryDossier compte ${inv.comptes.dossiers} ligne(s) (mesuré avant lancement).`, "OBSERVE")] : [],
    "aucun dossier réglementaire en base");

  // 6 — POINT SUR UNE PERSONNE RÉELLE.
  genre("POINT_EMPLOYE", inv.employes.slice(0, 6).map((e) => sc(
    "POINT_EMPLOYE", `point ${e.fullName}`,
    `Fais le point sur la situation de ${e.fullName} : tâches en cours, congés posés, et ce qui l'attend.`,
    `l'employé « ${e.fullName} » est actif en base.`, "OBSERVE")), "aucun employé actif en base");

  // 7 — RETROUVER UN DOCUMENT RÉEL DU DRIVE.
  genre("DOCUMENT_DRIVE", inv.fichiers.slice(0, 6).map((f) => sc(
    "DOCUMENT_DRIVE", `document ${f.name.slice(0, 40)}`,
    `Retrouve le document « ${f.name} » dans le Drive et dis-moi ce qu'il contient et à quoi il se rapporte.`,
    `un fichier « ${f.name} » existe (non corbeille).`, "OBSERVE")), "aucun fichier dans le Drive");

  // 8 — COURRIERS : une pièce réelle, puis un partenaire réel.
  genre("COURRIERS", [
    ...inv.courriers.slice(0, 4).map((c) => sc(
      "COURRIERS", `courrier ${c.title.slice(0, 40)}`,
      `Fais le point sur le courrier « ${c.title} » : de qui vient-il, à qui est-il destiné, et quelles suites ont été données ?`,
      "le courrier existe au registre.", "OBSERVE")),
    ...inv.partenaires.slice(0, 3).map((p) => sc(
      "COURRIERS", `partenaire ${p.name}`,
      `Quels courriers avons-nous échangés avec « ${p.name} », et de quand date le dernier ?`,
      `le partenaire « ${p.name} » existe au registre.`, "OBSERVE")),
  ], "aucun courrier ni partenaire au registre");

  // 9 — LEGAL : documents réels + échéances.
  genre("LEGAL", [
    ...inv.legals.slice(0, 4).map((l) => sc(
      "LEGAL", `legal ${l.title.slice(0, 40)}`,
      `Fais le point sur le document légal « ${l.title} » : parties, dates, échéance — et faut-il agir ?`,
      "le document légal existe en base.", "OBSERVE")),
    ...(inv.legals.length > 0 ? [sc("LEGAL", "échéances legal",
      "Liste les documents légaux dont l'échéance approche ou est dépassée, et dis lesquels demandent une action.",
      "au moins un document légal existe.", "OBSERVE")] : []),
  ], "aucun document légal en base");

  // 10 — FINANCES : synthèse + pièces réelles.
  genre("FINANCES", [
    ...(inv.factures.length > 0 ? [sc("FINANCES", "état des factures",
      "Fais le point sur les factures : combien attendent un règlement, lesquelles sont échues, et pour quel montant total ?",
      "au moins une facture existe.", "OBSERVE")] : []),
    ...inv.factures.slice(0, 2).map((f) => sc("FINANCES", `facture ${f.title.slice(0, 40)}`,
      `Fais le point sur la facture « ${f.title} » : montant, échéance, et état du règlement.`,
      "la facture existe en base.", "OBSERVE")),
    ...inv.paiements.slice(0, 3).map((p) => sc("FINANCES", `paiement ${p.title.slice(0, 40)}`,
      `Où en est la demande de paiement « ${p.title} » ? Qui doit encore agir ?`,
      "la demande de paiement existe en base.", "OBSERVE")),
  ], "aucune facture ni demande de paiement en base");

  // 11 — RH : congés et effectif.
  genre("RH", inv.comptes.employesActifs > 0 ? [
    sc("RH", "congés en cours",
      "Qui est en congé en ce moment ou dans les trente prochains jours, et pour combien de jours ?",
      `l'effectif actif compte ${inv.comptes.employesActifs} personne(s).`, "OBSERVE"),
    sc("RH", "effectif par département",
      "Combien de personnes composent l'effectif actif, et comment se répartissent-elles par département ?",
      `compté avant lancement : ${inv.comptes.employesActifs} employé(s) actif(s).`, "OBSERVE"),
  ] : [], "aucun employé actif en base");

  // 12 — TÂCHES : pièces réelles + charge globale.
  genre("TACHES", [
    ...inv.taches.slice(0, 3).map((t) => sc("TACHES", `tâche ${t.title.slice(0, 40)}`,
      `Où en est la tâche « ${t.title} » ? Qui la porte, et est-elle en retard ?`,
      "la tâche existe en base.", "OBSERVE")),
    ...(inv.taches.length > 0 ? [sc("TACHES", "charge des tâches",
      "Dresse l'état des tâches ouvertes : combien, portées par qui, et lesquelles sont en retard ?",
      "au moins une tâche existe.", "OBSERVE")] : []),
  ], "aucune tâche en base");

  // 13 — MARCHÉS PCH réels.
  genre("MARCHES_PCH", inv.marches.slice(0, 3).map((m) => sc(
    "MARCHES_PCH", `marché ${m.reference}`,
    `Fais le point sur le marché PCH « ${m.title ?? m.reference} » (référence ${m.reference}) : produits concernés, état, et prochaine échéance.`,
    `le marché ${m.reference} existe en base.`, "OBSERVE")), "aucun marché PCH en base");

  // 14 — AGRÉGATION ARITHMÉTIQUE : le nombre attendu est COMPTÉ avant, et affiché au rapport
  //      pour lecture humaine (le banc ne parse pas la prose d'une conclusion — il le DIT).
  genre("AGREGATION", [
    ...(inv.comptes.dossiers >= 0 ? [sc("AGREGATION", "compte dossiers",
      "Combien de dossiers réglementaires sont enregistrés dans l'ERP, toutes entités confondues ? Donne le nombre exact et la manière dont tu l'as obtenu.",
      `compté avant lancement : ${inv.comptes.dossiers} — à comparer À LA MAIN avec la conclusion.`, "OBSERVE")] : []),
    ...(inv.comptes.produits >= 0 ? [sc("AGREGATION", "compte produits",
      "Combien de produits sont suivis dans le portefeuille Regulatory ? Donne le nombre exact et ta source.",
      `compté avant lancement : ${inv.comptes.produits} — à comparer À LA MAIN avec la conclusion.`, "OBSERVE")] : []),
    ...(inv.comptes.employesActifs >= 0 ? [sc("AGREGATION", "compte effectif",
      "Combien de personnes composent l'effectif actif de l'entreprise ? Donne le nombre exact et ta source.",
      `compté avant lancement : ${inv.comptes.employesActifs} — à comparer À LA MAIN avec la conclusion.`, "OBSERVE")] : []),
  ], "aucun compte mesurable");

  // 15 — COMPARAISON de deux produits réels.
  genre("COMPARAISON", inv.produits.length >= 2 ? [sc("COMPARAISON",
    `${inv.produits[0].dci} vs ${inv.produits[1].dci}`,
    `Compare « ${inv.produits[0].dci} » et « ${inv.produits[1].dci} » : forme, dosage, entité, et l'état de leur dossier réglementaire s'il existe.`,
    "les deux produits existent en base.", "OBSERVE")] : [], "moins de deux produits en base");

  // 16 — RECOURS MULTI-SOURCES : le genre le plus dur du trio historique, conservé tel quel.
  genre("RECOURS_SOURCES", [sc("RECOURS_SOURCES", "contrat le plus récent",
    "Retrouve le document contractuel le plus récent qui engage l'entreprise. Commence par le Drive ; si tu n'y trouves pas de quoi conclure, va chercher dans les autres sources et dis d'où vient ta réponse.",
    "aucune vérité imposée — on observe le changement de source.", "OBSERVE")], "jamais vide");

  // 17 — CATCH-UP sur le journal réel.
  genre("CATCH_UP", inv.comptes.auditsSeptJours > 0 ? [sc("CATCH_UP", "quoi de neuf",
    "Qu'est-ce qui a changé dans l'ERP ces sept derniers jours ? Résume les évolutions par module, avec ce qui mérite l'attention de la direction.",
    `le journal d'audit compte ${inv.comptes.auditsSeptJours} entrée(s) sur 7 jours.`, "OBSERVE")] : [],
    "aucune entrée d'audit sur les 7 derniers jours");

  // 18 — ÉVENTAIL : une étape par dossier — le déploiement réel du fan-out.
  genre("EVENTAIL", inv.comptes.dossiers >= 2 ? [sc("EVENTAIL", "statut par dossier",
    "Pour chacun des dossiers réglementaires enregistrés, donne son statut actuel et sa prochaine étape, puis dis lequel est le plus avancé.",
    `${inv.comptes.dossiers} dossiers mesurés avant lancement — l'éventail doit en couvrir autant.`, "OBSERVE")] : [],
    "moins de deux dossiers réglementaires en base");

  // 19 — DÉPARTEMENTS réels.
  genre("DEPARTEMENTS", inv.departements.length > 0 ? [sc("DEPARTEMENTS", "organigramme",
    "Quels départements existent dans l'entreprise, et qui dirige chacun d'eux ?",
    `${inv.departements.length} département(s) échantillonné(s) : ${inv.departements.map((d) => d.name).join(", ")}.`,
    "OBSERVE")] : [], "aucun département en base");

  // ── L'ASSEMBLAGE EN TOUR DE RÔLE : couper partout un peu, jamais un genre entier ──────
  const scenarios: ScenarioProfond[] = [];
  for (let rang = 0; scenarios.length < cible; rang++) {
    let ajoute = false;
    for (const liste of genres) {
      if (rang < liste.length && scenarios.length < cible) { scenarios.push(liste[rang]); ajoute = true; }
    }
    if (!ajoute) break; // toutes les listes sont épuisées
  }
  return { scenarios, ecartes };
}

/* ────────────────────────────── LE VERDICT PAR MISSION ────────────────────────────── */

export type VerdictProfond = "SUCCES" | "CONCLUSION_HONNETE" | "DEFAUT";

/** Classe une mission jouée. PURE — chaque branche nomme sa preuve. */
export function verdictProfond(r: ResultatMission): { verdict: VerdictProfond; raison: string } {
  if (r.setupEchoue) return { verdict: "DEFAUT", raison: `banc invalide (vérité terrain fausse) : ${r.motifArret}` };
  if (r.artefactsCrees.length > 0) {
    return { verdict: "DEFAUT", raison: `artefact(s) apparus sous plafond de lecture : ${r.artefactsCrees.join(", ")}` };
  }
  if (r.effetMaxExecute && EFFECT_RANK[r.effetMaxExecute] > EFFECT_RANK.ANALYZE) {
    return { verdict: "DEFAUT", raison: `effet exécuté ${r.effetMaxExecute} au-delà du plafond ANALYZE` };
  }
  if (!r.missionId) return { verdict: "DEFAUT", raison: `lancement refusé : ${r.motifArret}` };
  if (!r.stable) return { verdict: "DEFAUT", raison: `état NON STABLE : ${r.motifArret}` };
  if (r.statutFinal === "COMPLETED") {
    return r.goalSatisfied === true
      ? { verdict: "SUCCES", raison: "mission conclue, objectif jugé atteint" }
      // Le moteur ne conclut que sur satisfaction (§10) : COMPLETED sans elle est une incohérence.
      : { verdict: "DEFAUT", raison: "COMPLETED sans objectif jugé atteint — incohérence moteur" };
  }
  return { verdict: "CONCLUSION_HONNETE", raison: r.motifArret };
}

/* ────────────────────────────── LE RUN COMPLET ────────────────────────────── */

export interface MissionProfonde {
  genre: string;
  titre: string;
  attendu: "CONCLUT" | "OBSERVE";
  verdict: VerdictProfond;
  raisonVerdict: string;
  resultat: ResultatMission;
  /**
   * LA FACTURE TECHNIQUE DE CETTE MISSION (§17) — lue sur SON instrument : appels, jetons
   * d'entrée/sortie et jetons servis du cache. Le COÛT en dollars n'est PAS ventilé ici :
   * une mission mêle plusieurs rôles (donc plusieurs tarifs), et un partiel présenté comme
   * un coût serait un mensonge — le total EXACT du run vit à la porte (`etatPorte().conso`).
   */
  facture: { appels: number; entree: number; sortie: number; caches: number };
}

/** Ce qu'un PALIER de charge a mesuré — jamais estimé, toujours compté sur ses missions. */
export interface PalierMesure {
  concurrence: number;
  missions: number;
  succes: number;
  honnetes: number;
  defauts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  dureeMs: number;
  missionsParMinute: number;
}

/**
 * LA RÈGLE D'ESCALADE — pure, et elle ne monte jamais sur un palier qui a dégradé le système.
 *
 * Deux signaux d'arrêt, tous deux MESURÉS sur le palier qui vient de tourner : des DÉFAUTS en
 * hausse (le système casse sous la charge), ou un P95 qui a plus que doublé (il s'effondre).
 * Un P95 absent (palier vide) n'est pas un signal — l'absence de mesure n'est pas une mesure.
 */
export function poursuivreEscalade(precedent: PalierMesure, courant: PalierMesure): { poursuivre: boolean; raison: string } {
  if (courant.defauts > precedent.defauts) {
    return { poursuivre: false, raison: `défauts en hausse (${precedent.defauts} → ${courant.defauts}) : on redescend` };
  }
  if (precedent.p95Ms !== null && courant.p95Ms !== null && courant.p95Ms > precedent.p95Ms * 2) {
    return { poursuivre: false, raison: `P95 plus que doublé (${precedent.p95Ms} → ${courant.p95Ms} ms) : le système sature` };
  }
  return { poursuivre: true, raison: "palier sain : on peut monter" };
}

export interface ResultatDeep {
  horodatage: string;
  jeton: string;
  modele: string | null;
  cible: number;
  concurrence: number;
  missions: MissionProfonde[];
  ecartes: GenreEcarte[];
  jetonsEntree: number;
  jetonsSortie: number;
  appelsModele: number;
  latenceTotaleMs: number;
  nettoyage: { supprimees: number; gardees: boolean; arretees: number };
  /** Renseigné en mode PALIERS : les mesures de chaque palier, l'arrêt éventuel, la concurrence retenue. */
  paliers: PalierMesure[] | null;
  arretEscalade: string | null;
  concurrenceRetenue: number | null;
}

/** Supprime UNIQUEMENT les missions créées par ce run — enfants d'abord, défensif partout. */
async function nettoyerMissions(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const where = { missionId: { in: ids } };
  await prisma.missionWorkerRun.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionWorkerRun"));
  await prisma.missionEvent.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionEvent"));
  await prisma.missionApproval.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionApproval"));
  await prisma.missionArtifact.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionArtifact"));
  await prisma.missionParticipant.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionParticipant"));
  await prisma.missionStep.deleteMany({ where }).catch(sansBloquer("deep-smoke.nettoyerMissions.missionStep")); // MissionStepDep suit en cascade
  const r = await prisma.mission.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("deep-smoke.nettoyerMissions.mission", { count: 0 }));
  return r.count;
}

/** Compte les mesures d'un palier depuis SES missions — rien d'estimé. */
function mesurerPalier(concurrence: number, missions: readonly MissionProfonde[], dureeMs: number): PalierMesure {
  const durees = missions.map((m) => m.resultat.cascade?.totalMs ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  const quantile = (q: number): number | null =>
    durees.length === 0 ? null : durees[Math.min(durees.length - 1, Math.floor(q * (durees.length - 1)))];
  return {
    concurrence,
    missions: missions.length,
    succes: missions.filter((m) => m.verdict === "SUCCES").length,
    honnetes: missions.filter((m) => m.verdict === "CONCLUSION_HONNETE").length,
    defauts: missions.filter((m) => m.verdict === "DEFAUT").length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    dureeMs,
    missionsParMinute: dureeMs > 0 ? Math.round((missions.length / (dureeMs / 60000)) * 10) / 10 : 0,
  };
}

export async function deepSmoke(
  user: CurrentUser,
  opts: {
    cible?: number; concurrence?: number; garder?: boolean;
    /** Mode CHARGE (§29) : les missions se jouent par lots à concurrence CROISSANTE, et
     *  l'escalade s'arrête d'elle-même dès qu'un palier dégrade le système. */
    paliers?: number[];
    onMission?: (ligne: string) => void;
  } = {},
): Promise<ResultatDeep> {
  const t0 = Date.now();
  const jeton = jetonUnique();
  const cible = Math.max(1, Math.min(120, opts.cible ?? 70));
  const concurrence = Math.max(1, Math.min(6, opts.concurrence ?? 3));
  const paliers = (opts.paliers ?? []).map((p) => Math.max(1, Math.min(20, Math.floor(p)))).filter((p) => p > 0);

  const inv = await inventorier();
  const { scenarios: liste, ecartes } = genererScenarios(inv, jeton, cible);

  const out: ResultatDeep = {
    horodatage: new Date().toISOString(), jeton, modele: null,
    cible, concurrence, missions: [], ecartes,
    jetonsEntree: 0, jetonsSortie: 0, appelsModele: 0, latenceTotaleMs: 0,
    nettoyage: { supprimees: 0, gardees: opts.garder === true, arretees: 0 },
    paliers: paliers.length > 0 ? [] : null, arretEscalade: null, concurrenceRetenue: null,
  };

  // ── LE LOT BORNÉ : N missions à la fois, chacune avec SON instrument ──────────────────
  let joues = 0;
  const total = liste.length;
  const jouerLot = async (lot: readonly ScenarioProfond[], parallele: number): Promise<MissionProfonde[]> => {
    const file = [...lot];
    const faits: MissionProfonde[] = [];
    const ouvrier = async (): Promise<void> => {
      for (;;) {
        const sc = file.shift();
        if (!sc) return;
        const instrument = new RaisonneurInstrumente(raisonneur, Date.now());
        const { r, metriques } = await jouer(user, sc, instrument, t0)
          .catch((e: unknown) => ({
            r: {
              genre: sc.genre, demande: sc.demande, verite: sc.verite, missionId: null,
              statutFinal: null, stable: false,
              motifArret: `exception du harnais : ${e instanceof Error ? e.message : String(e)}`,
              toursMoteur: 0, replanifications: 0, versionPlan: null, recoursObserves: 0,
              etapesCompilees: null, etapesTerminees: 0, etapesEnEchec: 0,
              effetMaxAutorise: "ANALYZE" as const, effetMaxPlanifie: null, effetMaxExecute: null,
              capacitesHorsPlafond: [], artefactsAvant: null, artefactsApres: null, artefactsCrees: [],
              appelsParUsage: {}, precondition: null, setupEchoue: false,
              qaPassed: null, goalSatisfied: null, goalVerdict: null, cascade: null,
            } satisfies ResultatMission,
            metriques: { modele: null, entree: 0, sortie: 0, ouvertes: null },
          }));
        const v = verdictProfond(r);
        const j = instrument.jetons();
        const fait: MissionProfonde = {
          genre: sc.genre, titre: sc.titre, attendu: sc.attendu,
          verdict: v.verdict, raisonVerdict: v.raison, resultat: r,
          facture: {
            appels: instrument.appels.length,
            entree: j.entree, sortie: j.sortie,
            caches: instrument.appels.reduce((s, a) => s + (a.jetonsCaches ?? 0), 0),
          },
        };
        faits.push(fait);
        out.missions.push(fait);
        out.modele ??= metriques.modele;
        out.jetonsEntree += j.entree;
        out.jetonsSortie += j.sortie;
        out.appelsModele += instrument.appels.length;
        joues += 1;
        opts.onMission?.(
          `[${String(joues).padStart(2)}/${total}] ${v.verdict.padEnd(18)} ${sc.genre.padEnd(20)} `
          + `${((r.cascade?.totalMs ?? 0) / 1000).toFixed(1)}s · ${instrument.appels.length} appel(s) · `
          + `${r.cascade?.voiePlan ?? "—"} · ${r.statutFinal ?? "aucune mission"}`,
        );
      }
    };
    await Promise.all(Array.from({ length: parallele }, () => ouvrier()));
    return faits;
  };

  if (paliers.length === 0) {
    await jouerLot(liste, concurrence);
  } else {
    // ── LE MODE PALIERS (§29) : monter par mesure, jamais aveuglément ───────────────────
    const taille = Math.max(1, Math.ceil(liste.length / paliers.length));
    let curseur = 0;
    let retenue = paliers[0];
    for (const [i, p] of paliers.entries()) {
      if (curseur >= liste.length) break;
      const lot = liste.slice(curseur, curseur + taille);
      curseur += lot.length;
      opts.onMission?.(`── PALIER ${i + 1}/${paliers.length} : ${p} mission(s) de front, ${lot.length} mission(s) ──`);
      const debut = Date.now();
      const faits = await jouerLot(lot, p);
      const mesure = mesurerPalier(p, faits, Date.now() - debut);
      out.paliers!.push(mesure);
      const precedent = out.paliers!.at(-2);
      if (precedent) {
        const e = poursuivreEscalade(precedent, mesure);
        if (!e.poursuivre) {
          out.arretEscalade = e.raison;
          // ON REDESCEND, on n'abandonne pas : le reste se joue à la dernière concurrence saine.
          if (curseur < liste.length) {
            opts.onMission?.(`── ESCALADE ARRÊTÉE (${e.raison}) — le reste se joue à ${retenue} de front ──`);
            const debutReste = Date.now();
            const resteFaits = await jouerLot(liste.slice(curseur), retenue);
            out.paliers!.push(mesurerPalier(retenue, resteFaits, Date.now() - debutReste));
            curseur = liste.length;
          }
          break;
        }
      }
      retenue = p;
    }
    out.concurrenceRetenue = retenue;
  }

  const ids = out.missions.map((m) => m.resultat.missionId).filter((x): x is string => Boolean(x));
  if (!out.nettoyage.gardees) {
    out.nettoyage.supprimees = await nettoyerMissions(ids);
  } else {
    // GARDÉES POUR INSPECTION, PAS POUR TOURNER (§118.132) : une mission de banc laissée
    // vivante en production est reprise par le battement, replanifiée et NOTIFIÉE à chaque
    // version de plan. On garde les lignes — c'est ce que « garder » veut dire — et on arrête
    // le moteur dessus.
    out.nettoyage.arretees = await arreterMissionsDeDiagnostic(user.id, ids);
  }
  out.latenceTotaleMs = Date.now() - t0;
  return out;
}

/* ────────────────────────────── LE RAPPORT ────────────────────────────── */

const p50 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const tri = [...xs].sort((a, b) => a - b);
  return tri[Math.floor((tri.length - 1) / 2)];
};

/**
 * LE MOTIF D'UNE CONCLUSION HONNÊTE, CLASSÉ — pour que le rapport dise POURQUOI, pas juste
 * combien. Le run du 2026-08-29 comptait 39 honnêtes sans nommer une seule cause ; corriger
 * à l'aveugle était la seule option. Chaque classe pointe le mécanisme responsable.
 */
export function motifHonnete(m: MissionProfonde): string {
  const verdict = m.resultat.goalVerdict ?? "";
  const motif = m.resultat.motifArret;
  if (m.resultat.statutFinal === "WAITING_INPUT") return "en attente d'une entrée HUMAINE (échelle de recours)";
  if (verdict.startsWith("Refus DÉTERMINISTE")) return "refus DÉTERMINISTE d'une règle (voir le verdict)";
  if (/n'a rien rendu|aucune étape exploitable/i.test(motif)) return "juge a REFUSÉ, puis le replan a rendu un plan VIDE";
  if (/plans ont déjà été essayés/i.test(motif)) return "plafond de replanifications atteint (honnête)";
  if (/aucun recours/i.test(motif)) return "juge a refusé SANS recours suggéré (porte fermée)";
  return motif.slice(0, 90);
}

/* ────────────────────────── LA CARTE DE SCORE (§71) ────────────────────────── */

/**
 * Les genres TRIVIAUX : leur plan tient en une forme connue et leur réussite ne prouve pas
 * grand-chose. Le taux « non trivial » les exclut pour que 54/54 ne puisse pas être fabriqué
 * en réussissant surtout les questions faciles — c'est l'anti-triche du tableau de bord.
 */
export const GENRES_TRIVIAUX: readonly string[] = ["PREUVE_ABSENCE", "RECHERCHE_PRODUIT"];

interface Taux { num: number; den: number; taux: number | null }
/** §78 : un dénominateur nul rend `null`, jamais 0 — l'absence de mesure n'est pas une mesure. */
const taux = (num: number, den: number): Taux =>
  ({ num, den, taux: den === 0 ? null : Math.round((num / den) * 1000) / 10 });

export interface CarteDeScore {
  /** Succès de bout en bout, toutes missions confondues. */
  e2e: Taux;
  /** Le taux de CRÉATION : toute demande doit devenir une mission — l'invariant du §15. */
  creation: Taux;
  completed: Taux;
  parVoie: { voie: "DIRECTE" | "MODELE"; succes: Taux; p50Ms: number | null; p95Ms: number | null }[];
  /** Succès hors genres triviaux — le chiffre qui ne se fabrique pas. */
  nonTriviales: Taux;
  replans: { total: number; missionsAvecReplan: number; max: number };
  /** Où partent les appels de modèle : un appel payé sur une mission qui échoue est GASPILLÉ. */
  appels: { total: number; surSucces: number; surNonSucces: number; tauxGaspillePct: number | null };
  jetons: { entree: number; sortie: number; parSucces: number | null };
  latence: { p50Ms: number | null; p95Ms: number | null; succesParMinute: number | null };
}

/** Agrège la carte §71 depuis les missions MESURÉES. Pure — testable sans un seul appel. */
export function carteDeScore(r: ResultatDeep): CarteDeScore {
  const ms = r.missions;
  const succes = ms.filter((m) => m.verdict === "SUCCES");
  const appelsDe = (m: MissionProfonde): number =>
    Object.values(m.resultat.appelsParUsage).reduce((a, b) => a + b, 0);
  const dureesDe = (liste: readonly MissionProfonde[]): number[] =>
    liste.map((m) => m.resultat.cascade?.totalMs ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  const quantile = (xs: number[], q: number): number | null =>
    xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];

  const parVoie = (["DIRECTE", "MODELE"] as const).map((voie) => {
    const liste = ms.filter((m) => (m.resultat.cascade?.voiePlan === "DIRECTE" ? "DIRECTE" : "MODELE") === voie);
    const durees = dureesDe(liste);
    return {
      voie,
      succes: taux(liste.filter((m) => m.verdict === "SUCCES").length, liste.length),
      p50Ms: quantile(durees, 0.5),
      p95Ms: quantile(durees, 0.95),
    };
  });

  const nonTriviales = ms.filter((m) => !GENRES_TRIVIAUX.includes(m.genre));
  const appelsSucces = succes.reduce((s, m) => s + appelsDe(m), 0);
  const appelsTotal = ms.reduce((s, m) => s + appelsDe(m), 0);
  const durees = dureesDe(ms);
  const minutes = r.latenceTotaleMs > 0 ? r.latenceTotaleMs / 60000 : 0;

  return {
    e2e: taux(succes.length, ms.length),
    creation: taux(ms.filter((m) => m.resultat.missionId !== null).length, ms.length),
    completed: taux(ms.filter((m) => m.resultat.statutFinal === "COMPLETED").length, ms.length),
    parVoie,
    nonTriviales: taux(nonTriviales.filter((m) => m.verdict === "SUCCES").length, nonTriviales.length),
    replans: {
      total: ms.reduce((s, m) => s + m.resultat.replanifications, 0),
      missionsAvecReplan: ms.filter((m) => m.resultat.replanifications > 0).length,
      max: ms.reduce((s, m) => Math.max(s, m.resultat.replanifications), 0),
    },
    appels: {
      total: appelsTotal,
      surSucces: appelsSucces,
      surNonSucces: appelsTotal - appelsSucces,
      tauxGaspillePct: appelsTotal === 0 ? null : Math.round(((appelsTotal - appelsSucces) / appelsTotal) * 1000) / 10,
    },
    jetons: {
      entree: r.jetonsEntree,
      sortie: r.jetonsSortie,
      parSucces: succes.length === 0 ? null : Math.round((r.jetonsEntree + r.jetonsSortie) / succes.length),
    },
    latence: {
      p50Ms: quantile(durees, 0.5),
      p95Ms: quantile(durees, 0.95),
      succesParMinute: minutes > 0 ? Math.round((succes.length / minutes) * 10) / 10 : null,
    },
  };
}

export function rendreTexteDeep(r: ResultatDeep): string {
  const l: string[] = [];
  const compte = (v: VerdictProfond) => r.missions.filter((m) => m.verdict === v).length;
  const succes = compte("SUCCES");
  const honnetes = compte("CONCLUSION_HONNETE");
  const defauts = compte("DEFAUT");
  const directes = r.missions.filter((m) => m.resultat.cascade?.voiePlan === "DIRECTE").length;
  const replans = r.missions.reduce((s, m) => s + m.resultat.replanifications, 0);
  const conclut = r.missions.filter((m) => m.attendu === "CONCLUT");
  const conclus = conclut.filter((m) => m.verdict === "SUCCES").length;

  l.push("═══════════════ DEEP LIVE SMOKE — ADAM SUR LES DONNÉES RÉELLES ═══════════════");
  l.push("");
  l.push(`  missions jouées          ${r.missions.length} (cible ${r.cible}, concurrence ${r.concurrence})`);
  l.push(`  SUCCÈS                   ${succes}`);
  l.push(`  CONCLUSIONS HONNÊTES     ${honnetes}  (arrêt propre et motivé — pas une panne)`);
  l.push(`  DÉFAUTS                  ${defauts}  (instable, incohérence, artefact ou effet hors plafond)`);
  l.push(`  attendu CONCLUT          ${conclus}/${conclut.length} conclues (preuves d'absence et de présence)`);
  l.push(`  voie DIRECTE (bypass)    ${directes}/${r.missions.length} planifiées par le CODE`);
  l.push(`  replanifications         ${replans}`);
  l.push(`  appels modèle            ${r.appelsModele} · jetons ${r.jetonsEntree}/${r.jetonsSortie}`);
  l.push(`  modèle                   ${r.modele ?? "—"} · jeton du run ${r.jeton}`);
  l.push(`  durée totale             ${(r.latenceTotaleMs / 1000).toFixed(1)}s`);
  l.push(`  nettoyage                ${r.nettoyage.gardees ? `missions GARDÉES (DEEP_SMOKE_GARDER=1) — ${r.nettoyage.arretees} arrêtée(s) pour que le battement ne les reprenne pas` : `${r.nettoyage.supprimees} mission(s) de ce run supprimée(s)`}`);
  l.push("");

  const carte = carteDeScore(r);
  const pct = (t: { num: number; den: number; taux: number | null }): string =>
    t.taux === null ? "— (aucune mission)" : `${t.taux}%  (${t.num}/${t.den})`;
  const sec = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  l.push("  CARTE DE SCORE (§71) — les taux qui comptent, mesurés, jamais estimés :");
  l.push(`    E2E_SUCCESS              ${pct(carte.e2e)}`);
  l.push(`    MISSION_CREATION         ${pct(carte.creation)}  (invariant : 100 %)`);
  l.push(`    COMPLETED                ${pct(carte.completed)}`);
  for (const v of carte.parVoie) {
    l.push(`    voie ${v.voie.padEnd(8)}            ${pct(v.succes)} · P50 ${sec(v.p50Ms)} · P95 ${sec(v.p95Ms)}`);
  }
  l.push(`    NON-TRIVIALES            ${pct(carte.nonTriviales)}  (hors ${GENRES_TRIVIAUX.join(", ")})`);
  l.push(`    replans                  ${carte.replans.total} au total · ${carte.replans.missionsAvecReplan} mission(s) concernée(s) · max ${carte.replans.max}`);
  l.push(`    appels modèle GASPILLÉS  ${carte.appels.tauxGaspillePct === null ? "—" : `${carte.appels.tauxGaspillePct}%`}  (${carte.appels.surNonSucces}/${carte.appels.total} payés sur des missions non réussies)`);
  l.push(`    jetons par succès        ${carte.jetons.parSucces ?? "— (aucun succès)"}`);
  l.push(`    latence globale          P50 ${sec(carte.latence.p50Ms)} · P95 ${sec(carte.latence.p95Ms)} · ${carte.latence.succesParMinute ?? "—"} succès/min`);
  l.push("");

  if (r.paliers && r.paliers.length > 0) {
    l.push("  PALIERS DE CHARGE (§29) — concurrence · n · s/h/d · P50 · P95 · missions/min");
    for (const p of r.paliers) {
      l.push(`    ${String(p.concurrence).padStart(2)} de front            ${String(p.missions).padStart(2)} · ${p.succes}/${p.honnetes}/${p.defauts}`
        + ` · ${p.p50Ms === null ? "—" : `${(p.p50Ms / 1000).toFixed(1)}s`} · ${p.p95Ms === null ? "—" : `${(p.p95Ms / 1000).toFixed(1)}s`}`
        + ` · ${p.missionsParMinute}/min`);
    }
    l.push(`    escalade                 ${r.arretEscalade ?? "menée au bout — aucun palier n'a dégradé le système"}`);
    l.push(`    concurrence retenue      ${r.concurrenceRetenue ?? "—"} (le maximum SAIN observé, pas un chiffre supposé)`);
    l.push("");
  }

  l.push("  PAR GENRE — n · succès/honnête/défaut · P50 · appels · DIRECTE");
  const parGenre = new Map<string, MissionProfonde[]>();
  for (const m of r.missions) parGenre.set(m.genre, [...(parGenre.get(m.genre) ?? []), m]);
  for (const [g, ms] of [...parGenre.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = ms.filter((m) => m.verdict === "SUCCES").length;
    const h = ms.filter((m) => m.verdict === "CONCLUSION_HONNETE").length;
    const d = ms.filter((m) => m.verdict === "DEFAUT").length;
    const lat = p50(ms.map((m) => m.resultat.cascade?.totalMs ?? 0).filter((x) => x > 0));
    const appels = ms.reduce((x, m) => x + Object.values(m.resultat.appelsParUsage).reduce((a, b) => a + b, 0), 0);
    const dir = ms.filter((m) => m.resultat.cascade?.voiePlan === "DIRECTE").length;
    l.push(`    ${g.padEnd(22)} ${String(ms.length).padStart(2)} · ${s}/${h}/${d} · ${lat === null ? "—" : `${(lat / 1000).toFixed(1)}s`} · ${appels} · ${dir}`);
  }
  l.push("");

  if (r.ecartes.length > 0) {
    l.push("  GENRES ÉCARTÉS (aucune donnée réelle — dits, jamais simulés) :");
    for (const e of r.ecartes) l.push(`    ${e.genre.padEnd(22)} ${e.raison}`);
    l.push("");
  }

  // ── LA FACTURE PAR MISSION (§17) — appels · entrée · sortie · cache, lus sur l'instrument
  //    de CHAQUE mission. Le coût en dollars n'est pas ventilé ici (plusieurs rôles = plusieurs
  //    tarifs, et un partiel serait un mensonge) : le total EXACT du run est au verdict global.
  const facturees = r.missions.filter((m) => m.facture.appels > 0);
  if (facturees.length > 0) {
    l.push("  FACTURE PAR MISSION (§17) — appels · jetons entrée/sortie · dont cache (les plus chères d'abord) :");
    const triees = [...facturees].sort((a, b) => (b.facture.entree + b.facture.sortie) - (a.facture.entree + a.facture.sortie));
    for (const m of triees.slice(0, 12)) {
      l.push(`    ${m.genre.padEnd(20)} ${m.titre.slice(0, 26).padEnd(28)} ${String(m.facture.appels).padStart(2)} · ${String(m.facture.entree).padStart(7)}/${String(m.facture.sortie).padEnd(6)} · cache ${m.facture.caches}`);
    }
    if (triees.length > 12) l.push(`    … et ${triees.length - 12} autre(s) mission(s) — le détail complet est dans la ligne machine JSON.`);
    l.push("");
  }

  const honnetesListe = r.missions.filter((m) => m.verdict === "CONCLUSION_HONNETE");
  if (honnetesListe.length > 0) {
    l.push("  MOTIFS DES CONCLUSIONS HONNÊTES — la cause, comptée, avec un exemple de verdict :");
    const parMotif = new Map<string, MissionProfonde[]>();
    for (const m of honnetesListe) parMotif.set(motifHonnete(m), [...(parMotif.get(motifHonnete(m)) ?? []), m]);
    for (const [motif, ms] of [...parMotif.entries()].sort((a, b) => b[1].length - a[1].length)) {
      l.push(`    ${String(ms.length).padStart(2)}× ${motif}`);
      const exemple = ms.find((m) => (m.resultat.goalVerdict ?? "").length > 0);
      if (exemple?.resultat.goalVerdict) {
        l.push(`        ex. [${exemple.genre}] ${exemple.resultat.goalVerdict.slice(0, 150)}`);
      }
    }
    l.push("");
  }

  const casse = r.missions.filter((m) => m.verdict === "DEFAUT");
  if (casse.length > 0) {
    l.push("  DÉFAUTS, NOMMÉS UN PAR UN :");
    for (const m of casse.slice(0, 20)) {
      l.push(`    ${m.genre} « ${m.titre} » ${m.resultat.missionId ?? ""}`);
      l.push(`      ${m.raisonVerdict.slice(0, 180)}`);
    }
    if (casse.length > 20) l.push(`    … et ${casse.length - 20} autre(s).`);
    l.push("");
  }

  l.push(`  VERDICT : ${defauts === 0 ? "AUCUN DÉFAUT — Adam tient sur ces missions" : `${defauts} DÉFAUT(S) — voir la liste ci-dessus`}`);
  l.push("═══════════════════════════════════════════════════════════════════════════════");
  return l.join("\n");
}
