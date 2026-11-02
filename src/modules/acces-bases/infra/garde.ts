/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉVALUATEUR DE LA GARDE (lot D3, décision 0057) — le juge que le socle appelle pour chaque requête.
 *
 * Il doit être SYNCHRONE et quasi gratuit : il est appelé des milliers de fois par page. D'où un INSTANTANÉ des
 * réglages en mémoire, rafraîchi en arrière-plan (toutes les 30 s, et jamais sur le chemin de la requête). Un
 * instantané vide ne juge rien : au démarrage, l'ERP se comporte exactement comme avant.
 *
 * D3 : il COMPTE ce qui aurait été refusé (`ObservationAccesBase`), il ne refuse pas. Le refus réel est le lot D4.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { sansBloquer } from "@/lib/journal";
import { estSysteme, poserEvaluateurDonnees, type ContexteDonnees, type EvaluateurDonnees } from "@/platform/donnees/contexte";
import { baseDe, baseDuModele, droitEffectif, droitParModules, niveauPour } from "../domaine/regle";
import type { ReglageBase } from "../domaine/types";
import { compterObservation } from "./observations";
import { reglagesVivants } from "./reglages";

const FRAICHEUR_MS = 30_000;

interface Instantane {
  reglages: readonly ReglageBase[];
  expire: number;
}
let instantane: Instantane = { reglages: [], expire: 0 };
let enCours = false;

/** Rafraîchit l'instantané en arrière-plan : la requête qui a vu l'instantané périmé n'attend pas. */
function rafraichirSiBesoin(): void {
  if (enCours || Date.now() < instantane.expire) return;
  enCours = true;
  instantane = { ...instantane, expire: Date.now() + FRAICHEUR_MS };
  void reglagesVivants()
    .then((reglages) => { instantane = { reglages, expire: Date.now() + FRAICHEUR_MS }; })
    .catch(sansBloquer("acces-bases: instantané des réglages"))
    .finally(() => { enCours = false; });
}

/** Pour les bancs : impose un instantané (ou le vide) sans attendre le rafraîchissement. */
export function poserInstantaneDeTest(reglages: readonly ReglageBase[] | null): void {
  instantane = reglages ? { reglages, expire: Date.now() + FRAICHEUR_MS } : { reglages: [], expire: 0 };
}

export const evaluateurAccesBases: EvaluateurDonnees = ({ modele, geste, contexte }) => {
  rafraichirSiBesoin();
  if (!contexte || estSysteme(contexte)) return null; // une tâche de fond déclarée n'est pas une personne
  if (!instantane.reglages.length) return null; // aucun réglage : rien à juger
  const cle = baseDuModele(modele);
  const base = cle ? baseDe(cle) : null;
  // Les bases TECHNIQUES ne se règlent pas : l'ERP ne tourne pas sans elles (comptes, journaux, plateforme).
  if (!base || base.nature === "technique") return null;

  const n = niveauPour({ userId: contexte.userId, roles: contexte.roles }, base.cle, instantane.reglages, new Date());
  if (n.niveau === "NORMAL") return null;
  const droit = droitEffectif(droitParModules(base, contexte.peut), n, base.nom);
  const permis = geste === "lecture" ? droit.lecture : droit.ecriture;
  if (permis) return null;

  compterObservation({ base: base.cle, userId: contexte.userId, geste, niveau: n.niveau, modele });
  return { refus: `La base « ${base.nom} » vous est ${n.niveau === "FERMEE" ? "fermée" : "ouverte en lecture seule"} — demandez à la Direction.` };
};

/** Branche la garde (appelé au démarrage du serveur, `src/instrumentation.ts`). */
export function brancherGardeDonnees(): void {
  poserEvaluateurDonnees(evaluateurAccesBases);
}

/** Débranche la garde (fin de banc). */
export function debrancherGardeDonnees(): void {
  poserEvaluateurDonnees(null);
}

export type { ContexteDonnees };
