/**
 * LES VALEURS DU DOCUMENT DE LA DIRECTION — proposées par défaut dans le formulaire de l'ordre de mission, toujours
 * modifiables. Module sans import : le formulaire (client) le lit sans tirer le générateur.
 */
export const VALEURS_DU_MODELE = {
  entreprise: "ADVENTUM PHARMA",
  adresse: "Cité des Moudjahidine, Sec 45 GP 15 Lot 1, 1ER Etage Chéraga- Alger-",
  signataire: "M. DJOUAMAI Redouane",
  signataireFonction: "Directeur Des Ressources Humaines",
} as const;

export const MODES_TRANSPORT_MISSION = ["Véhicule personnel", "Véhicule de service", "Avion", "Train", "Bus", "Taxi"] as const;