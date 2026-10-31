/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPÔT DE DOSSIER — les RÈGLES (lot J11, décision 0030). Pur, navigateur compris.
 *
 * Direction : « un dossier glissé dans l'Assistant IA RECRÉE son arborescence dans le Drive de la personne au lieu de
 * tout poser à la racine ; au-delà de 10 pièces, le dépôt passe en mode « dépôt de dossier » : pas de limite de 10,
 * une borne réglable (1 000 fichiers, 2 Go par défaut), téléversement direct par morceaux, reprise si coupure ».
 *
 * Ici : quand un dépôt est un dossier, quel mode il prend, ce qui passe les bornes, comment s'appelle sa racine dans
 * le Drive, l'empreinte qui retrouve le même lot à la reprise, et la phrase de son état (n fichiers, lus, échoués,
 * en file). La décision 0015 (rien ne part avant Entrée) tient toujours : le lot ne s'ouvre qu'à l'envoi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { estFichierSysteme, type Refus } from "./depot";
import { PIECES_LUES_MAX } from "./regles";

/** Les bornes du mode « dépôt de dossier » — réglables (`ASSISTANT_DEPOT_DOSSIER_FICHIERS`, `…_MO`). */
export interface BornesDossier {
  fichiers: number;
  octets: number;
}

export const BORNES_DOSSIER_DEFAUT: BornesDossier = { fichiers: 1000, octets: 2 * 1024 ** 3 };

/** Les bornes lues des variables (serveur) — une valeur illisible ou nulle garde le défaut. */
export function bornesDossier(env: Readonly<Record<string, string | undefined>>): BornesDossier {
  const n = Number(env.ASSISTANT_DEPOT_DOSSIER_FICHIERS);
  const mo = Number(env.ASSISTANT_DEPOT_DOSSIER_MO);
  return {
    fichiers: Number.isFinite(n) && n > 0 ? Math.floor(n) : BORNES_DOSSIER_DEFAUT.fichiers,
    octets: Number.isFinite(mo) && mo > 0 ? Math.floor(mo * 1024 * 1024) : BORNES_DOSSIER_DEFAUT.octets,
  };
}

/** Entrées au plus parcourues pour un dossier déposé : la borne de fichiers, et la marge des sous-dossiers. */
export const entreesMaxDossier = (b: BornesDossier = BORNES_DOSSIER_DEFAUT): number => b.fichiers + Math.max(200, Math.ceil(b.fichiers / 5));

export interface FichierDeDossier {
  /** Chemin relatif tel que déposé (« Congrès Oran/devis/imprimeur.pdf »). */
  chemin: string;
  taille: number;
}

/** Le dépôt contient-il un DOSSIER (un chemin à plusieurs segments) ? */
export const contientUnDossier = (fichiers: readonly { chemin: string }[]): boolean => fichiers.some((f) => f.chemin.includes("/"));

/**
 * LE MODE d'un dépôt : « message » (les puces jointes au message, toutes LUES) ou « dossier » (le mode « dépôt », lu en
 * entier en arrière-plan par la Bibliothèque). K3 (décision 0033) : AU-DELÀ DE `PIECES_LUES_MAX` (6) pièces — fichiers
 * isolés OU dossier —, le dépôt est proposé d'office : plus de pièces « nommées non lues », plus de refus à 10.
 */
export function modeDuDepot(fichiers: readonly { chemin: string }[], dejaLa = 0): "message" | "dossier" {
  return fichiers.length + dejaLa > PIECES_LUES_MAX ? "dossier" : "message";
}

/** La puce du dépôt d'office : « 14 fichiers : tout lire en arrière-plan » (ou « Dossier « X » — … »). */
export function libelleDepotDOffice(d: { nom: string; fichiers: number; vrac: boolean }): string {
  const n = `${d.fichiers.toLocaleString("fr-FR")} fichier${d.fichiers > 1 ? "s" : ""}`;
  return d.vrac ? `${n} : tout lire en arrière-plan` : `Dossier « ${d.nom} » — ${n} : tout lire en arrière-plan`;
}

export const raisonBorneFichiers = (b: BornesDossier) =>
  `au-delà de ${b.fichiers.toLocaleString("fr-FR")} fichiers, un dépôt de dossier s'arrête (borne réglable) : déposez le reste dans un second dépôt.`;
export const raisonBorneOctets = (b: BornesDossier) =>
  `au-delà de ${Math.round(b.octets / 1024 ** 3 * 10) / 10} Go par dépôt de dossier (borne réglable) : déposez le reste dans un second dépôt.`;

/**
 * LES BORNES d'un dépôt de dossier : vides, fichiers système, puis le nombre et le total d'octets. L'ordre du parcours
 * est gardé ; chaque fichier écarté est NOMMÉ avec sa raison (jamais une limite silencieuse).
 */
export function planifierDossier<T extends FichierDeDossier>(fichiers: readonly T[], b: BornesDossier = BORNES_DOSSIER_DEFAUT): { acceptes: T[]; refus: Refus[]; octets: number } {
  const acceptes: T[] = [];
  const refus: Refus[] = [];
  const vus = new Set<string>();
  let octets = 0;
  for (const f of fichiers) {
    if (estFichierSysteme(f.chemin)) continue;
    if (f.taille <= 0) refus.push({ chemin: f.chemin, raison: "fichier vide (0 octet)." });
    else if (vus.has(f.chemin)) refus.push({ chemin: f.chemin, raison: "déjà dans ce dépôt." });
    else if (acceptes.length >= b.fichiers) refus.push({ chemin: f.chemin, raison: raisonBorneFichiers(b) });
    else if (octets + f.taille > b.octets) refus.push({ chemin: f.chemin, raison: raisonBorneOctets(b) });
    else { acceptes.push(f); vus.add(f.chemin); octets += f.taille; }
  }
  return { acceptes, refus, octets };
}

/**
 * LA RACINE dans le Drive : le dossier déposé garde son nom (« Congrès Oran ») ; plusieurs dossiers ou des fichiers
 * mêlés se rangent sous un dossier daté (« Dépôt du 30-10-2026 21h50 »). Les chemins rendus sont RELATIFS à la racine.
 */
export function racineDuDepot<T extends { chemin: string }>(fichiers: readonly T[], maintenant: Date = new Date()): { nom: string; fichiers: (T & { relatif: string })[] } {
  const premiers = new Set(fichiers.map((f) => f.chemin.split("/")[0] ?? ""));
  const unSeul = premiers.size === 1 && fichiers.every((f) => f.chemin.includes("/"));
  if (unSeul) {
    const nom = [...premiers][0]!.trim().slice(0, 200) || "Dossier déposé";
    return { nom, fichiers: fichiers.map((f) => ({ ...f, relatif: f.chemin.split("/").slice(1).join("/") })) };
  }
  const p = (n: number) => String(n).padStart(2, "0");
  const nom = `Dépôt du ${p(maintenant.getDate())}-${p(maintenant.getMonth() + 1)}-${maintenant.getFullYear()} ${p(maintenant.getHours())}h${p(maintenant.getMinutes())}`;
  return { nom, fichiers: fichiers.map((f) => ({ ...f, relatif: f.chemin })) };
}

/** Les dossiers (chemins relatifs uniques) à recréer sous la racine — parents avant enfants. */
export function dossiersARecreer(relatifs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const r of relatifs) {
    const segs = r.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "fr"));
}

/** Le dossier d'un chemin relatif (« devis/imprimeur.pdf » → « devis ») ; « » pour un fichier à la racine. */
export const dossierDe = (relatif: string): string => { const i = relatif.lastIndexOf("/"); return i >= 0 ? relatif.slice(0, i) : ""; };

/** Un nom libre dans un dossier : « Congrès Oran », sinon « Congrès Oran (2) », « (3) »… */
export function nomLibre(voulu: string, pris: ReadonlySet<string>): string {
  if (!pris.has(voulu)) return voulu;
  for (let i = 2; i < 1000; i++) if (!pris.has(`${voulu} (${i})`)) return `${voulu} (${i})`;
  return `${voulu} (${Date.now()})`;
}

/**
 * L'EMPREINTE d'un dépôt — les chemins et les tailles, triés (FNV-1a 64 bits, sans crypto : elle sert à RETROUVER un
 * lot, pas à le protéger). La même liste redéposée retrouve le même lot ; un fichier de plus en fait un autre.
 */
export function empreinteDepot(fichiers: readonly FichierDeDossier[]): string {
  const texte = [...fichiers].map((f) => `${f.chemin}\u0000${f.taille}`).sort().join("\n");
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < texte.length; i++) {
    h ^= BigInt(texte.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${fichiers.length}-${h.toString(36)}`;
}

/** Ce qui reste à envoyer à la REPRISE : les fichiers absents du Drive (même chemin relatif, même taille). */
export function restantsAEnvoyer<T extends { relatif: string; taille: number }>(fichiers: readonly T[], deja: readonly { relatif: string; taille: number }[]): T[] {
  const presents = new Set(deja.map((d) => `${d.relatif}\u0000${d.taille}`));
  return fichiers.filter((f) => !presents.has(`${f.relatif}\u0000${f.taille}`));
}

// ─────────────────────────────── L'état d'un lot (Travaux / panneau) ───────────────────────────────

export interface EtatLot {
  id: string;
  nom: string;
  racineId: string;
  statut: "TELEVERSEMENT" | "TERMINE" | "ABANDONNE";
  annonces: number;
  /** Arrivés dans le Drive (sous la racine). */
  televerses: number;
  lus: number;
  /** Rien à lire (format sans texte, trop volumineux) — dit, pas une erreur. */
  ignores: number;
  echoues: number;
  /** Inscrits à la Bibliothèque, pas encore lus. */
  enFile: number;
  createdAt: string;
}

/** Le compte des fiches d'un lot (statuts de la Bibliothèque) → l'état affiché. */
export function compterLot(statuts: readonly (string | null)[]): Pick<EtatLot, "televerses" | "lus" | "ignores" | "echoues" | "enFile"> {
  const c = { televerses: statuts.length, lus: 0, ignores: 0, echoues: 0, enFile: 0 };
  for (const s of statuts) {
    if (s === "FAITE") c.lus++;
    else if (s === "IGNOREE") c.ignores++;
    else if (s === "ECHEC") c.echoues++;
    else c.enFile++;
  }
  return c;
}

/** Le lot est-il fini (tout arrivé, plus rien en file) ? Le panneau cesse alors de l'interroger. */
export const lotFini = (e: EtatLot): boolean => e.enFile === 0 && (e.statut !== "TELEVERSEMENT" || e.televerses >= e.annonces);

const pl = (n: number, s: string, p = `${s}s`) => `${n.toLocaleString("fr-FR")} ${n > 1 ? p : s}`;

/** « 300 fichiers — 280 lus, 3 échoués, 17 en file » (et ce qui manque encore au téléversement). */
export function phraseLot(e: EtatLot): string {
  const parts = [`${pl(e.lus, "lu")}`];
  if (e.ignores) parts.push(`${pl(e.ignores, "sans texte")}`.replace("sans textes", "sans texte"));
  if (e.echoues) parts.push(`${pl(e.echoues, "échoué")}`);
  if (e.enFile) parts.push(`${e.enFile.toLocaleString("fr-FR")} en file`);
  const manquent = Math.max(0, e.annonces - e.televerses);
  if (manquent && e.statut === "TELEVERSEMENT") parts.push(`${manquent.toLocaleString("fr-FR")} à téléverser`);
  if (manquent && e.statut === "ABANDONNE") parts.push(`${manquent.toLocaleString("fr-FR")} non envoyés`);
  return `${pl(e.annonces, "fichier")} — ${parts.join(", ")}`;
}
