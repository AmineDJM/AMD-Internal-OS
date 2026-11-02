/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE CIBLE AMBIGUË REND DES CANDIDATS — jamais « le premier des quatre ».
 *
 * ── LE DÉFAUT MESURÉ, ET IL EST DU PIRE GENRE ───────────────────────────────────────────
 *
 * Banc des intentions courtes, cas `ambigu-ca`. Le fil :
 *
 *   PDG   — « Liste-moi les documents du registre Legal. »
 *   Adam  — (liste plusieurs documents)
 *   PDG   — « Corrige ça. »
 *   Adam  — « Je propose : ANNULER le document légal "Devis n° DEV-2026-0038 — CHU de Tizi
 *            Ouzou". Confirmez-vous ? »
 *
 * Deux fautes en une phrase. La cible a été CHOISIE parmi plusieurs sans aucune raison — le
 * PDG n'en a nommé aucune. Et « corrige » est devenu « annule » : une demande non destructive
 * s'est transformée en proposition destructive. Rien ne part sans clic ; mais un clic réflexe
 * annulait un devis.
 *
 * ── CE QUE LA DOCTRINE DIT DÉJÀ, ET QU'IL FALLAIT ÉTENDRE ───────────────────────────────
 *
 * §104.7 le pose pour les documents : « Une cible ambiguë rend des candidats. Jamais le premier
 * des quatre. Modifier le mauvais paragraphe en annonçant que c'est fait est le défaut le plus
 * coûteux de tout ce système. » La règle ne valait que pour Live Office. Elle vaut pour TOUTE
 * écriture : annuler un devis au lieu d'un autre coûte autant que corriger le mauvais
 * paragraphe.
 *
 * ── LA RÈGLE, ET POURQUOI ELLE NE BLOQUE PAS LE TRAVAIL NORMAL ──────────────────────────
 *
 * Une proposition d'écriture est REFUSÉE quand les trois conditions tiennent ensemble :
 *
 *   1. la demande est DÉICTIQUE — elle désigne sans nommer (« ça », « ce dossier », « celui-là »,
 *      « le mien ») ;
 *   2. la demande ne contient AUCUN identifiant de la cible proposée — ni sa référence, ni un
 *      mot distinctif de son intitulé ;
 *   3. le tour a vu PLUSIEURS candidats du même genre.
 *
 * Chacune seule serait trop large. « Annule DEV-2026-0455 » nomme sa cible (2 tombe). « Corrige
 * ça » après un seul document lu est sans ambiguïté (3 tombe). « Corrige la facture de
 * l'Imprimerie » nomme un mot distinctif (2 tombe). Ce qui reste est exactement le cas où
 * choisir, c'est deviner.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────────────────
 *
 * Il ne juge ni le droit (c'est le RBAC), ni l'opportunité (c'est la politique de
 * confirmation), ni le sens de l'action. Il répond à UNE question : le PDG a-t-il désigné
 * cette cible-là ? Et il ne connaît ni Prisma, ni le modèle, ni l'écran — ce qui permet de le
 * tester sans rien démarrer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une cible possible telle que le tour l'a vue passer : ce qui suffit à la nommer. */
export interface Candidat {
  /** L'étiquette lisible — « Devis n° DEV-2026-0455 — Imprimerie El Djazaïr ». */
  label: string;
  /** Le lien interne, qui sert d'identité : deux liens égaux = un seul candidat. */
  href: string;
}

/**
 * LES MOTS QUI DÉSIGNENT SANS NOMMER.
 *
 * Volontairement courts et sans ambiguïté propre. « ce » seul suffit (« ce dossier », « ce
 * devis ») ; on ne cherche pas à énumérer les tournures, on cherche le geste — pointer.
 */
const DEICTIQUES = /\b(ca|cela|ceci|celui|celle|ceux|celles|cet|cette|ces|ce)\b/;

/**
 * LES TOURNURES QUI NOMMENT MALGRÉ TOUT. « ce devis DEV-2026-0455 » est déictique ET nommé :
 * la référence tranche, et c'est la condition 2 qui s'en occupe. Rien à faire ici.
 */

/** Le texte d'une demande, débarrassé de sa ponctuation et de sa casse. */
const normaliser = (t: string): string =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * LES MOTS DISTINCTIFS d'une étiquette — ceux par lesquels une personne la désignerait.
 *
 * On garde les références (`DEV-2026-0455`), les nombres longs et les mots d'au moins quatre
 * lettres qui ne sont pas du vocabulaire de structure. « Devis », « document », « legal »
 * n'identifient rien : ils décrivent la CATÉGORIE, et c'est justement ce qui est ambigu quand
 * il y en a plusieurs.
 */
const MOTS_DE_CATEGORIE = new Set([
  "devis", "facture", "contrat", "document", "documents", "dossier", "dossiers", "bon", "commande",
  "legal", "legale", "reglementaire", "note", "lettre", "rapport", "piece", "pieces", "registre",
  "numero", "no", "n", "du", "de", "des", "le", "la", "les", "un", "une", "pour", "avec", "sur",
]);

export function motsDistinctifs(label: string): string[] {
  const n = normaliser(label);
  return [...new Set(n.split(" ").filter((m) => m.length >= 4 && !MOTS_DE_CATEGORIE.has(m)))];
}

/**
 * LA DEMANDE POINTE-T-ELLE sans nommer ?
 *
 * ON NORMALISE AVANT DE TESTER, et ce n'est pas un détail de style. `\b` en JavaScript est une
 * frontière de mot ASCII : dans « Corrige ça », le « ç » n'est pas un caractère de mot, donc
 * `\bça\b` ne trouve RIEN. La première version de ce module laissait ainsi passer le cas
 * exact qu'il existait pour attraper — et c'est le test qui l'a dit.
 */
export function estDeictique(demande: string): boolean {
  return DEICTIQUES.test(normaliser(demande));
}

/**
 * LA DEMANDE NOMME-T-ELLE CETTE CIBLE ? Vrai dès qu'un mot distinctif de l'étiquette apparaît
 * dans la demande — une référence, un nom propre, le nom d'un partenaire.
 */
export function demandeNomme(demande: string, label: string): boolean {
  const d = ` ${normaliser(demande)} `;
  return motsDistinctifs(label).some((m) => d.includes(` ${m} `));
}

/**
 * LES CANDIDATS QUE LA CONVERSATION A DÉJÀ MONTRÉS — et sans eux la règle ne se déclenche pas.
 *
 * ── CE QUE L'A/B A DIT, ET IL A DIT NON ─────────────────────────────────────────────────
 *
 * Première version : les candidats venaient des lectures DU TOUR COURANT. Mesuré au banc, règle
 * allumée, deux passages : « Annule ça » rendait toujours « Je propose : ANNULER le devis
 * DEV-2026-0038 ». La raison est simple et elle invalidait tout le dispositif — la LISTE avait
 * été produite au tour PRÉCÉDENT. Au tour où l'écriture se propose, Adam n'a souvent rien relu :
 * zéro candidat, donc « pas d'ambiguïté », donc la porte s'ouvre. La règle était juste et son
 * alimentation était vide.
 *
 * ── D'OÙ VIENNENT LES CANDIDATS MAINTENANT ──────────────────────────────────────────────
 *
 * De ce qu'Adam a MONTRÉ, c'est-à-dire de ses propres réponses précédentes :
 *
 *   • les liens internes qu'il a posés — `[Devis n° DEV-2026-0455](/legal/12)` ;
 *   • les RÉFÉRENCES nues qu'il a citées — `DEV-2026-0455`, `NDA-2026-03`, `REG-2026-9011`.
 *
 * Les deux sont des identités : deux libellés différents pointant le même lien ne font qu'un
 * candidat, et une référence est unique par construction. On ne lit pas la prose, on lit ce qui
 * est structurellement identifiant — ce qui évite d'inventer des candidats à partir de mots.
 */
const LIEN_MD = /\[([^\]]{1,120})\]\((\/[^)\s]{1,200})\)/g;
const REFERENCE = /\b([A-Z]{2,5}-\d{4}-\d{1,6})\b/g;

/** Combien de tours en arrière on regarde. Au-delà, le référent n'est plus « ça ». */
export const TOURS_REGARDES = 3;

export function candidatsMontres(
  historique: readonly { role: string; content: string }[],
  max = 40,
): Candidat[] {
  const out: Candidat[] = [];
  const vus = new Set<string>();
  // LES DEUX RÔLES. Une référence que le PDG a lui-même écrite deux tours plus tôt désigne
  // aussi bien qu'une pièce qu'Adam a montrée — et l'ignorer ferait refuser des demandes
  // parfaitement claires.
  const recents = historique.slice(-TOURS_REGARDES * 2);
  for (const t of recents) {
    for (const m of t.content.matchAll(LIEN_MD)) {
      const href = m[2]!;
      if (vus.has(href)) continue;
      vus.add(href);
      out.push({ label: m[1]!.trim(), href });
      if (out.length >= max) return out;
    }
    for (const m of t.content.matchAll(REFERENCE)) {
      const ref = m[1]!;
      if (vus.has(ref)) continue;
      vus.add(ref);
      out.push({ label: ref, href: ref });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Le verdict rendu à l'appelant : la proposition passe, ou elle devient une question. */
export type VerdictCible =
  | { designee: true }
  | { designee: false; candidats: Candidat[]; question: string };

/**
 * LA PORTE. `candidats` sont les cibles que LE TOUR a vues (les sources lues), dans l'ordre où
 * elles sont apparues.
 *
 * Rend `{ designee: true }` dans tous les cas où le PDG a désigné sa cible — ce qui est la
 * situation ordinaire. Le refus est l'exception, et il arrive avec de quoi poser une VRAIE
 * question : les candidats, nommés.
 */
/**
 * LE COUPE-CIRCUIT. Une variable, et tout repart comme avant — comme pour le routeur d'outils
 * et la garde de sortie. Il sert aussi à MESURER : sans lui, impossible de dire si un
 * changement de comportement vient de cette règle ou du non-déterminisme du modèle.
 */
export function cibleDesigneeDesactivee(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADAM_CIBLE_DESIGNEE_DISABLED === "1" || env.ADAM_CIBLE_DESIGNEE_DISABLED === "true";
}

export function verdictCible(
  demande: string,
  cible: string,
  candidats: readonly Candidat[],
  max = 6,
): VerdictCible {
  if (cibleDesigneeDesactivee()) return { designee: true };
  if (!estDeictique(demande)) return { designee: true };
  if (demandeNomme(demande, cible)) return { designee: true };

  const vus = new Set<string>();
  const distincts: Candidat[] = [];
  for (const c of candidats) {
    if (vus.has(c.href)) continue;
    vus.add(c.href);
    distincts.push(c);
  }
  /**
   * ── LA CHARGE PÈSE SUR LA DÉSIGNATION, PAS SUR LA PREUVE D'AMBIGUÏTÉ ────────────────
   *
   * Première version : on ne refusait qu'à partir de DEUX candidats connus — « moins de deux,
   * donc pas d'ambiguïté ». L'A/B avec témoin (quatre passages de chaque côté) a montré que
   * c'était faux et dangereux : les échecs restants portaient TOUS la mention « 0 candidat »,
   * alors qu'Adam proposait sans hésiter d'annuler un devis précis. Le compte à zéro ne
   * signifiait pas « une seule cible possible », il signifiait « le code n'a rien vu » — la
   * liste ayant été montrée en BLOCS, hors du texte que l'extracteur relit.
   *
   * L'absence de preuve d'ambiguïté n'est pas une preuve d'unicité. Pour une écriture, la
   * question n'est donc plus « puis-je démontrer qu'il y a plusieurs cibles ? » mais « puis-je
   * démontrer qu'il n'y en a qu'une ? ». EXACTEMENT UN candidat connu répond oui. Zéro, comme
   * plusieurs, répond non — et l'on demande.
   */
  if (distincts.length === 1) return { designee: true };
  if (distincts.length === 0) {
    return {
      designee: false,
      candidats: [],
      question:
        `Sur quoi exactement ? Votre message dit « ${demande.trim()} » sans nommer la pièce, et je ne peux pas ` +
        `établir avec certitude laquelle vous visez.\n\nJe n'ai rien modifié — donnez-moi sa référence.`,
    };
  }

  const montres = distincts.slice(0, max);
  const reste = distincts.length - montres.length;
  return {
    designee: false,
    candidats: montres,
    question:
      `Sur lequel ? Votre message dit « ${demande.trim()} » sans nommer la pièce, et j'en ai ${distincts.length} sous les yeux :\n` +
      montres.map((c) => `• ${c.label}`).join("\n") +
      (reste > 0 ? `\n• …et ${reste} autre(s).` : "") +
      `\n\nJe n'ai rien modifié — dites-moi laquelle.`,
  };
}
