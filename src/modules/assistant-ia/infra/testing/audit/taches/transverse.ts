/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — DOMAINE « transverse » (lot Q1, 02/11) : ce que les lots de domaine ne couvrent pas.
 *
 * « Je veux qu'on augmente bien les tâches réussies et qu'elles soient de tout tout genre ! (…) beaucoup plus de fond,
 * profond et diversifié » (Direction, 02/11). Ici : RH côté salarié (congés, notes de frais, attestations), finances
 * selon les droits, congrès et événements, réglementaire, routines et rappels, notes, enchaînements inter-modules
 * (« trouve le devis, crée le poste, le BC, envoie-le »), questions précises sur l'ERP, conversation longue avec reprise,
 * voix. Identifiants : TR-.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { nomComplet } from "../personas";
import { demandeAdProAutre, deposerPiece, dossierDrive, pdf } from "./aides";
import { tache as t, type SemisDeDomaine, type Tache } from "./types";

const CARTE_CONGE = /cong[ée]|absence/i;
const CARTE_RH = /attestation|demande|document|rh/i;
const RADIA = nomComplet("commercial");

export const TACHES_TRANSVERSE: Tache[] = [
  // ── RH côté salarié ──
  t("TR-RH-01-conge", "rh", "commercial", "Pose-moi un congé annuel du 21 au 31 décembre.", { carte: CARTE_CONGE, objet: "conge" }),
  t("TR-RH-02-conge-maladie", "rh", "delegue", "Je suis malade, mets-moi en absence maladie demain et après-demain.", { carte: CARTE_CONGE, objet: "conge", questionsMax: 1 }, { precision: "Oui, avec certificat médical, je le déposerai." }),
  t("TR-RH-03-solde", "rh", "kam", "Combien de jours de congé il me reste, et est-ce que j'ai une demande en attente ?", { contient: [/\d/] }),
  t("TR-RH-04-attestation", "rh", "regulatory", "J'ai besoin d'une attestation de travail pour la banque.", { carte: CARTE_RH, objet: "demande_rh" }),
  t("TR-RH-05-note-frais", "rh", "delegue", "Fais ma note de frais avec ce ticket de restaurant de la tournée de Sétif.", { carte: /frais|note|d[ée]pense|remboursement/i, questionsMax: 1, sansConfirmer: true }, { piece: "tr_ticket_resto", precision: "Repas avec le Dr Mansouri, tournée de Sétif." }),
  t("TR-RH-06-avance", "rh", "commercial", "Je voudrais demander une avance sur salaire de 30 000 DZD.", { carte: /avance/i, sansConfirmer: true }),
  t("TR-RH-07-rh-conges-equipe", "rh", "rh", `Qui est en congé la semaine prochaine dans l'équipe commerciale ?`, { contient: [/cong|personne|aucun/i] }),
  t("TR-RH-08-manager-valider", "rh", "manager", `Quelles demandes de congé de mon équipe attendent ma décision ?`, { contient: [/cong|aucune|demande/i] }),

  // ── Finances selon les droits ──
  t("TR-FI-01-paiements", "finances", "finance", "Quelles demandes de paiement sont en attente, et pour quel total ?", { contient: [/\d|aucune/i] }),
  t("TR-FI-02-budget", "finances", "finance", "Quel est le reste disponible sur les enveloppes budgétaires de l'année ?", { contient: [/\d/] }),
  t("TR-FI-03-refus-commercial", "finances", "commercial", "Montre-moi les ordres du centre de paiement de ce mois.", { interdit: [/ordre n°|PAY-\d/i], contient: [/droit|acc[eè]s|ouvert|r[ée]serv|pas|aucun/i] }),
  t("TR-FI-04-export", "finances", "finance", "Exporte les demandes de paiement en Excel.", { fichier: /xlsx|sheet|excel/i, sansConfirmer: true }),

  // ── Congrès et événements ──
  t("TR-EV-01-congres", "congres", "marketing", "Inscris le Dr Mansouri au congrès national d'hépatologie d'Alger les 5 et 6 décembre, prise en charge transport et hôtel.", { carte: /congr|prise en charge/i, questionsMax: 1, sansConfirmer: true }, { precision: "Initiative du laboratoire, budget 120 000 DZD, BU Hépatologie." }),
  t("TR-EV-02-evenement", "congres", "marketing", "Crée l'événement « Journée Hépatologie Oran » le 20 novembre, 60 médecins, salle de l'hôtel Méridien.", { carte: /[ée]v[ée]nement|journ[ée]e/i, questionsMax: 1, sansConfirmer: true }, { precision: "Budget 1 200 000 DZD, BU Hépatologie, responsable moi." }),
  t("TR-EV-03-liste", "congres", "marketing", "Quels congrès et événements sont prévus d'ici la fin de l'année ?", { contient: [/congr|[ée]v[ée]nement|aucun/i] }),

  // ── Réglementaire ──
  t("TR-REG-01-etat", "reglementaire", "regulatory", "Quels dossiers réglementaires sont en retard ou bloqués ?", { contient: [/dossier|aucun/i] }),
  t("TR-REG-02-tache", "reglementaire", "regulatory", "Crée une tâche pour relancer l'ANPP sur la variation du Nivolumab, échéance vendredi.", { carte: /t[âa]che/i, objet: "tache" }),
  t("TR-REG-03-cadre", "reglementaire", "regulatory", "Quel est le délai réglementaire de réponse de l'ANPP pour une variation de type II ?", { contient: [/jour|mois|d[ée]lai/i] }),

  // ── Routines et rappels ──
  t("TR-RO-01-routine", "routines", "manager", "Chaque vendredi à 16 h, envoie-moi le point des tâches en retard de mon équipe.", { carte: /routine/i, objet: "routine" }),
  t("TR-RO-02-rappel", "routines", "assistante", "Rappelle-moi demain à 9 h de confirmer la salle du comité.", { carte: /routine|rappel|t[âa]che/i }),
  t("TR-RO-03-lister", "routines", "manager", "Quelles routines j'ai programmées ?", { contient: [/routine|aucune/i] }),

  // ── Notes ──
  t("TR-NO-01-liste", "notes", "kam", "Crée une page de notes « Appel d'offres CHU » avec trois points : cahier des charges, prix, échantillons.", { objet: "note", sansConfirmer: true }),
  t("TR-NO-02-cocher", "notes", "commercial", "Dans mes notes, coche « entretien personnel » comme fait.", { objet: "note", sansConfirmer: true }),

  // ── Enchaînements inter-modules ──
  t("TR-MU-01-devis-bc-envoi", "multi-etapes", "assistante", "Trouve le devis de l'Imprimerie Atlas dans mon Drive, fais le BC et prépare son envoi en validation.", { carte: /bon de commande|BC|validation/i, sansConfirmer: true }),
  t("TR-MU-02-tache-message", "multi-etapes", "manager", `Crée une tâche pour ${RADIA} « bilan Blida » pour lundi et préviens-la par message.`, { carte: /t[âa]che|message/i }),
  t("TR-MU-03-doc-mail", "multi-etapes", "regulatory", "Résume le compte rendu de visite ANPP joint et prépare un mail au pharmacien responsable avec les actions.", { carte: /mail|courri|envoi/i, mail: {}, sansConfirmer: true }, { piece: "tr_cr_anpp" }),
  t("TR-MU-04-analyse-export", "multi-etapes", "kam", "Analyse mes demandes Ad & Pro par statut et exporte le tableau en Excel.", { fichier: /xlsx|sheet|excel/i, sansConfirmer: true }),

  // ── Questions précises sur l'ERP ──
  t("TR-Q-01-circuit", "questions", "kam", "Par qui passe une demande de sponsoring avant d'être validée ?", { contient: [/N\+1|direct|valid/i] }),
  t("TR-Q-02-qui-valide", "questions", "commercial", "Qui doit valider mes congés ?", { contient: [/Nadir|BELKACEM|manager|N\+1/i] }),
  t("TR-Q-03-ou-ecran", "questions", "delegue", "Où dans l'ERP je déclare mes visites médicales ?", { contient: [/\//] }),
  t("TR-Q-04-annuaire", "questions", "assistante", "Quel est le poste de Lamia CHERIF et qui est son responsable ?", { contient: [/juriste/i] }),
  t("TR-Q-05-produit", "questions", "marketing", "Quels produits de la gamme Hépatologie avons-nous au catalogue ?", { contient: [/\w/] }),

  // ── Conversation longue avec reprise ──
  t("TR-LO-01-reprise", "conversation", "kam", [
    "Je prépare l'appel d'offres oncologie du CHU Mustapha.",
    "Crée-moi une tâche pour envoyer les échantillons avant le 15.",
    "Et ajoute une deuxième tâche : relancer le pharmacien chef le 20.",
    "Rappelle-moi ce qu'on vient de préparer pour cet appel d'offres.",
  ], { contient: [/chantillon/i, /pharmacien|relanc/i] }),
  t("TR-LO-02-correction", "conversation", "commercial", ["Crée une tâche : appeler le grossiste de Médéa jeudi.", "Non, vendredi plutôt."], { carte: /t[âa]che/i, champs: [[/[ée]ch[ée]ance|date/i, /vendredi|\d{4}-\d{2}-\d{2}/i]], sansConfirmer: true }),

  // ── Cas limites et reprises après erreur (demande du parent, 02/11) ──
  t("TR-ER-01-date-impossible", "reprise", "commercial", ["Crée une tâche « inventaire du stock Blida » pour le 31 février.", "Pardon, le 28 février."], {
    carte: /t[âa]che/i, champs: [[/[ée]ch[ée]ance|date/i, /-02-28|28 f[ée]vr/i]], sansConfirmer: true,
  }),
  t("TR-ER-02-destinataire-inconnu", "reprise", "delegue", "Envoie un message à Zinedine FANTOME : la livraison arrive jeudi.", {
    pasPlusDe: "message", contient: [/introuvable|aucun|pas trouv|annuaire|n'existe|inconnu/i],
  }),
  t("TR-ER-03-montant-en-lettres", "reprise", "kam", "Crée une demande Ad & Pro « autre » : 500 cartes de visite, quinze mille dinars.", {
    carte: /autre|demande/i, champs: [[/montant/i, /15[\s  .]?000/]], sansConfirmer: true,
  }),
  t("TR-ER-04-change-d-avis", "reprise", "commercial", ["Fais un mail à achats@pharmacie-blida.dz pour la livraison de jeudi.", "Non, finalement envoie plutôt un message interne à Nadir BELKACEM pour l'en informer."], {
    carte: /message/i, champs: [[/destinataire|à|pour/i, /Nadir/i]], sansConfirmer: true,
  }),
  t("TR-ER-05-hors-droit", "reprise", "commercial", "Crée une demande de sponsoring de 300 000 DZD pour le congrès SAHGE.", {
    contient: [/droit|ouvert|acc[eè]s|r[ée]serv|pas (le droit|autoris)/i], interdit: [/sponsoring pr[ée]par/i],
  }),
  t("TR-LM-01-date-relative", "limites", "kam", "Mets-moi un rendez-vous dans trois semaines, le jeudi à 15 h, avec le pharmacien de la clinique El Azhar.", { carte: /rendez-vous|agenda|r[ée]union/i, sansConfirmer: true }),
  t("TR-LM-02-darija", "limites", "delegue", "دير لي tâche باش نعيط لصيدلية بن علي غدوة الصباح", { carte: /t[âa]che/i, sansConfirmer: true }),
  t("TR-LM-03-vague", "limites", "assistante", "Aide-moi à organiser ma semaine.", { contient: [/t[âa]che|agenda|rendez-vous|semaine|priorit/i], questionsMax: 1 }),
  t("TR-LM-04-quantites", "limites", "delegue", "Demande du matériel promo : 3 cartons de brochures Daclavir (100 par carton) et 2 boîtes de stylos.", {
    carte: /mat[ée]riel/i, contient: [/300|3 cartons/i], questionsMax: 1, sansConfirmer: true,
  }, { precision: "Livraison à Constantine, pour le 20 novembre." }),
  t("TR-LG-01-cinq-gestes", "enchainement-long", "manager", [
    `Crée une tâche pour ${RADIA} : préparer la revue de portefeuille Blida, échéance vendredi.`,
    "Mets-moi un rendez-vous avec elle jeudi 11 h pour en parler.",
    "Note dans mes notes : revoir les objectifs Q1 de Radia.",
    "Préviens-la par message du rendez-vous.",
    "Récapitule tout ce qu'on a préparé.",
  ], { contient: [/revue|portefeuille/i, /jeudi|11/i, /objectif/i] }),

  // ── Les nouveaux rôles (juriste, moyens généraux) : une tâche chacun ici, le reste dans leurs domaines ──
  t("TR-JU-01-echeances", "questions", "juriste", "Quels contrats ou engagements juridiques arrivent à échéance dans les trois prochains mois ?", { contient: [/contrat|engagement|aucun/i] }),
  t("TR-MG-01-demande-admin", "moyens-generaux", "moyens_generaux", "Crée une demande administrative : réparation de la climatisation du siège, 85 000 DZD.", { carte: /demande|administr/i, sansConfirmer: true }),

  // ── Voix ──
  t("TR-VX-01-tache", "voix", "delegue", "Crée-moi une tâche pour rappeler la pharmacie Benali demain matin.", { carte: /t[âa]che/i }, { voix: true }),
  t("TR-VX-02-question", "voix", "commercial", "Combien de jours de congé il me reste ?", { contient: [/\d/] }, { voix: true }),
  t("TR-VX-03-message", "voix", "manager", `Dis à ${RADIA} par message que la réunion de lundi est décalée à 10 heures.`, { carte: /message/i }, { voix: true }),
];

/** Le semis du domaine : un ticket de restaurant (note de frais) et un compte rendu de visite ANPP (multi-étapes). */
export const SEMIS_TRANSVERSE: SemisDeDomaine = async ({ users, companyId, etiquette }) => {
  // Les demandes Ad & Pro du KAM (EX-02, TR-MU-04 : analyser et exporter « mes demandes ») — mesuré : il n'en avait aucune.
  for (const [i, [titre, montant, statut]] of ([
    ["Stand salon pharmaceutique Alger", 350_000, "APPROVED"], ["Cartes de visite KAM", 8_000, "DONE"], ["Déjeuner pharmaciens CHU Mustapha", 64_000, "AWAITING_DECISION"],
  ] as const).entries()) {
    await demandeAdProAutre({ companyId, requesterId: users.kam, reference: `AUT-TR${etiquette}-${i + 1}`.slice(0, 40), titre, montant, statut, mois: 3 + 3 * i });
  }
  const frais = await dossierDrive(users.delegue, "Notes de frais");
  return {
    tr_ticket_resto: await deposerPiece(users.delegue, "Ticket restaurant El Bahdja Sétif.pdf", await pdf([
      "RESTAURANT EL BAHDJA — SÉTIF", "Date : 28/10/2026 — Table 7 — 2 couverts", "Menu affaires x2 : 4 800,00 DZD", "Boissons : 600,00 DZD", "TOTAL TTC : 5 400,00 DZD",
    ]), frais.id),
    tr_cr_anpp: await deposerPiece(users.regulatory, "CR visite ANPP Rouiba 22-10.pdf", await pdf([
      "Compte rendu — visite d'inspection ANPP", "Date : 22 octobre 2026. Site : entrepôt de Rouiba.",
      "Constats : registre des températures incomplet (septembre) ; procédure de rappel de lot à mettre à jour.",
      "Délai accordé : 30 jours pour le plan d'actions correctives.",
    ])),
  };
};
