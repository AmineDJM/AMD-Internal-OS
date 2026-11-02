/**
 * LA CARTE DE LA PLATEFORME — les DOMAINES (les grandes familles du menu).
 */
import type { Domaine } from "./types";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES DOMAINES — l'ordre est celui du menu (Pilotage, Pôles, Transverse, Système).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DOMAINES: readonly Domaine[] = [
  { cle: "pilotage", nom: "Pilotage & espace personnel", resume: "Ce que chaque personne ouvre le matin : son espace, ses tâches, ses messages, son équipe." },
  { cle: "regulatory", nom: "Regulatory", resume: "Les dossiers d'enregistrement (AMM / ANPP), du CTD reçu à la décision." },
  { cle: "marketing", nom: "Marketing", resume: "Les produits, la segmentation des médecins, et toutes les dépenses de promotion (Ad & Pro)." },
  { cle: "operations", nom: "Operations & Sales", resume: "Le terrain (KAM, visites, rapports), la PCH (marchés, ventes, stocks)." },
  { cle: "administration", nom: "Administration & RH", resume: "Le secrétariat, les RH, le juridique, les courriers, les annuaires." },
  { cle: "argent", nom: "Argent : centres, finances, budgets", resume: "Qui autorise, qui signe, qui paie, et sur quel budget la dépense tombe." },
  { cle: "transverse", nom: "Transverse", resume: "Les outils communs à tous les modules : validations, Drive, recherche." },
  { cle: "systeme", nom: "Système & IA", resume: "Le pilotage de la plateforme : administration, Brain, Adam (en pause)." },
  { cle: "externe", nom: "Externe", resume: "Ce que voient les personnes hors de la société." },
];
