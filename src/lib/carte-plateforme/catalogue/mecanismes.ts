/**
 * LA CARTE DE LA PLATEFORME — les MÉCANISMES TRANSVERSES : les règles qui valent partout.
 */
import type { Mecanisme } from "./types";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES MÉCANISMES TRANSVERSES — ce qui vaut partout.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MECANISMES: readonly Mecanisme[] = [
  {
    titre: "Les droits : rôle, console, accès implicites",
    resume: "Ce qu'une personne peut faire = les défauts de son rôle, corrigés par la console, plus quelques accès implicites.",
    details: [
      "Sept actions par module : Voir, Créer, Modifier, Supprimer, Valider, Exporter, Téléverser.",
      "Couche 1 : la matrice du rôle (PERMISSIONS dans lib/rbac.ts) — c'est elle que montre l'onglet « Rôles ».",
      "Couche 2 : la console (Administration › Accès) ouvre, restreint ou BLOQUE un module pour une personne ; le blocage prime toujours.",
      "Accès implicites : Mon équipe et Annuaires pour tous, Campagne budgétaire pour qui dirige un département, Recrutement pour tous, un dossier Regulatory porté, un siège au centre de paiement, un intérim en cours.",
      "Portée : TOUT (vue globale : Super Admin et Direction) ou « ses lignes » (ce qu'on a créé, porte ou suit).",
      "Un rôle secondaire ajoute ses droits au rôle principal ; il ne donne jamais Adam.",
    ],
  },
  {
    titre: "Les entités (sociétés du groupe)",
    resume: "Adventum Pharma, Pharmagène, et toute entité créée ensuite : presque chaque enregistrement porte son entité.",
    details: [
      "Le sélecteur de la barre du haut est une DEMANDE, jamais une autorisation : il est revalidé contre les droits réels.",
      "« Toutes les entités » = toutes celles auxquelles on a droit, jamais toutes celles qui existent.",
      "Les RH n'ont pas de colonne d'entité : congés et paie pendent de l'employé, qui porte la sienne.",
    ],
  },
  {
    titre: "Les trois centres et la séparation des rôles",
    resume: "Celui qui demande, celui qui autorise et celui qui paie ne sont jamais dans le même écran.",
    details: [
      "Centre de paiement : l'argent (PDG, Super Admin, sièges nommés).",
      "Centre de validations : les décisions du DG (DG, Super Admin).",
      "Centre Ad & Pro : les demandes de promotion au-dessus du seuil, et les seuils (DG, Super Admin).",
      "Cocher le module dans la console ne fait pas siéger : le siège vient du rôle ou d'une désignation nominative.",
    ],
  },
  {
    titre: "Renvoyer pour correction, motif exigé",
    resume: "Presque partout, une décision a trois issues : approuver, refuser, renvoyer.",
    details: [
      "Refuser ou renvoyer exige un motif.",
      "Une demande renvoyée apparaît dans « À corriger » chez le demandeur ; resoumise, elle revient à l'étape qui l'a renvoyée.",
      "On ne tranche jamais sa propre demande (sauf au sommet).",
    ],
  },
  {
    titre: "Corbeille, audit et rejeu",
    resume: "Rien ne se détruit sans trace.",
    details: [
      "Toute suppression définitive est un instantané restaurable dans Administration › Corbeille.",
      "Le journal d'audit trace les gestes ; le rejeu de session montre la suite des actions d'une personne, sans valeurs de champ.",
      "Les demandes d'achat sont copiées entièrement dans un journal à part (Administration › Journal des demandes d'achat).",
    ],
  },
  {
    titre: "Vue exacte",
    resume: "Le Super Admin voit l'ERP exactement comme une personne, pendant 4 heures.",
    details: [
      "Une vue, pas une usurpation : toute écriture part au nom du Super Admin réel.",
      "Exception voulue : créer une demande Ad & Pro se fait au nom de la personne visualisée.",
      "Adam est désactivé en Vue exacte ; cette carte aussi (elle est réservée au Super Admin).",
    ],
  },
  {
    titre: "Notifications et « À faire »",
    resume: "Le lien d'une notification mène à l'action exacte, et chaque file se lit avec la règle que son action applique.",
    details: [
      "Mon espace ne montre une validation qu'à SON tour.",
      "Chaque ligne dit depuis quand elle attend (jours civils d'Alger).",
      "Tâches planifiées (rappels, balayages) sans cron : lancées par l'application elle-même.",
    ],
  },
  {
    titre: "Modules retirés",
    resume: "Ventes (saisie manuelle), Commandes & logistique et Market Intelligence sont retirés pour TOUT LE MONDE, Super Admin compris.",
    details: [
      "Ni menu, ni adresse, ni action serveur, ni outil d'assistant ; les données restent en base.",
      "Retours & réclamations est également retiré (données gardées).",
    ],
  },
];
