/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPOSEUR — l'endroit, et le seul, où Adam et le Mission Runtime se rencontrent.
 *
 * ── POURQUOI UN COMPOSEUR PLUTÔT QUE DES BRANCHEMENTS ÉPARPILLÉS ────────────────────────
 *
 * Le runtime ne connaît ni les outils, ni les modèles, ni le Drive : il déclare des ports. Ces
 * ports doivent bien être remplis quelque part. S'ils l'étaient à trois endroits — la route
 * HTTP, l'ordonnanceur, le webhook — on aurait trois assemblages, dont deux finiraient par
 * différer : un gestionnaire oublié ici, un juge absent là. Et un juge absent, c'est une
 * mission qui ne conclut jamais ; un gestionnaire d'artefact absent, c'est un fichier qui
 * n'existe pas alors que l'écran dit qu'il est prêt.
 *
 * Il y a donc UNE fonction qui assemble, et tous les appelants passent par elle.
 *
 * ── CE QUI EST BRANCHÉ, ET CE QUE CHACUN APPORTE ────────────────────────────────────────
 *
 *   catalogue   ce que cette personne a le droit de faire — la même liste qu'en conversation ;
 *   exécutant   le chemin canonique d'écriture, avec RBAC, intent, reçu et idempotence ;
 *   raisonneur  la passerelle modèle, en sorties structurées strictes ;
 *   WORKER      un exécutant éphémère par étape de réflexion ;
 *   QA          le contrôle arithmétique — cardinalité, destinataires, reçus, doublons ;
 *   ARTIFACT    la fabrique de fichiers, contrôlés avant d'être rangés ;
 *   APPROVAL    la porte d'accord, fermée par défaut ;
 *   juge        celui sans qui la mission ne conclut PAS.
 *
 * Les gestionnaires d'attente (`WAIT_EVENT`, `WAIT_INPUT`) ne sont volontairement PAS branchés :
 * le comportement natif du moteur — attendre — est exactement le bon, et le routeur
 * d'événements réveille la mission de l'extérieur. Y mettre un gestionnaire qui « vérifie si
 * l'événement est arrivé » recréerait une scrutation là où il y a déjà une notification.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `runtime/` : `assemblage.ts` (brancher les ports,
 * contrôle qualité), `lancement.ts` (planifier, compiler, persister — `lancerMission`), `arriere-plan.ts`
 * (lancement différé et rattrapage), `avancement.ts` (`avancerMission`), `replanification.ts`
 * (`replanifierMission`).
 */

export { assembler, type AssemblageMission, type OptionsAssemblage } from "./runtime/assemblage";
export { estPanneTransitoire, titreDe, lancerMission, type LancementOptions, type ResultatLancement } from "./runtime/lancement";
export { lancerEnArrierePlan, finaliserLancementDifere, rattraperLancementsPerdus } from "./runtime/arriere-plan";
export { avancerMission } from "./runtime/avancement";
export { replanifierMission, type ResultatReplanification } from "./runtime/replanification";
