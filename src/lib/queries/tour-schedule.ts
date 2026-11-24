import { prisma } from "@/lib/prisma";
import { lienCouvre, type LienCouverture } from "@/lib/annuaires/services";
import { clausePanelDuKam, type SessionUser } from "@/lib/rbac";
import {
  avancementTournee, echeanceDeSoumission, etatVisite, fenetreDeVue, fenetreRapport, periodeDe,
  retardDeSoumission, retraitInterditApresRevision,
  type AvancementTournee, type EtatVisite, type RetardDeSoumission, type StatutPlan, type VueTournee,
} from "@/lib/sfe/tournee";
import { lireReglageTournee } from "@/lib/sfe/tournee-reglage";
import { planDejaValide } from "@/lib/sfe/grille-tournee";
import { diagnosticPanelVide, type CausePanelVide } from "@/lib/sfe/panel-diagnostic";
import { remisesDesVisites, type RemisesDeVisite } from "@/lib/queries/promo-remises";
import { getSfeConfig } from "@/lib/sfe";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { requisDuPraticien } from "@/lib/segmentation/lettre-requise";
import type { Lettre } from "@/lib/segmentation/regles";
import { besoinsAEcrire, type BesoinAEcrire } from "@/lib/besoins-services/service";

/**
 * L'EMPLOI DU TEMPS D'UN KAM — ce que l'écran affiche, et ce que la Direction compte.
 *
 * ── UN SEUL CALCUL D'AVANCEMENT ─────────────────────────────────────────────────────────────
 *
 * `avancementTournee` (module pur) est appelée ICI, et le tableau de bord de la Direction
 * l'appelle aussi. Deux écrans qui comptent séparément divergent, toujours (§118.51) — et le
 * symptôme serait un KAM à qui l'on reproche un taux que son propre écran ne montre pas.
 *
 * ── LES VISITES SONT DES `MedicalVisit` ─────────────────────────────────────────────────────
 *
 * Planifiée, imprévue ou commandée par la Direction : une seule table, distinguée par
 * `tourPlanId` (nul = hors plan) et `origin`. Le dénominateur de « visitées / planifiées » se lit
 * donc à un seul endroit.
 */

export interface LigneEmploiDuTemps {
  id: string;
  date: Date;
  doctorId: string | null;
  doctorName: string;
  institution: string | null;
  /** La WILAYA du praticien — le seul découpage géographique des annuaires (la ville a quitté la feuille). */
  wilaya: string | null;
  specialty: string | null;
  etat: EtatVisite;
  /** D'où vient la visite : `PLAN`, `UNPLANNED`, `DIRECTION`. */
  origine: string;
  objectif: string | null;
  /** Le compte rendu, quand il est fait — l'écran montre qu'il existe, pas seulement une pastille. */
  rapport: string | null;
  produits: string[];
  messages: string[];
  /** Les identifiants, pour rouvrir le rapport tel qu'il a été fait (correction dans les 48 h). */
  produitIds: string[];
  messageIds: string[];
  /** « Ce qu'il reste à faire », tel que saisi. */
  suite: string | null;
  /** Ce que la visite a remis (net) et présenté (§118.166). */
  remises: RemisesDeVisite;
  /** Combien d'heures il reste pour rapporter. 0 = fenêtre fermée. */
  heuresRestantes: number;
  /** Un rapport VOCAL est rattaché. */
  vocal: boolean;
  /** Pourquoi elle n'a pas eu lieu, quand elle est dite reportée ou annulée (§118.193). */
  motifNonTenue: string | null;
  /** LE POTENTIEL À METTRE À JOUR (Segmentation Studio, §18) : présent quand le praticien est dans le panel d'une
   *  stratégie de la BU du KAM — la métrique, le produit #1 et la dernière valeur connue, pour ne rien redemander. */
  potentiel: PotentielAMettreAJour | null;
  /** LE BESOIN ANNUEL DU SERVICE (Marketing cockpit · terrain) : présent quand le praticien est DÉCIDEUR d'une stratégie
   *  active de la BU du KAM — les produits classés et ce qui est déjà saisi pour l'an prochain. */
  besoin: BesoinAEcrire | null;
}

export interface PotentielAMettreAJour {
  metrique: string;
  productId: string | null;
  produit: string | null;
  dernier: { potentiel: number | null; sur10: number | null; le: string } | null;
}

export interface ProduitDeLaGamme {
  /** L'identifiant du produit CANONIQUE — celui que `MedicalVisitProduct` lie. */
  productId: string;
  name: string;
}

export interface MessagePredefini {
  id: string;
  title: string;
  body: string | null;
  /** La gamme qui le porte, ou `null` = ouvert à toutes. */
  buName: string | null;
}

export interface EmploiDuTemps {
  vue: VueTournee;
  debut: Date;
  fin: Date;
  lignes: LigneEmploiDuTemps[];
  /** L'avancement du MOIS courant — la maille que la Direction lit, quelle que soit la vue. */
  avancementDuMois: AvancementTournee;
  /** Les produits de la BU du KAM, admis dans un rapport. */
  produits: ProduitDeLaGamme[];
  /**
   * LES PRODUITS PROMUS DE SA GAMME QUI N'ONT PAS DE PRODUIT CANONIQUE : ils ne peuvent pas
   * figurer dans un rapport. On les NOMME plutôt que de les laisser disparaître de la liste — un
   * KAM qui cherche « Nivolex » et ne le trouve pas croit à une panne (§118.71).
   */
  produitsIncomplets: string[];
  /** Les messages pré-définis qui s'appliquent à lui. */
  messages: MessagePredefini[];
  /** Le KAM a-t-il une BU ? Sans elle, aucun produit n'est admis et le rapport est impossible. */
  sansBu: boolean;
}

/** Le libellé d'un praticien, avec le repli sur son identifiant plutôt qu'un vide. */
const nomPraticien = (d: { name: string } | null): string => d?.name ?? "(praticien retiré)";

export async function loadEmploiDuTemps(
  user: SessionUser,
  vue: VueTournee,
  maintenant: Date = new Date(),
  repId: string = user.id,
): Promise<EmploiDuTemps> {
  const { debut, fin } = fenetreDeVue(vue, maintenant);
  return emploiDuTempsEntre(repId, vue, debut, fin, maintenant);
}

/** Les lignes d'une fenêtre de jours, et l'avancement du MOIS — quelle que soit la fenêtre. */
async function emploiDuTempsEntre(repId: string, vue: VueTournee, debut: Date, fin: Date, maintenant: Date): Promise<EmploiDuTemps> {
  const mois = periodeDe("MONTH", maintenant);
  const [coeur, visitesDuMois] = await Promise.all([
    lignesEtGamme(repId, { delegateId: repId, date: { gte: debut, lte: fin } }, maintenant),
    // L'AVANCEMENT SE LIT SUR LE MOIS, quelle que soit la vue : « Aujourd'hui » ne dit rien d'un
    // objectif mensuel, et afficher le taux du jour ferait lire 0 % chaque matin.
    prisma.medicalVisit.findMany({
      where: { delegateId: repId, date: { gte: mois.debut, lte: mois.fin } },
      select: { status: true, date: true, report: true, tourPlanId: true },
    }),
  ]);

  return {
    vue, debut, fin, ...coeur,
    avancementDuMois: avancementTournee(visitesDuMois.map((v) => ({
      etat: etatVisite({ statut: v.status, date: v.date, rapportFait: Boolean(v.report), maintenant }),
      imprevue: v.tourPlanId === null,
    }))),
  };
}

/**
 * LA LISTE « AUJOURD'HUI » DU DÉLÉGUÉ (11/2026) — l'emploi du temps du jour, ÉLARGI aux deux jours d'avant : une visite
 * d'hier encore dans sa fenêtre de 48 h est un rapport qu'on peut sauver, et la vue « Aujourd'hui » seule le cachait.
 * Le tri (ce qui s'affiche, dans quel ordre) est au module pur `sfe/journee-visite.ts` ; ici, la même lecture que
 * l'emploi du temps (`lignesEtGamme`) et le même avancement du mois.
 */
export async function loadJourneeDuDelegue(user: SessionUser, maintenant: Date = new Date()): Promise<EmploiDuTemps> {
  const aujourdhui = fenetreDeVue("AUJOURD_HUI", maintenant);
  const debut = new Date(aujourdhui.debut.getFullYear(), aujourdhui.debut.getMonth(), aujourdhui.debut.getDate() - 2);
  return emploiDuTempsEntre(user.id, "AUJOURD_HUI", debut, aujourdhui.fin, maintenant);
}

/**
 * LES VISITES D'UN PLAN, LUES COMME L'EMPLOI DU TEMPS LES LIT (Direction, 06/10) — la grille du plan de tournée
 * montre l'état de chaque cellule (à faire, rapport fait, non tenue) et ouvre le MÊME rapport que « Ma journée ».
 * Une seule lecture des lignes (`lignesEtGamme`) : deux écrans qui calculent l'état d'une visite chacun de leur
 * côté finiraient par dire deux choses de la même visite (§118.5).
 */
export async function loadVisitesDuPlan(
  planId: string,
  repId: string,
  maintenant: Date = new Date(),
): Promise<Omit<EmploiDuTemps, "vue" | "debut" | "fin" | "avancementDuMois">> {
  return lignesEtGamme(repId, { tourPlanId: planId }, maintenant);
}

/** Le cœur partagé : les lignes d'un filtre de visites, et la gamme (produits, messages) du KAM qui les rapporte. */
async function lignesEtGamme(
  repId: string,
  filtre: { delegateId: string; date: { gte: Date; lte: Date } } | { tourPlanId: string },
  maintenant: Date,
): Promise<Omit<EmploiDuTemps, "vue" | "debut" | "fin" | "avancementDuMois">> {
  const profil = await prisma.salesRepProfile.findUnique({
    where: { repId },
    select: { businessUnitId: true },
  });

  const [visites, promus, messages] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: filtre,
      orderBy: [{ date: "asc" }],
      select: {
        id: true, date: true, status: true, origin: true, objective: true, report: true, doctorId: true,
        tourPlanId: true, followUpActions: true, notHeldReason: true,
        doctor: { select: { name: true, institution: true, wilaya: true, specialty: true } },
        productLinks: { select: { productId: true, product: { select: { canonicalName: true } } } },
        messageLinks: { select: { messageId: true, message: { select: { title: true } } } },
        fieldReports: { select: { id: true }, take: 1 },
      },
    }),
    profil?.businessUnitId
      ? prisma.promoProduct.findMany({
          where: { businessUnitId: profil.businessUnitId, isActive: true },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { name: true, productId: true },
        })
      : Promise.resolve([] as { name: string; productId: string | null }[]),
    // LES MESSAGES QUI S'APPLIQUENT : ceux de sa gamme, plus ceux qui n'en visent aucune.
    // « Vide = ouvert à tous » est la convention du dépôt (lecteurs d'annuaire, lecteurs Legal).
    prisma.promoMessage.findMany({
      where: {
        isActive: true,
        OR: [{ businessUnitId: null }, ...(profil?.businessUnitId ? [{ businessUnitId: profil.businessUnitId }] : [])],
      },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      select: { id: true, title: true, body: true, businessUnit: { select: { name: true } } },
    }),
  ]);

  // CE QUE CHAQUE VISITE A REMIS — une lecture pour toutes (§118.102b : jamais une par ligne).
  const remises = await remisesDesVisites(visites.map((v) => v.id));
  const potentiels = await potentielsDesPraticiens(visites.map((v) => v.doctorId).filter((x): x is string => !!x), profil?.businessUnitId ?? null);
  const besoins = await besoinsAEcrire(visites.map((v) => v.doctorId).filter((x): x is string => !!x), profil?.businessUnitId ?? null, maintenant);
  const RIEN: RemisesDeVisite = { materiel: [], numeriques: [] };

  const lignes: LigneEmploiDuTemps[] = visites.map((v) => {
    const f = fenetreRapport(v.date, maintenant);
    return {
      id: v.id,
      date: v.date,
      doctorId: v.doctorId,
      doctorName: nomPraticien(v.doctor),
      institution: v.doctor?.institution ?? null,
      wilaya: v.doctor?.wilaya ?? null,
      specialty: v.doctor?.specialty ?? null,
      etat: etatVisite({
        statut: v.status,
        date: v.date,
        rapportFait: Boolean(v.report) || v.fieldReports.length > 0,
        maintenant,
      }),
      origine: String(v.origin),
      objectif: v.objective,
      rapport: v.report,
      produits: v.productLinks.map((l) => l.product.canonicalName),
      messages: v.messageLinks.map((l) => l.message.title),
      produitIds: v.productLinks.map((l) => l.productId),
      messageIds: v.messageLinks.map((l) => l.messageId),
      suite: v.followUpActions,
      remises: remises.get(v.id) ?? RIEN,
      heuresRestantes: f.heuresRestantes,
      vocal: v.fieldReports.length > 0,
      motifNonTenue: v.notHeldReason,
      potentiel: v.doctorId ? potentiels.get(v.doctorId) ?? null : null,
      besoin: v.doctorId ? besoins.get(v.doctorId) ?? null : null,
    };
  });

  return {
    lignes,
    produits: promus
      .filter((p): p is { name: string; productId: string } => Boolean(p.productId))
      .map((p) => ({ productId: p.productId, name: p.name })),
    produitsIncomplets: promus.filter((p) => !p.productId).map((p) => p.name),
    messages: messages.map((m) => ({ id: m.id, title: m.title, body: m.body, buName: m.businessUnit?.name ?? null })),
    sansBu: !profil?.businessUnitId,
  };
}

// ─────────────────────────── L'écran de PLANIFICATION ───────────────────────────

export interface PraticienPlanifiable {
  id: string;
  name: string;
  specialty: string | null;
  institution: string | null;
  wilaya: string | null;
  potential: string | null;
  /**
   * LA LETTRE DE SEGMENTATION (Direction, 07/10 — « la lettre partout ») : H, A–D, NA, non ciblé — stratégie de la BU
   * du KAM d'abord ; null = rangé dans aucune stratégie (l'ancien palier `potential` reste alors le repère).
   */
  lettre: Lettre | null;
  /** Les visites que ce praticien demande par cycle — le requis unique (`requisDuPraticien`). */
  requis: number;
  /** Le secteur commercial qui couvre son établissement, quand il y en a un. */
  secteur: string | null;
}

export interface PlanTourneeVue {
  id: string;
  repId: string;
  repName: string;
  periodStart: Date;
  periodEnd: Date;
  granularity: string;
  status: string;
  submissionDueAt: Date;
  submittedAt: Date | null;
  reviewerName: string | null;
  escalatedToName: string | null;
  /** Les IDENTIFIANTS du validateur et du N+2 : la règle d'accès (`accesAuPlan`) compare des personnes, pas des noms. */
  reviewerId: string | null;
  escalatedToId: string | null;
  rejectionComment: string | null;
  resubmitDueAt: Date | null;
  /** Le retard de soumission, calculé UNE fois ici — l'écran l'affiche, il ne le recalcule pas. */
  retard: RetardDeSoumission;
  /** Les paires déjà planifiées, sous la forme `AAAA-MM-JJ|doctorId` que l'écran renvoie. */
  paires: string[];
  /** Les visites du plan DÉJÀ rapportées : elles ne se déplanifient pas. */
  pairesAcquises: string[];
  /**
   * Les visites PASSÉES d'un plan déjà validé, non rapportées (§118.193) : une révision rouvre l'avenir du plan,
   * pas son passé — elles restent au plan (`retraitInterditApresRevision`, la même règle que l'action).
   */
  pairesPassees: string[];
  /** Parmi les acquises, celles DITES non tenues (reportées, annulées) : l'écran ne les dit pas « rapportées ». */
  pairesNonTenues: string[];
  /** La révision en cours d'un plan validé — son motif, qui l'a demandée, quand. */
  revisionNote: string | null;
  revisionPar: string | null;
  revisionLe: Date | null;
  /** Validé au moins une fois (validé, ou rouvert en révision) : ses visites sont dans l'emploi du temps du KAM,
   *  et la grille du plan ouvre leur rapport (`planDejaValide`, lib/sfe/grille-tournee). */
  dejaValide: boolean;
  avancement: AvancementTournee;
}

/**
 * LE PANEL PLANIFIABLE D'UN KAM — les praticiens qu'il peut mettre dans sa tournée.
 *
 * ── D'OÙ VIENNENT LES MÉDECINS ──────────────────────────────────────────────────────────────
 *
 * De son SECTEUR d'abord : le secteur est une sélection d'établissements, et les praticiens de
 * ces établissements sont son territoire. Plus ceux qui lui sont directement rattachés
 * (`delegateId`) — un praticien libéral n'a pas d'hôpital, et l'oublier viderait le panel de
 * toute une gamme de ville.
 *
 * L'union est VOULUE : borner au seul secteur ferait disparaître les libéraux, borner au seul
 * rattachement ferait disparaître l'hôpital que la Direction vient de lui confier. Les deux
 * sources répondent à la même question, et c'est leur réunion qui est le panel.
 *
 * L'APPARTENANCE se lit dans LA clause du panel (`clausePanelDuKam`, §118.179) — la même que Ma
 * journée, la saisie d'une visite, le cockpit et la porte de la fiche. Ce chargeur ne lit les
 * secteurs que pour NOMMER celui qui amène chaque praticien.
 */
export async function loadPanelPlanifiable(repId: string): Promise<PraticienPlanifiable[]> {
  const secteurs = await prisma.salesSector.findMany({
    where: { isActive: true, reps: { some: { repId } } },
    select: {
      name: true,
      institutions: { select: { institutionId: true, tousLesServices: true, services: { select: { serviceId: true } } } },
    },
  });
  // LA COUVERTURE DU SECTEUR (§118.172) : un établissement entier, ou seulement certains de ses
  // services. Un praticien d'un établissement restreint n'entre dans le panel que par son SERVICE
  // — et un praticien sans service, dans un tel établissement, n'y entre pas : on ne devine pas.
  const liens: (LienCouverture & { secteur: string })[] = secteurs.flatMap((s) => s.institutions.map((i) => ({
    institutionId: i.institutionId, tousLesServices: i.tousLesServices, serviceIds: i.services.map((x) => x.serviceId), secteur: s.name,
  })));

  const praticiens = await prisma.medicalDoctor.findMany({
    where: clausePanelDuKam(repId),
    orderBy: [{ name: "asc" }],
    select: {
      id: true, name: true, specialty: true, institution: true, wilaya: true, potential: true,
      institutionId: true, serviceId: true,
      institutionRef: { select: { wilaya: true } },
    },
  });
  // LA LETTRE ET LE REQUIS de chaque praticien — la segmentation de la BU du KAM d'abord, le palier en repli.
  const [lettres, profil, config] = await Promise.all([
    lettresDesPraticiens(praticiens.map((d) => d.id)),
    prisma.salesRepProfile.findUnique({ where: { repId }, select: { businessUnitId: true } }),
    getSfeConfig(),
  ]);
  const requisDe = (d: (typeof praticiens)[number]) =>
    requisDuPraticien(lettres.get(d.id), profil?.businessUnitId ?? null, d.potential ? String(d.potential) : null, config.frequencyByTier);
  return praticiens.map((d) => ({
    ...(() => { const r = requisDe(d); return { lettre: r.lettre, requis: r.visites }; })(),
    id: d.id, name: d.name, specialty: d.specialty, institution: d.institution,
    // LA WILAYA DE LA FICHE, sinon celle de son ÉTABLISSEMENT (04/10/2026) : le panel d'un KAM vient de
    // ses établissements, et une fiche sans wilaya saisie restait hors du menu « Wilaya où je serai »
    // alors que l'hôpital qui l'amène en a une.
    wilaya: d.wilaya ?? d.institutionRef?.wilaya ?? null, potential: d.potential ? String(d.potential) : null,
    // LE SECTEUR qui l'amène — la MÊME règle que la clause (`lienCouvre`), pour qu'un praticien
    // venu par un service ne soit pas étiqueté du secteur qui ne couvre pas ce service.
    secteur: liens.find((l) => lienCouvre(l, d))?.secteur ?? null,
  }));
}

/**
 * POURQUOI CE PANEL EST VIDE — les faits que lit `diagnosticPanelVide` (04/10/2026).
 *
 * Lus par la MÊME règle que le panel : la BU du KAM (`SalesRepProfile`), ses secteurs (actifs ou non,
 * dans sa BU ou non — `clausePanelDuKam` ne compte que les actifs de SA BU, §118.184), les praticiens
 * rattachés par identifiant aux établissements couverts, et les fiches d'avant le lien dont seul le
 * TEXTE d'établissement porte le nom d'un établissement couvert. Appelé seulement quand le panel est
 * vide : un écran normal ne paie pas ces lectures.
 */
export async function diagnostiquerPanelVide(repId: string): Promise<{ cause: CausePanelVide; phrase: string }> {
  const [profil, affectations] = await Promise.all([
    prisma.salesRepProfile.findUnique({ where: { repId }, select: { businessUnitId: true, region: true, businessUnit: { select: { name: true } } } }),
    prisma.salesSectorRep.findMany({
      where: { repId },
      select: {
        sector: {
          select: {
            name: true, isActive: true, businessUnitId: true, businessUnit: { select: { name: true } },
            institutions: {
              select: { institutionId: true, tousLesServices: true, services: { select: { serviceId: true } }, institution: { select: { name: true } } },
            },
          },
        },
      },
    }),
  ]);
  const buId = profil?.businessUnitId ?? null;
  const secteurs = affectations.map((a) => a.sector);
  const vivants = secteurs.filter((s) => s.isActive && s.businessUnitId === buId);
  const liens = vivants.flatMap((s) => s.institutions);
  const etabIds = [...new Set(liens.map((l) => l.institutionId))];
  const [rattaches, enTexte] = etabIds.length
    ? await Promise.all([
      prisma.medicalDoctor.findMany({ where: { institutionId: { in: etabIds } }, select: { institutionId: true, serviceId: true } }),
      prisma.medicalDoctor.count({
        where: {
          institutionId: null,
          OR: [...new Set(liens.map((l) => l.institution.name))].map((nom) => ({ institution: { equals: nom, mode: "insensitive" as const } })),
        },
      }),
    ])
    : [[] as { institutionId: string | null; serviceId: string | null }[], 0];
  const couvre = (d: { institutionId: string | null; serviceId: string | null }) => liens.some((l) => lienCouvre(
    { institutionId: l.institutionId, tousLesServices: l.tousLesServices, serviceIds: l.services.map((x) => x.serviceId) }, d,
  ));
  return diagnosticPanelVide({
    bu: profil?.businessUnit?.name ?? null,
    secteurTexte: profil?.region ?? null,
    secteurs: secteurs.map((s) => ({
      nom: s.name, bu: s.businessUnit.name, dansSaBu: s.businessUnitId === buId, actif: s.isActive, etablissements: s.institutions.length,
    })),
    praticiensRattaches: rattaches.length,
    horsServicesChoisis: rattaches.filter((d) => !couvre(d)).length,
    praticiensEnTexte: enTexte,
  });
}

/** La clé d'une paire jour × praticien, telle que l'écran l'envoie et que l'action la relit. */
export const clePaire = (d: Date, doctorId: string): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}|${doctorId}`;

/** Un plan, tel que l'écran de planification le rend. */
export async function loadPlanTournee(planId: string, maintenant: Date = new Date()): Promise<PlanTourneeVue | null> {
  const p = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: {
      id: true, repId: true, periodStart: true, periodEnd: true, granularity: true, status: true,
      submissionDueAt: true, submittedAt: true, rejectionComment: true, resubmitDueAt: true,
      reviewerId: true, escalatedToId: true,
      revisionNote: true, revisionRequestedAt: true, revisionRequestedById: true, revisionCount: true,
      rep: { select: { name: true } },
      reviewer: { select: { name: true } },
      escalatedTo: { select: { name: true } },
      visits: { select: { id: true, date: true, doctorId: true, status: true, report: true, tourPlanId: true } },
    },
  });
  if (!p) return null;
  const acquises = p.visits.filter((v) => v.status !== "PLANNED");
  const passees = p.visits.filter((v) => retraitInterditApresRevision(v, p.revisionCount > 0, maintenant));
  // `revisionRequestedById` est un identifiant sans relation (la convention des marques de renvoi, §118.192) :
  // le nom se lit à part, et seulement quand une révision est en cours.
  const revisionPar = p.revisionRequestedById
    ? (await prisma.user.findUnique({ where: { id: p.revisionRequestedById }, select: { name: true } }))?.name ?? null
    : null;
  return {
    id: p.id, repId: p.repId, repName: p.rep.name,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    granularity: String(p.granularity), status: String(p.status),
    submissionDueAt: p.submissionDueAt, submittedAt: p.submittedAt,
    reviewerName: p.reviewer?.name ?? null,
    escalatedToName: p.escalatedTo?.name ?? null,
    reviewerId: p.reviewerId, escalatedToId: p.escalatedToId,
    rejectionComment: p.rejectionComment,
    resubmitDueAt: p.resubmitDueAt,
    retard: retardDeSoumission({
      statut: String(p.status) as StatutPlan, echeance: p.submissionDueAt, resoumissionAvant: p.resubmitDueAt, maintenant,
    }),
    paires: p.visits.filter((v) => v.doctorId).map((v) => clePaire(v.date, v.doctorId!)),
    pairesAcquises: acquises.filter((v) => v.doctorId).map((v) => clePaire(v.date, v.doctorId!)),
    pairesPassees: passees.filter((v) => v.doctorId).map((v) => clePaire(v.date, v.doctorId!)),
    pairesNonTenues: acquises.filter((v) => v.doctorId && (v.status === "CANCELLED" || v.status === "POSTPONED")).map((v) => clePaire(v.date, v.doctorId!)),
    revisionNote: p.revisionNote,
    revisionPar,
    revisionLe: p.revisionRequestedAt,
    dejaValide: planDejaValide(String(p.status) as StatutPlan, p.revisionCount),
    avancement: avancementTournee(p.visits.map((v) => ({
      etat: etatVisite({ statut: v.status, date: v.date, rapportFait: Boolean(v.report), maintenant }),
      imprevue: v.tourPlanId === null,
    }))),
  };
}

// ─────────────────────────── Le tableau de bord de la Direction ───────────────────────────

export interface LigneTourneeDirection {
  repId: string;
  repName: string;
  buName: string | null;
  /** L'état du plan de la période, ou `null` si aucun plan n'existe. */
  statutPlan: string | null;
  /**
   * LE RETARD DE SOUMISSION. Un KAM SANS plan se juge comme un brouillon jamais soumis, sur
   * l'échéance que la période AURAIT eue au réglage du jour : c'est ainsi que la Direction voit
   * qui n'a rien ouvert alors que l'échéance est passée — et non un 0/0 qui se lit « rien à
   * faire ». Un plan SOUMIS n'est jamais en retard (le temps de décision n'est pas le sien).
   */
  retard: RetardDeSoumission;
  avancement: AvancementTournee;
}

export interface TourneeDirection {
  debut: Date;
  fin: Date;
  lignes: LigneTourneeDirection[];
  /** Le total de la portée — la SOMME des lignes, jamais un second calcul. */
  total: AvancementTournee;
  /** Combien de KAM de la portée n'ont AUCUN plan sur la période. */
  sansPlan: number;
  /** Combien de KAM ont un plan ENCORE À SOUMETTRE (ou aucun plan) alors que l'échéance est passée. */
  enRetard: number;
}

/**
 * « VISITÉES / PLANIFIÉES » ET « LE NOMBRE DE VISITES » — ce que la Direction demande.
 *
 * ── LE MÊME CALCUL QUE L'ÉCRAN DU KAM ───────────────────────────────────────────────────────
 *
 * `avancementTournee` est appelée ici et dans `loadEmploiDuTemps` : c'est la même fonction sur
 * les mêmes faits. Deux écrans qui comptent séparément divergent, toujours (§118.51) — et le
 * symptôme serait un KAM à qui l'on reproche un taux que son propre écran ne montre pas. Un test
 * compare les deux.
 *
 * ── CE QUI N'EST PAS LE MÊME « PLANIFIÉ » ───────────────────────────────────────────────────
 *
 * Le cockpit SFE porte déjà un `plannedVisits` : c'est la CAPACITÉ cible d'un KAM (jours × visites
 * par jour × part terrain), une prévision de charge. Ici, « planifiées » désigne les visites
 * NOMMÉES d'un plan de tournée — un praticien, un jour. Les deux nombres sont légitimes et
 * différents ; les afficher côte à côte sans le dire ferait douter des deux, d'où la phrase que
 * l'écran porte.
 *
 * ── LE TOTAL EST LA SOMME DES LIGNES ────────────────────────────────────────────────────────
 *
 * Recalculé à part, il divergerait de ce que la Direction voit ligne par ligne — et c'est le
 * total qu'elle citerait en réunion.
 */
export async function loadTourneeDirection(
  repIds: readonly string[],
  debut: Date,
  fin: Date,
  maintenant: Date = new Date(),
): Promise<TourneeDirection> {
  if (repIds.length === 0) {
    return { debut, fin, lignes: [], total: avancementTournee([]), sansPlan: 0, enRetard: 0 };
  }
  const [visites, plans, kams, reglage] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: { delegateId: { in: [...repIds] }, date: { gte: debut, lte: fin } },
      select: { delegateId: true, status: true, date: true, report: true, tourPlanId: true },
    }),
    prisma.tourPlan.findMany({
      where: { repId: { in: [...repIds] }, periodStart: { lte: fin }, periodEnd: { gte: debut } },
      select: { repId: true, status: true, periodStart: true, submissionDueAt: true, resubmitDueAt: true },
      orderBy: { periodStart: "desc" },
    }),
    prisma.user.findMany({
      where: { id: { in: [...repIds] } },
      select: { id: true, name: true },
    }),
    // LE RÉGLAGE DU JOUR ne sert qu'aux KAM SANS plan : un plan existant porte son échéance
    // figée à la création (§118.107), et c'est elle qu'on juge.
    lireReglageTournee(),
  ]);
  // LA BU DU KAM SE CHARGE À PART : `SalesRepProfile.repId` est un `String` sans relation vers
  // `User` — la convention de tout ce voisinage (`SalesRepMonthlyKpi`, `PromotionAssignment`).
  // On ne l'invente pas ici : ajouter la relation serait une migration de schéma pour une
  // jointure de confort, et l'empreinte dépasserait la demande (§118.16).
  const profils = await prisma.salesRepProfile.findMany({
    where: { repId: { in: [...repIds] } },
    select: { repId: true, businessUnit: { select: { name: true } } },
  });
  const buParRep = new Map(profils.map((p) => [p.repId, p.businessUnit?.name ?? null]));

  const parRep = new Map<string, { etat: EtatVisite; imprevue: boolean }[]>();
  for (const v of visites) {
    if (!v.delegateId) continue;
    const l = parRep.get(v.delegateId) ?? [];
    l.push({
      etat: etatVisite({ statut: v.status, date: v.date, rapportFait: Boolean(v.report), maintenant }),
      imprevue: v.tourPlanId === null,
    });
    parRep.set(v.delegateId, l);
  }
  // LE PLAN LE PLUS RÉCENT qui touche la fenêtre — un par KAM (`orderBy` décroissant, premier gardé).
  const planParRep = new Map<string, (typeof plans)[number]>();
  for (const p of plans) if (!planParRep.has(p.repId)) planParRep.set(p.repId, p);
  // L'ÉCHÉANCE QU'AURAIT EUE LE PLAN MANQUANT : celle de la période, à la maille réglée, qui
  // contient le début de la fenêtre. Sans elle, un KAM sans plan ne serait jamais « en retard »
  // — il n'aurait simplement rien, et rien ne se lit comme rien à faire.
  const echeanceSansPlan = echeanceDeSoumission(periodeDe(reglage.granularite, debut).debut, reglage.joursAvant);

  const lignes: LigneTourneeDirection[] = kams
    .map((k) => {
      const plan = planParRep.get(k.id) ?? null;
      return {
        repId: k.id,
        repName: k.name,
        buName: buParRep.get(k.id) ?? null,
        statutPlan: plan ? String(plan.status) : null,
        retard: plan
          ? retardDeSoumission({
            statut: String(plan.status) as StatutPlan, echeance: plan.submissionDueAt, resoumissionAvant: plan.resubmitDueAt, maintenant,
          })
          : retardDeSoumission({ statut: "DRAFT", echeance: echeanceSansPlan, maintenant }),
        avancement: avancementTournee(parRep.get(k.id) ?? []),
      };
    })
    .sort((a, b) => (a.buName ?? "").localeCompare(b.buName ?? "", "fr") || a.repName.localeCompare(b.repName, "fr"));

  // LE TOTAL EST LA SOMME DES LIGNES — recalculé à part, il divergerait de ce que la Direction
  // lit ligne par ligne, et c'est le total qu'elle citerait en réunion (§118.51).
  const total = lignes.reduce<AvancementTournee>((acc, l) => ({
    planifiees: acc.planifiees + l.avancement.planifiees,
    visitees: acc.visitees + l.avancement.visitees,
    perdues: acc.perdues + l.avancement.perdues,
    aFaire: acc.aFaire + l.avancement.aFaire,
    ecartees: acc.ecartees + l.avancement.ecartees,
    imprevues: acc.imprevues + l.avancement.imprevues,
    visitesTotales: acc.visitesTotales + l.avancement.visitesTotales,
    tauxRealisation: 0,
  }), avancementTournee([]));
  // LE TAUX SE RECALCULE SUR LES TOTAUX, jamais comme une moyenne des taux : la moyenne
  // donnerait le même poids à un KAM de 4 visites et à un KAM de 40.
  total.tauxRealisation = total.planifiees > 0 ? Math.round((total.visitees / total.planifiees) * 100) : 0;

  return {
    debut, fin, lignes, total,
    sansPlan: lignes.filter((l) => l.statutPlan === null).length,
    enRetard: lignes.filter((l) => l.retard.enRetard).length,
  };
}

/**
 * CE QUE LA SEGMENTATION SAIT DÉJÀ de chaque praticien de la tournée — une lecture pour toutes. Seuls les praticiens
 * du panel d'une stratégie ACTIVE de la BU du KAM ont un potentiel à mettre à jour.
 */
async function potentielsDesPraticiens(doctorIds: string[], businessUnitId: string | null): Promise<Map<string, PotentielAMettreAJour>> {
  const out = new Map<string, PotentielAMettreAJour>();
  if (!businessUnitId || doctorIds.length === 0) return out;
  const fiches = await prisma.segmentationFiche.findMany({
    where: { doctorId: { in: doctorIds }, retireeLe: null, strategie: { statut: "ACTIVE", businessUnitId } },
    select: {
      doctorId: true,
      strategie: { select: {
        produits: { where: { jusqua: null, rang: 1 }, select: { productId: true, product: { select: { canonicalName: true } } } },
        regles: { orderBy: { version: "desc" }, take: 1, select: { contenu: true } },
      } },
    },
  });
  const obs = await prisma.hcpObservation.findMany({
    where: { doctorId: { in: [...new Set(fiches.map((f) => f.doctorId))] } },
    orderBy: { observeLe: "desc" }, select: { doctorId: true, potentiel: true, prescriptionsSur10: true, observeLe: true },
  });
  for (const f of fiches) {
    if (out.has(f.doctorId)) continue;
    const p1 = f.strategie.produits[0];
    const contenu = (f.strategie.regles[0]?.contenu ?? {}) as { produits?: { metrique?: unknown }[] };
    const metrique = typeof contenu.produits?.[0]?.metrique === "string" ? contenu.produits[0].metrique as string : "patients / semaine";
    const o = obs.find((x) => x.doctorId === f.doctorId);
    out.set(f.doctorId, {
      metrique, productId: p1?.productId ?? null, produit: p1?.product.canonicalName ?? null,
      dernier: o ? { potentiel: o.potentiel === null ? null : Number(o.potentiel), sur10: o.prescriptionsSur10 === null ? null : Number(o.prescriptionsSur10), le: o.observeLe.toISOString() } : null,
    });
  }
  return out;
}
