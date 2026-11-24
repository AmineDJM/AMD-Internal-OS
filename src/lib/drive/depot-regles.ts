/**
 * LES RÈGLES DU DÉPÔT DANS LE DRIVE, côté personne — module PUR (serveur ET navigateur).
 *
 * Audit Drive du 24/11, section C : un dépôt ne doit jamais « perdre » un fichier aux yeux de la
 * personne — ni en doublon muet, ni sur un refus sans remède, ni sous une limite jamais annoncée.
 * Les phrases vivent ici pour que l'écran et le serveur disent la même chose.
 */
import { extensionDe, tailleLisible } from "@/lib/files/politique-televersement";
import { LIMITE_FICHIER_MO } from "@/lib/storage/limites-blob";

/** Ce que la personne choisit quand un fichier du même nom existe déjà à cet endroit. */
export type ChoixDoublon = "version" | "garder";

/** Lu d'un formulaire ou d'un JSON : toute autre valeur = pas de choix (comportement d'avant). */
export function lireChoixDoublon(v: unknown): ChoixDoublon | null {
  return v === "version" || v === "garder" ? v : null;
}

/**
 * « Garder les deux » : le nouveau reçoit un nom libre, à la Windows — « contrat (2).pdf ».
 * Deux fichiers au même nom dans un dossier, c'est l'assurance d'ouvrir le mauvais.
 */
export function nomLibre(nom: string, existants: Iterable<string>): string {
  const pris = new Set([...existants].map((n) => n.toLowerCase()));
  if (!pris.has(nom.toLowerCase())) return nom;
  const i = nom.lastIndexOf(".");
  const base = i > 0 ? nom.slice(0, i) : nom;
  const ext = i > 0 ? nom.slice(i) : "";
  for (let n = 2; n < 10_000; n++) {
    const essai = `${base} (${n})${ext}`;
    if (!pris.has(essai.toLowerCase())) return essai;
  }
  return `${base} (${Date.now()})${ext}`;
}

/**
 * Le contenu déposé porte-t-il une AUTRE extension (« .xlsx » déposé sur « x.pdf ») ? Un fichier
 * déposé sans extension ne dit rien de son type : on garde alors le nom tel quel.
 */
export function extensionDiffere(nomActuel: string, nomDepose: string): boolean {
  const nouvelle = extensionDe(nomDepose);
  return nouvelle !== "" && extensionDe(nomActuel) !== nouvelle;
}

/**
 * Le nom du fichier après une nouvelle version : il garde son nom, mais prend l'extension du
 * contenu déposé — sinon un classeur servi sous « x.pdf » s'ouvrirait dans le mauvais aperçu.
 */
export function nomApresNouvelleVersion(nomActuel: string, nomDepose: string): string {
  if (!extensionDiffere(nomActuel, nomDepose)) return nomActuel;
  const i = nomActuel.lastIndexOf(".");
  const base = i > 0 ? nomActuel.slice(0, i) : nomActuel;
  return `${base}.${extensionDe(nomDepose)}`;
}

/** La question posée avant l'envoi — un seul nom, ou le compte. */
export function questionDoublon(noms: string[]): string {
  if (noms.length === 1) return `« ${noms[0]} » existe déjà ici.`;
  return `${noms.length} fichiers existent déjà ici (${noms.slice(0, 3).map((n) => `« ${n} »`).join(", ")}${noms.length > 3 ? "…" : ""}).`;
}

/** La confirmation d'une version d'un autre type. */
export function avertissementExtension(nomActuel: string, nomDepose: string): string {
  const a = extensionDe(nomActuel);
  return `Le fichier déposé est un .${extensionDe(nomDepose)}, « ${nomActuel} » ${a ? `est un .${a}` : "n'a pas d'extension"}. Le fichier s'appellera « ${nomApresNouvelleVersion(nomActuel, nomDepose)} ».`;
}

/**
 * LE REFUS QUI DIT LE REMÈDE (point 10) — jamais « Non autorisé. » seul.
 * `qui` : la personne (ou le rôle) qui peut ouvrir l'accès, quand on la connaît.
 */
export function refusDepotPhrase(qui: string | null): string {
  return qui
    ? `Vous ne pouvez pas déposer ici. Demandez l'accès à ${qui}.`
    : "Vous ne pouvez pas déposer ici. Demandez l'accès au responsable de cet emplacement, ou déposez dans « Mes fichiers ».";
}

/** Ce que le serveur dit des envois (sous-ensemble de `/api/uploads/limites`). */
export interface LimitesAnnoncees {
  maxUploadMb: number;
  maxDriveUploadMb: number;
  stockageObjet: boolean;
  maxSansStockageObjetMo: number;
}

/**
 * LA LIMITE RÉELLE d'un fichier, en Mo (point 9) — celle que le refus appliquerait. Sans stockage
 * objet, le plafond d'écriture en base l'emporte ; avec, c'est le réglage de l'endroit.
 */
export function limiteAnnonceeMo(l: LimitesAnnoncees, lieu: "drive" | "documents"): number {
  const reglage = lieu === "drive" ? l.maxDriveUploadMb : l.stockageObjet ? LIMITE_FICHIER_MO : l.maxUploadMb;
  return l.stockageObjet ? reglage : Math.min(reglage, l.maxSansStockageObjetMo);
}

/** « max 25 Mo », « max 10 Go ». */
export function phraseLimite(l: LimitesAnnoncees | null, lieu: "drive" | "documents"): string | null {
  return l ? `max ${tailleLisible(limiteAnnonceeMo(l, lieu) * 1024 * 1024)} par fichier` : null;
}

/**
 * RAFRAÎCHIR LA LISTE À CHAQUE FICHIER, sans la rafraîchir trois cents fois (point 4) : au premier
 * fichier tout de suite, puis au plus une fois par `intervalle` ; un fichier arrivé entre deux
 * rafraîchissements en programme un à la fin de l'intervalle (jamais deux).
 */
export function decisionRafraichir(
  etat: { dernier: number | null; programme: boolean },
  maintenant: number,
  intervalle = 1500,
): { action: "maintenant" } | { action: "plus-tard"; dans: number } | { action: "rien" } {
  if (etat.dernier === null || maintenant - etat.dernier >= intervalle) return { action: "maintenant" };
  if (etat.programme) return { action: "rien" };
  return { action: "plus-tard", dans: intervalle - (maintenant - etat.dernier) };
}

/** Un appareil iOS : le choix de DOSSIER n'y existe pas (`webkitdirectory` ignoré) — on ne le propose pas. */
export function estIOS(userAgent: string, plateforme: string, pointsTactiles: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (plateforme === "MacIntel" && pointsTactiles > 1);
}
