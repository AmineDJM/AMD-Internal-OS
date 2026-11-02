/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSATIONS DE L'ASSISTANT IA — RÈGLES PURES (décision 0027, Adventum IA, 30/10/2026).
 *
 * Plusieurs conversations par personne, comme ChatGPT : titre proposé, renommer, épingler, archiver, supprimer,
 * rechercher ; regroupées par date. Une conversation PRIVÉE se choisit à la création seulement — dès le premier
 * message, elle ne peut plus devenir privée ni cesser de l'être ; elle ne lit ni n'écrit la mémoire ; elle est
 * supprimée 30 jours après sa création. Aucune dépendance : l'écran et le serveur appliquent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TITRE_MAX = 80;
export const TITRE_DEFAUT = "Nouvelle conversation";
export const PRIVEE_JOURS = 30;
export const RECHERCHE_MIN = 2;

export type GroupeConversation = "Épinglées" | "Aujourd'hui" | "7 derniers jours" | "Plus ancien";
export const ORDRE_GROUPES: readonly GroupeConversation[] = ["Épinglées", "Aujourd'hui", "7 derniers jours", "Plus ancien"];

/** Ce que la liste montre d'une conversation (le serveur la rend, l'écran l'affiche). */
export interface ConversationResumee {
  id: string;
  titre: string;
  prive: boolean;
  epingle: boolean;
  archive: boolean;
  dossierId: string | null;
  /** ISO — la date du dernier message (tri et groupe). */
  dernierLe: string;
  /** Un extrait du contenu, quand la recherche l'a trouvée par son contenu. */
  extrait?: string;
}

/** Un titre propre : une ligne, sans guillemets ni ponctuation de fin, borné. Vide → `null`. */
export function nettoyerTitre(brut: string | null | undefined): string | null {
  const t = String(brut ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"«»'`*#-]+|[\s"«»'`*.!?:;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > TITRE_MAX ? `${t.slice(0, TITRE_MAX - 1).trimEnd()}…` : t;
}

/** Le titre PROVISOIRE, posé au premier message : son début, coupé à un mot (le modèle rapide l'affine ensuite). */
export function titreProvisoire(premierMessage: string, vocal = false): string {
  const t = premierMessage.replace(/\s+/g, " ").trim();
  if (!t) return vocal ? "Message vocal" : TITRE_DEFAUT;
  if (t.length <= 42) return nettoyerTitre(t) ?? TITRE_DEFAUT;
  const coupe = t.slice(0, 42);
  const espace = coupe.lastIndexOf(" ");
  return `${(espace > 20 ? coupe.slice(0, espace) : coupe).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/** La consigne du modèle RAPIDE qui propose un titre : quelques mots, sans valeur sensible. */
export const CONSIGNE_TITRE = [
  "Propose un TITRE de 2 à 6 mots, en français, pour cette conversation entre une personne d'Adventum Pharma et son assistant.",
  "Le titre dit le SUJET (« Budget congrès d'Oran », « Dossier daclatasvir ANPP »), pas la forme (« Question sur… »).",
  "Jamais de montant, de salaire, de coordonnée bancaire ni de numéro de pièce d'identité. Réponds par le titre seul, sans guillemets.",
].join("\n");

/**
 * PRIVÉE, VERROUILLÉE APRÈS LE PREMIER MESSAGE : on ne peut changer le caractère privé d'une conversation que tant
 * qu'elle n'a aucun tour (l'écran « Nouvelle conversation », avant d'écrire). Rend la raison du refus, ou `null`.
 */
export function refusChangerPrive(nombreDeTours: number): string | null {
  return nombreDeTours > 0
    ? "Une conversation commencée ne peut plus devenir privée, ni cesser de l'être : ouvrez une nouvelle conversation."
    : null;
}

/** Une conversation privée expire 30 jours après sa création. */
export function expireLe(creeeLe: Date): Date {
  return new Date(creeeLe.getTime() + PRIVEE_JOURS * 86_400_000);
}
export const limitePurgePrivees = (maintenant: Date): Date => new Date(maintenant.getTime() - PRIVEE_JOURS * 86_400_000);

/** Le jour (calendrier d'Alger, UTC+1 sans heure d'été) d'une date — pour « Aujourd'hui ». */
const jourAlger = (d: Date): number => Math.floor((d.getTime() + 3_600_000) / 86_400_000);

/** Le groupe d'une conversation dans la liste : épinglées d'abord, puis par date du dernier message. */
export function groupeDe(c: Pick<ConversationResumee, "epingle" | "dernierLe">, maintenant: Date): GroupeConversation {
  if (c.epingle) return "Épinglées";
  const d = new Date(c.dernierLe);
  const ecart = jourAlger(maintenant) - jourAlger(d);
  if (ecart <= 0) return "Aujourd'hui";
  if (ecart < 7) return "7 derniers jours";
  return "Plus ancien";
}

/** La liste regroupée, dans l'ordre des groupes ; dans un groupe, la plus récente d'abord. Les archivées n'y sont pas. */
export function grouperConversations<T extends ConversationResumee>(
  conversations: readonly T[], maintenant: Date,
): { groupe: GroupeConversation; conversations: T[] }[] {
  const parGroupe = new Map<GroupeConversation, T[]>();
  for (const c of conversations) {
    if (c.archive) continue;
    const g = groupeDe(c, maintenant);
    parGroupe.set(g, [...(parGroupe.get(g) ?? []), c]);
  }
  return ORDRE_GROUPES.filter((g) => parGroupe.has(g)).map((g) => ({
    groupe: g,
    conversations: [...parGroupe.get(g)!].sort((a, b) => b.dernierLe.localeCompare(a.dernierLe)),
  }));
}

/** La recherche : au moins deux caractères, une ligne, bornée. `null` = pas de recherche. */
export function termeDeRecherche(brut: string | null | undefined): string | null {
  const t = String(brut ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  return t.length >= RECHERCHE_MIN ? t : null;
}

/** Un extrait autour du terme trouvé (± 60 caractères), sur une ligne. */
export function extraitAutour(texte: string, terme: string, rayon = 60): string {
  const plat = texte.replace(/\s+/g, " ").trim();
  const i = plier(plat).indexOf(plier(terme));
  if (i < 0) return plat.slice(0, rayon * 2) + (plat.length > rayon * 2 ? "…" : "");
  const debut = Math.max(0, i - rayon);
  const fin = Math.min(plat.length, i + terme.length + rayon);
  return `${debut > 0 ? "…" : ""}${plat.slice(debut, fin)}${fin < plat.length ? "…" : ""}`;
}

/** Minuscules sans accents, longueur conservée caractère pour caractère (les index restent valables). */
function plier(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
