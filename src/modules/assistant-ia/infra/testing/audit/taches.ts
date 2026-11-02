/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — L'UTILISATEUR EXIGEANT : ≥ 60 tâches réelles, par persona.
 *
 * « Quand tu lui demandes de faire des actions, il faut qu'il soit capable de les faire, qu'il ne pose pas trop de
 * questions — pas tellement de questions pour faire un mail. Et les mails doivent être beaux. » (Direction, 02/11)
 *
 * Chaque tâche mesure : la RÉUSSITE (la bonne carte, ses champs justes, l'objet créé en base APRÈS le clic
 * « Confirmer » simulé, le fichier produit), le NOMBRE DE QUESTIONS avant la carte (cible 0 ; au plus 1 quand une
 * information bloquante manque — `questionsMax`), la vérité (« c'est fait » jamais dit sans outil réussi), la beauté
 * d'un mail (grille déterministe + juge bon marché), la latence et le coût.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from "@prisma/client";
import { nomComplet, type PersonaCle } from "./personas";
import type { SemisAudit } from "./semis";
import { TACHES_ANNUAIRE_MARKETING } from "./taches/annuaire-marketing";

export const CATEGORIES_TACHE = [
  "tache", "message", "mail", "adpro", "bc", "export", "analyse", "recherche", "note", "mission", "pilotage", "annulation", "soi",
  // Lot T2 (décision 0051) : tenir les annuaires, analyser le marketing, interroger le terrain.
  "annuaire", "marketing", "terrain",
] as const;
export type CategorieTache = (typeof CATEGORIES_TACHE)[number];

/** L'objet attendu en base (compté avant / après) — après le clic « Confirmer » quand une carte est attendue. */
export type ObjetAttendu =
  | "tache" | "message" | "mail" | "sponsoring" | "prise_en_charge" | "materiel_promo" | "validation" | "note" | "mission" | "routine" | "fichier" | "memoire" | "rendez_vous";

/**
 * LA PREUVE EN BASE (lot T2, décision 0051) — ce que le vérificateur d'une tâche reçoit : la base (passée par le
 * banc, le catalogue n'importe pas Prisma), le semis, le début du tour, le compte joué, et ce que l'assistant a rendu
 * (texte, blocs, champs de carte, fichiers produits) pour les tâches de lecture. Le vérificateur rend ses MOTIFS
 * d'échec (vide = le résultat existe vraiment).
 */
export interface ContexteVerif {
  db: PrismaClient;
  s: SemisAudit;
  t0: Date;
  userId: string;
  texte: string;
  blocs: string;
  fichiers: { nom: string; texte: string }[];
}

export interface Tache {
  id: string;
  categorie: CategorieTache;
  persona: PersonaCle;
  tours: string[];
  /** La réponse que la persona donne si l'assistant lui pose une question (comptée). */
  precision?: string;
  /** Le message est DIT (délégation vocale) au lieu d'être écrit. */
  voix?: boolean;
  /** Une pièce du semis jointe au premier message (« devis »), ou un fichier du Drive de la persona, par son nom. */
  piece?: "devis" | { nom: string };
  /** Lot T2 : remettre les fiches de la tâche dans leur état initial avant de la jouer (le banc se rejoue). */
  preparer?: (c: ContexteVerif) => Promise<void>;
  /** Lot T2 : la preuve DÉTERMINISTE en base, après le clic « Confirmer » et les tours d'après. */
  verifier?: (c: ContexteVerif) => Promise<string[]>;
  /** Lot T2 : des tours joués APRÈS la confirmation (« annule cette mise à jour ») — leur carte est confirmée aussi. */
  apresConfirmation?: string[];
  attendu: {
    /** La carte attendue (titre ou genre) — absente : une réponse seule (lecture, analyse). */
    carte?: RegExp;
    /** Des champs de la carte : [libellé, valeur attendue]. */
    champs?: [RegExp, RegExp][];
    /** Des champs qui ne doivent PAS porter cette valeur (inversion fournisseur / client). */
    champsInterdits?: [RegExp, RegExp][];
    objet?: ObjetAttendu;
    /** Le banc ne clique pas « Confirmer » (la carte suffit, ou l'objet naît sans carte). */
    sansConfirmer?: boolean;
    /** Un fichier produit pendant le tour (nom ou type). */
    fichier?: RegExp;
    contient?: RegExp[];
    interdit?: RegExp[];
    mail?: { tableau?: boolean };
    questionsMax?: number;
    /** Le nombre d'un objet ne doit PAS augmenter (une fusion qui crée une troisième mission). */
    pasPlusDe?: ObjetAttendu;
  };
}

const t = (id: string, categorie: CategorieTache, persona: PersonaCle, tours: string | string[], attendu: Tache["attendu"], o: Partial<Tache> = {}): Tache => ({
  id, categorie, persona, tours: Array.isArray(tours) ? tours : [tours], attendu, ...o,
});

const RADIA = nomComplet("commercial");
const YANIS = nomComplet("delegue");
const NADIR = nomComplet("manager");
const CARTE_TACHE = /t[âa]che/i;
const CARTE_MESSAGE = /message|r[ée]ponse/i;
// P1 : la carte s'intitule « Envoyer par l'envoi de l'ERP ».
const CARTE_MAIL = /mail|courri|message|envoi/i;

export const TACHES: Tache[] = [
  // ── Tâches ──
  t("TA-01-commercial", "tache", "commercial", "Crée-moi une tâche : relancer la pharmacie centrale de Blida pour la commande de Daclavir, pour vendredi.", { carte: CARTE_TACHE, champs: [[/titre|t[âa]che|objet/i, /Blida|relanc/i]], objet: "tache" }),
  t("TA-02-delegue", "tache", "delegue", "Ajoute une tâche pour demain : déposer les échantillons chez le Dr Mansouri à Constantine.", { carte: CARTE_TACHE, objet: "tache" }),
  t("TA-03-manager-assigne", "tache", "manager", `Crée une tâche pour ${RADIA} : préparer le bilan des ventes du trimestre, échéance le 15 novembre.`, { carte: CARTE_TACHE, champs: [[/assign|respons|pour|attribu/i, /Radia/i]], objet: "tache" }),
  t("TA-04-assistante", "tache", "assistante", "Note-moi une tâche haute priorité : réserver la salle du conseil pour le comité de direction de jeudi.", { carte: CARTE_TACHE, objet: "tache" }),
  t("TA-05-kam", "tache", "kam", "Rappelle-moi lundi d'appeler le CHU Mustapha pour l'appel d'offres oncologie.", { carte: CARTE_TACHE, objet: "tache" }),
  t("TA-06-regulatory", "tache", "regulatory", "Crée une tâche : déposer la variation du dossier Nivolumab à l'ANPP avant le 30 novembre.", { carte: CARTE_TACHE, objet: "tache" }),

  // ── Messages internes ──
  t("ME-01-commercial", "message", "commercial", `Envoie un message à ${NADIR} : « La commande de Blida est confirmée, 1 200 boîtes. »`, { carte: CARTE_MESSAGE, champs: [[/destinataire|à|pour/i, /Nadir/i]], objet: "message" }),
  t("ME-02-delegue", "message", "delegue", `Dis à ${RADIA} par message que le Dr Mansouri attend sa visite mardi.`, { carte: CARTE_MESSAGE, objet: "message" }),
  t("ME-03-manager", "message", "manager", `Écris à ${YANIS} : félicitations pour les résultats d'octobre, on en parle lundi.`, { carte: CARTE_MESSAGE, objet: "message" }),
  t("ME-04-finance", "message", "finance", `Envoie un message à ${NADIR} pour lui demander les notes de frais d'octobre avant vendredi.`, { carte: CARTE_MESSAGE, objet: "message" }),
  t("ME-05-assistante", "message", "assistante", `Préviens ${nomComplet("superadmin")} par message que le comité est déplacé à 15 h.`, { carte: CARTE_MESSAGE, objet: "message" }),

  // ── Mails (beaux, sans questions) ──
  t("ML-01-commercial-relance", "mail", "commercial", "Fais un mail à achats@pharmacie-blida.dz pour relancer leur commande de Daclavir en attente depuis deux semaines.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-02-delegue-planning", "mail", "delegue", "Envoie un mail à dr.mansouri@chu-constantine.dz avec mon planning de visites de la semaine prochaine : lundi Constantine, mardi Sétif, mercredi Batna, jeudi Annaba. Mets-le en tableau.", { carte: CARTE_MAIL, mail: { tableau: true }, objet: "mail", sansConfirmer: true }),
  t("ML-03-manager-equipe", "mail", "manager", `Envoie un mail à ${RADIA} et ${YANIS} pour annoncer la réunion d'équipe de lundi 9 h, ordre du jour : objectifs Q4, tournées, échantillons.`, { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-04-assistante-invitation", "mail", "assistante", "Fais un mail d'invitation au comité de direction du 12 novembre à 10 h en salle du conseil, pour toute la direction. Joins le planning de la journée en tableau : 10 h accueil, 10 h 30 budget 2027, 12 h déjeuner, 14 h projets.", { carte: CARTE_MAIL, mail: { tableau: true }, objet: "mail", sansConfirmer: true }),
  t("ML-05-kam-offre", "mail", "kam", "Écris un mail à pharmacie@chu-mustapha.dz pour proposer un rendez-vous de présentation de notre gamme oncologie la semaine prochaine.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-06-regulatory-anpp", "mail", "regulatory", "Fais un mail à enregistrement@anpp.dz pour demander où en est l'instruction du dossier Nivolumab déposé le 3 septembre.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-07-finance-fournisseur", "mail", "finance", "Envoie un mail à compta@imprimerie-atlas.dz pour leur dire que la facture FA-2026-1187 sera réglée le 30 novembre.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-08-rh-rappel", "mail", "rh", "Fais un mail à toute l'équipe commerciale pour rappeler que les demandes de congés de fin d'année sont à déposer avant le 20 novembre.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true, questionsMax: 1 }, { precision: `${RADIA}, ${YANIS} et ${NADIR}.` }),
  t("ML-09-superadmin-remerciement", "mail", "superadmin", "Envoie un mail de remerciement à contact@sahge.dz pour l'organisation du congrès d'hépatologie, au nom d'Adventum Pharma.", { carte: CARTE_MAIL, mail: {}, objet: "mail", sansConfirmer: true }),
  t("ML-10-voix-mail", "mail", "commercial", "Fais un mail à achats@pharmacie-blida.dz pour confirmer la livraison de jeudi.", { carte: CARTE_MAIL, mail: {}, sansConfirmer: true }, { voix: true }),

  // ── Ad & Pro : sponsoring, prise en charge, matériel promo ──
  t("AP-01-sponsoring", "adpro", "kam", "Crée une demande de sponsoring pour le congrès de la SAHGE à Oran le 5 décembre, 600 000 DZD.", { carte: /sponsoring/i, objet: "sponsoring", sansConfirmer: true, questionsMax: 1 }, { precision: "Produit Daclavir, BU Hépatologie, stand de 9 m²." }),
  t("AP-02-prise-en-charge", "adpro", "delegue", "Fais une demande de prise en charge du Dr Mansouri au congrès national d'hépatologie à Alger les 5 et 6 décembre.", { carte: /prise en charge|congr/i, sansConfirmer: true, questionsMax: 1 }, { precision: "Transport et hébergement, deux nuits, environ 90 000 DZD." }),
  t("AP-03-materiel-promo", "adpro", "delegue", "Demande du matériel promotionnel : 200 brochures Daclavir et 50 stylos pour ma tournée de l'Est.", { carte: /mat[ée]riel/i, sansConfirmer: true, questionsMax: 1 }, { precision: "Livraison à Constantine pour le 20 novembre." }),
  t("AP-04-autre", "adpro", "kam", "Crée une demande Ad & Pro « autre » : location d'un stand au salon pharmaceutique d'Alger, 350 000 DZD.", { carte: /autre|demande/i, sansConfirmer: true }),
  t("AP-05-evenement", "adpro", "kam", "Organise un événement : soirée scientifique oncologie à l'hôtel Sheraton d'Alger le 28 novembre, 40 médecins.", { carte: /[ée]v[ée]nement|soir[ée]e/i, sansConfirmer: true, questionsMax: 1 }, { precision: "Budget 900 000 DZD, BU Oncologie." }),

  // ── BC depuis un devis (avec PDF) — l'incident : fournisseur / client inversés, lignes dupliquées ──
  t("BC-01-devis", "bc", "assistante", "Fais le bon de commande à partir de ce devis.", {
    carte: /bon de commande/i,
    champs: [[/fournisseur/i, /Atlas/i]],
    champsInterdits: [[/fournisseur/i, /Adventum/i]],
    contient: [/Brochures/i, /Kak[ée]mono/i], interdit: [/Brochures[\s\S]*Brochures[\s\S]*Brochures/i],
    objet: "validation", sansConfirmer: true,
  }, { piece: "devis" }),
  t("BC-02-devis-kam", "bc", "kam", "Prépare le BC de ce devis, imputé au budget Marketing.", { carte: /bon de commande/i, champs: [[/fournisseur/i, /Atlas/i]], champsInterdits: [[/fournisseur/i, /Adventum/i]], sansConfirmer: true }, { piece: "devis" }),
  t("BC-03-bc-simple", "bc", "kam", "Fais un bon de commande à l'Imprimerie Atlas : 500 kakémonos à 2 000 DZD pièce.", { carte: /bon de commande/i, sansConfirmer: true, questionsMax: 1 }, { precision: "Budget Marketing, livraison au siège." }),

  // ── Exports ──
  t("EX-01-taches", "export", "commercial", "Exporte-moi mes tâches en Excel.", { fichier: /xlsx|sheet|excel/i, objet: "fichier", sansConfirmer: true }),
  t("EX-02-demandes", "export", "kam", "Exporte mes demandes Ad & Pro de l'année en Excel.", { fichier: /xlsx|sheet|excel|csv/i, sansConfirmer: true }),
  t("EX-03-rh-paie", "export", "rh", "Exporte la liste des salariés avec leur salaire de base en Excel.", { fichier: /xlsx|sheet|excel|csv/i, sansConfirmer: true }),
  t("EX-04-regulatory", "export", "regulatory", "Exporte le suivi Regulatory en Excel.", { fichier: /xlsx|sheet|excel/i, sansConfirmer: true }),

  // ── Analyses chiffrées ──
  t("AN-01-adpro", "analyse", "kam", "Combien de demandes Ad & Pro ai-je faites cette année, et pour quel montant total ?", { contient: [/\d/] }),
  t("AN-02-rh-masse", "analyse", "rh", "Quelle est la masse salariale du mois dernier ?", { contient: [/\d{3}/] }),
  t("AN-03-finance", "analyse", "finance", "Fais-moi le point des budgets : consommé et reste par enveloppe.", { contient: [/\d/] }),
  t("AN-04-manager", "analyse", "manager", "Combien de tâches mon équipe a-t-elle en retard ?", { contient: [/\d/] }),
  t("AN-05-sa", "analyse", "superadmin", "Donne-moi la masse salariale de la société et le salaire moyen.", { contient: [/\d{3}/] }),

  // ── Recherches ──
  t("RE-01-annuaire", "recherche", "commercial", `Qui est le manager de ${YANIS}, et quel est son poste ?`, { contient: [/Nadir|BELKACEM/i] }),
  t("RE-02-document", "recherche", "superadmin", "Retrouve le document qui parle de la rupture de la chaîne du froid à Ouargla.", { contient: [/Ouargla/i] }),
  t("RE-03-regulatory", "recherche", "regulatory", "Où en est le dossier réglementaire du Nivolumab ?", { contient: [/Nivolumab/i] }),
  t("RE-04-validations", "recherche", "superadmin", "Quelles demandes attendent ma validation ?", { contient: [/VAL-AUDIT-001|validation/i] }),
  t("RE-05-web", "recherche", "kam", "Cherche sur le web les dates du prochain congrès de la SAHGE.", { contient: [/SAHGE|congr/i] }),

  // ── Notes ──
  // Une note se PROPOSE (carte de notes, acceptée par la personne) : la proposition en base est l'objet attendu.
  t("NO-01-ajouter", "note", "commercial", "Note dans mes notes : rappeler le Dr Benali jeudi pour l'essai clinique.", { objet: "note", sansConfirmer: true }),
  t("NO-02-liste", "note", "delegue", "Ajoute à ma liste de courses de tournée : échantillons Daclavir, brochures, stylos.", { objet: "note", sansConfirmer: true }),
  t("NO-03-lire", "note", "regulatory", "Qu'est-ce que j'ai noté dans mes notes ?", { contient: [/QZ-NOTE-MER-3729|Consignes|note/i] }),

  // ── Missions en arrière-plan ──
  t("MI-01-lancer", "mission", "kam", "Lance en arrière-plan une analyse de toutes mes demandes Ad & Pro de l'année avec un rapport Word.", { objet: "mission", sansConfirmer: true }),
  t("MI-02-lancer-sa", "mission", "superadmin", "Prépare en tâche de fond un rapport sur les dossiers réglementaires en retard.", { objet: "mission", sansConfirmer: true }),
  t("MI-03-routine", "mission", "assistante", "Programme chaque lundi à 8 h un récapitulatif de mes tâches de la semaine.", { carte: /routine/i, objet: "routine" }),

  // ── Piloter ses missions : lister, fusionner, arrêter ──
  t("PI-01-lister", "pilotage", "kam", "Liste mes missions en cours.", { contient: [/QZ-MISSION-SOF-2638|mission/i] }),
  t("PI-02-fusionner", "pilotage", "kam", "Fusionne mes deux missions en cours en une seule.", { pasPlusDe: "mission", interdit: [] }),
  t("PI-03-arreter", "pilotage", "kam", "Arrête la mission « Veille concurrentielle oncologie ».", { pasPlusDe: "mission" }),
  t("PI-04-lister-sa", "pilotage", "superadmin", "Où en sont mes missions ?", { contient: [/mission/i] }),
  t("PI-05-pause", "pilotage", "manager", "Mets en pause ma mission en cours.", { pasPlusDe: "mission" }),

  // ── Annuler une action ──
  t("AN-ANNULER-01", "annulation", "commercial", ["Crée une tâche : appeler le grossiste de Médéa demain.", "Finalement non, annule."], { pasPlusDe: "tache", sansConfirmer: true }),
  t("AN-ANNULER-02", "annulation", "delegue", ["Envoie un message à Radia KEBIR : je serai en retard demain.", "Laisse tomber, n'envoie rien."], { pasPlusDe: "message", sansConfirmer: true }),
  t("AN-ANNULER-03", "annulation", "kam", ["Crée une demande Ad & Pro « autre » : 20 cartes de visite, 8 000 DZD.", "Annule cette demande."], { pasPlusDe: "validation", sansConfirmer: true }),

  // ── Soi : son propre salaire, sa fiche ──
  t("SO-01-mon-salaire", "soi", "commercial", "Quel est mon salaire ?", { contient: [/147[\s  .]?351|113[\s  .]?829/] }),
  t("SO-02-mon-net", "soi", "delegue", "Combien je touche net par mois ?", { contient: [/79[\s  .]?413/] }),
  t("SO-03-mon-iban", "soi", "kam", "Quel IBAN est enregistré sur ma fiche ?", { contient: [/0000\s?2638|DZ58/i] }),
  t("SO-04-mes-conges", "soi", "assistante", "Combien de jours de congé me reste-t-il ?", { contient: [/\d/] }),
  t("SO-05-mon-contrat", "soi", "regulatory", "Quand a commencé mon contrat, et c'est quel type de contrat ?", { contient: [/CDI|contrat/i] }),
  t("SO-06-rh-salaire-autrui", "soi", "rh", `Quel est le salaire de base de ${RADIA} ?`, { contient: [/147[\s  .]?351/] }),
  t("SO-07-sa-salaire", "soi", "superadmin", `Quel est le salaire d'${nomComplet("victime")} ?`, { contient: [/173[\s  .]?457|131[\s  .]?869|204[\s  .]?679/] }),

  // ── Rendez-vous ──
  t("RV-01-rdv", "tache", "kam", "Mets-moi un rendez-vous jeudi à 10 h avec le pharmacien chef du CHU Mustapha.", { carte: /rendez-vous|agenda|r[ée]union/i, objet: "rendez_vous" }),

  // ── Lot T2 : annuaires, marketing, terrain (décision 0051) ──
  ...TACHES_ANNUAIRE_MARKETING,
];
