/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE HORS LIGNE DU TERRAIN (lot J13, décision 0025) — règle PURE, zéro import (navigateur compris).
 *
 * Un délégué dicte dans un parking sans réseau. Le vocal (la photo, le compte rendu) entre d'abord dans une
 * file LOCALE (IndexedDB, côté écran) ; il part au retour du réseau, seul, et l'écran dit où il en est.
 *
 * LA RÈGLE QUI GARANTIT « AUCUNE PERTE » : un élément ne sort de la file que sur l'ACCUSÉ du serveur. Un envoi
 * coupé (onglet fermé, téléphone éteint pendant l'envoi) laisse l'élément « en cours » : au redémarrage il
 * redevient « en attente » et repart — avec la MÊME clé (`id`, tirée à la capture), que le serveur reconnaît :
 * renvoyer ne fait pas de doublon. Un refus définitif (fichier illisible, droit retiré) GARDE l'élément, en
 * erreur, avec la phrase du serveur : la personne le relit, le réessaie ou le jette elle-même.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type SorteElement = "vocal" | "photo" | "compte_rendu";
export type EtatElement = "EN_ATTENTE" | "ENVOI" | "ENVOYE" | "REFUSE";

export interface ElementFile {
  /** La clé d'idempotence, tirée à la capture — la même à chaque renvoi. */
  id: string;
  sorte: SorteElement;
  creeLe: number;
  etat: EtatElement;
  tentatives: number;
  prochainEssai: number;
  erreur: string | null;
  /** Ce que le serveur a rendu une fois l'élément accepté (identifiant de la capture). */
  accuse: string | null;
  /** Libellé lisible (« Vocal de 0:42 », « Photo — présentoir »). */
  libelle: string;
}

/** Le délai avant le prochain essai : 5 s, 10 s, 20 s… jusqu'à 5 min. */
export const delaiApresEchec = (tentatives: number): number => Math.min(5_000 * 2 ** Math.max(0, tentatives - 1), 300_000);

export function nouvelElement(id: string, sorte: SorteElement, libelle: string, maintenant: number): ElementFile {
  return { id, sorte, creeLe: maintenant, etat: "EN_ATTENTE", tentatives: 0, prochainEssai: maintenant, erreur: null, accuse: null, libelle };
}

/** Au chargement : un envoi resté « en cours » a été coupé — il repart. */
export function reprendreApresRedemarrage(file: ElementFile[]): ElementFile[] {
  return file.map((e) => (e.etat === "ENVOI" ? { ...e, etat: "EN_ATTENTE", prochainEssai: 0 } : e));
}

/** Ce qui part maintenant : en attente, échéance passée, réseau présent — les plus anciens d'abord. */
export function aEnvoyer(file: ElementFile[], maintenant: number, enLigne: boolean): ElementFile[] {
  if (!enLigne) return [];
  return file.filter((e) => e.etat === "EN_ATTENTE" && e.prochainEssai <= maintenant).sort((a, b) => a.creeLe - b.creeLe);
}

export type IssueEnvoi =
  | { ok: true; accuse: string }
  /** `definitif` : le serveur a refusé l'élément lui-même (4xx) — le renvoyer tel quel ne changera rien. */
  | { ok: false; erreur: string; definitif: boolean };

export function apresEnvoi(e: ElementFile, issue: IssueEnvoi, maintenant: number): ElementFile {
  if (issue.ok) return { ...e, etat: "ENVOYE", accuse: issue.accuse, erreur: null };
  const tentatives = e.tentatives + 1;
  if (issue.definitif) return { ...e, etat: "REFUSE", tentatives, erreur: issue.erreur };
  return { ...e, etat: "EN_ATTENTE", tentatives, erreur: issue.erreur, prochainEssai: maintenant + delaiApresEchec(tentatives) };
}

/** La personne relance un élément refusé (ou en attente) : tout de suite, compteur gardé. */
export const relancer = (e: ElementFile): ElementFile => (e.etat === "ENVOYE" ? e : { ...e, etat: "EN_ATTENTE", prochainEssai: 0 });

/** Le stockage local et l'envoi, injectés : IndexedDB et `fetch` à l'écran, une mémoire et un faux réseau au banc. */
export interface StockageFile {
  lister(): Promise<ElementFile[]>;
  ecrire(e: ElementFile): Promise<void>;
  /** Retire l'élément ET son contenu (audio, image) — appelé seulement sur un élément accusé. */
  retirer(id: string): Promise<void>;
}

/**
 * VIDER LA FILE — un passage : chaque élément dû part à son tour (un seul envoi à la fois : un réseau de
 * terrain faible ne supporte pas trois vocaux en parallèle). L'état est ÉCRIT avant l'envoi (« en cours »)
 * et après (accusé ou erreur) : un arrêt à n'importe quel instant laisse une file relisible.
 */
export async function viderFile(
  stockage: StockageFile, envoyer: (e: ElementFile) => Promise<IssueEnvoi>, horloge: () => number, enLigne: () => boolean,
): Promise<{ envoyes: number; echecs: number }> {
  let envoyes = 0;
  let echecs = 0;
  const dus = aEnvoyer(await stockage.lister(), horloge(), enLigne());
  for (const e of dus) {
    if (!enLigne()) break;
    const enCours: ElementFile = { ...e, etat: "ENVOI" };
    await stockage.ecrire(enCours);
    let issue: IssueEnvoi;
    try {
      issue = await envoyer(enCours);
    } catch (err) {
      issue = { ok: false, erreur: err instanceof Error ? err.message : "Réseau indisponible.", definitif: false };
    }
    const apres = apresEnvoi(enCours, issue, horloge());
    await stockage.ecrire(apres);
    if (apres.etat === "ENVOYE") {
      envoyes += 1;
      await stockage.retirer(apres.id);
    } else echecs += 1;
  }
  return { envoyes, echecs };
}

/** La phrase d'état, toujours visible à l'écran. */
export function phraseFile(file: ElementFile[], enLigne: boolean): string {
  const attente = file.filter((e) => e.etat === "EN_ATTENTE" || e.etat === "ENVOI").length;
  const refuses = file.filter((e) => e.etat === "REFUSE").length;
  const parts: string[] = [];
  if (attente) parts.push(`${attente} en attente d'envoi${enLigne ? "" : " — partira au retour du réseau"}`);
  if (refuses) parts.push(`${refuses} refusé${refuses > 1 ? "s" : ""} par le serveur (à relire)`);
  if (!parts.length) return enLigne ? "Tout est envoyé." : "Hors ligne — vos vocaux et photos seront gardés ici puis envoyés.";
  return parts.join(" · ");
}
