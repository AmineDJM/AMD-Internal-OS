/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ACTUALISATION DES SOLDES — la règle, et elle seule.
 *
 * Le Super Admin DEMANDE (pour une entité), les responsables Finance / Budget RÉPONDENT compte par
 * compte depuis la notification : le solde du nouveau relevé et sa date, ou « pas encore reçu ». Le
 * compte est alors RÉANCRÉ — c'est le même geste que « Corriger l'ancrage », sans motif à écrire : le
 * motif, c'est la demande.
 *
 * Trois états par compte, et la demande se lit sur eux :
 *   • EN_ATTENTE — personne n'a encore répondu pour ce compte ;
 *   • NON_RECU   — le relevé n'est pas arrivé : la demande RESTE ouverte, le compte se complète plus tard ;
 *   • ACTUALISE  — le compte est réancré. Définitif : on ne réécrit pas une réponse donnée (une erreur
 *                  se corrige par « Corriger l'ancrage », avec un motif, comme tout ancrage).
 *
 * Module PUR — zéro import : lu par l'action serveur ET par l'écran (même refus des deux côtés).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatLigne = "EN_ATTENTE" | "ACTUALISE" | "NON_RECU";
export type EtatDemande = "EN_ATTENTE" | "PARTIELLE" | "TERMINEE";

export const LIBELLE_ETAT_LIGNE: Record<EtatLigne, string> = {
  EN_ATTENTE: "En attente",
  ACTUALISE: "Actualisé",
  NON_RECU: "Relevé pas encore reçu",
};

export const LIBELLE_ETAT_DEMANDE: Record<EtatDemande, string> = {
  EN_ATTENTE: "En attente des Finances",
  PARTIELLE: "Partiellement actualisée",
  TERMINEE: "Actualisée",
};

export const estEtatLigne = (v: unknown): v is EtatLigne => v === "EN_ATTENTE" || v === "ACTUALISE" || v === "NON_RECU";

/** L'état de la demande se DÉDUIT de ses lignes — jamais stocké à part, il ne peut pas les contredire. */
export function etatDemande(etats: readonly EtatLigne[]): EtatDemande {
  if (etats.length > 0 && etats.every((e) => e === "ACTUALISE")) return "TERMINEE";
  if (etats.some((e) => e !== "EN_ATTENTE")) return "PARTIELLE";
  return "EN_ATTENTE";
}

/** Ce qu'on sait d'une ligne au moment de répondre. */
export interface LigneConnue {
  id: string;
  compte: string;
  etat: EtatLigne;
  /** Le jour (Alger, AAAA-MM-JJ) de l'ancrage ACTUEL du compte — le nouveau relevé ne peut pas être plus ancien. */
  jourAncrageActuel: string;
}

/** Ce que la personne a saisi pour une ligne. */
export interface SaisieLigne {
  ligneId: string;
  choix: "ACTUALISE" | "NON_RECU";
  solde?: number | null;
  /** AAAA-MM-JJ. */
  date?: string | null;
}

export type LectureReponse =
  | { ok: true; actualisees: { ligneId: string; solde: number; date: string }[]; nonRecues: string[] }
  | { ok: false; error: string };

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const jourFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * LIRE UNE RÉPONSE — et refuser en NOMMANT tout ce qui ne va pas, en une fois.
 *
 * Chaque compte encore ouvert (en attente ou « pas encore reçu ») doit recevoir une réponse : celui
 * qui a demandé lira un bilan complet, pas un silence sur un compte oublié. Un compte déjà actualisé
 * ne se réécrit pas. Le solde peut être négatif (un découvert est un solde), jamais absent ; la date
 * n'est ni future, ni antérieure au relevé actuel du compte — reculer l'ancrage recompterait des
 * écritures déjà incluses dans le relevé.
 */
export function lireReponse(lignes: readonly LigneConnue[], saisies: readonly SaisieLigne[], aujourdhui: string): LectureReponse {
  const parId = new Map(lignes.map((l) => [l.id, l]));
  const vues = new Set<string>();
  const erreurs: string[] = [];
  const actualisees: { ligneId: string; solde: number; date: string }[] = [];
  const nonRecues: string[] = [];

  for (const s of saisies) {
    const l = parId.get(s.ligneId);
    if (!l) { erreurs.push("un compte qui n'appartient pas à cette demande"); continue; }
    if (vues.has(l.id)) { erreurs.push(`« ${l.compte} » saisi deux fois`); continue; }
    vues.add(l.id);
    if (l.etat === "ACTUALISE") { erreurs.push(`« ${l.compte} » est déjà actualisé`); continue; }
    if (s.choix === "NON_RECU") { nonRecues.push(l.id); continue; }
    const solde = s.solde;
    const date = s.date ?? "";
    if (solde === null || solde === undefined || !Number.isFinite(solde)) { erreurs.push(`le solde de « ${l.compte} »`); continue; }
    if (Math.abs(solde) >= 1e12) { erreurs.push(`un solde vraisemblable pour « ${l.compte} »`); continue; }
    if (!JOUR.test(date)) { erreurs.push(`la date du relevé de « ${l.compte} »`); continue; }
    if (date > aujourdhui) { erreurs.push(`une date de relevé qui n'est pas dans le futur pour « ${l.compte} »`); continue; }
    if (date < l.jourAncrageActuel) {
      erreurs.push(`une date de relevé au plus tôt le ${jourFr(l.jourAncrageActuel)} pour « ${l.compte} » (son relevé actuel)`);
      continue;
    }
    actualisees.push({ ligneId: l.id, solde: Math.round(solde * 100) / 100, date });
  }

  const oublies = lignes.filter((l) => l.etat !== "ACTUALISE" && !vues.has(l.id)).map((l) => `« ${l.compte} »`);
  if (oublies.length) erreurs.push(`une réponse pour ${oublies.join(", ")} (solde ou « pas encore reçu »)`);
  if (erreurs.length) return { ok: false, error: `Indiquez ${erreurs.join(" ; ")}.` };
  if (actualisees.length === 0 && nonRecues.length === 0) return { ok: false, error: "Tous les comptes de cette demande sont déjà actualisés." };
  return { ok: true, actualisees, nonRecues };
}

/** « SGA Birkhadem : 2 300 000 DZD au 26/10/2026 ; BNA : pas encore reçu » — la phrase du bilan. */
export function phraseBilan(lignes: readonly { compte: string; etat: EtatLigne; solde: number | null; date: string | null }[]): string {
  return lignes
    .map((l) =>
      l.etat === "ACTUALISE" && l.solde !== null && l.date
        ? `${l.compte} : ${l.solde.toLocaleString("fr-FR")} DZD au ${jourFr(l.date)}`
        : `${l.compte} : ${l.etat === "NON_RECU" ? "relevé pas encore reçu" : "en attente"}`,
    )
    .join(" ; ");
}
