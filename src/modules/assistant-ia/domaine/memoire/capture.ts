import { plier, termes } from "../selection-outils";
import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, type SorteMemoire } from "../memoire-ui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAPTURE AUTOMATIQUE DE LA MÉMOIRE (M1, décision 0045) — règle PURE.
 *
 * Après chaque tour, ce que la personne a dit D'ELLE (famille, études, voyages, goûts, habitudes, projets…) est retenu
 * d'office, visible et réversible. Trois portes, dans cet ordre — la moins chère d'abord :
 *
 *   1. LE FILTRE DÉTERMINISTE (`faitDurablePossible`) : aucun appel de modèle si le message ne porte aucun fait durable
 *      sur la personne (une question sur l'ERP, « merci », « montre-moi les demandes »). C'est lui qui rend la capture
 *      presque gratuite : la grande majorité des tours s'arrêtent ici.
 *   2. L'EXTRACTEUR (modèle rapide, entrée courte, JSON strict) : `CONSIGNE_EXTRACTEUR`, `entreeExtracteur`,
 *      `lireExtraction`.
 *   3. LA GARDE (`garderCandidat`) : un souvenir porte sur la personne et sur ce qu'ELLE a dit. Un nom propre ou un
 *      chiffre absent de son message (lu dans une réponse, donc dans l'ERP) le fait refuser ; une valeur confidentielle
 *      (salaire, prime, IBAN, matricule…) ne se retient jamais, d'elle ou d'autrui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que l'extracteur lit du message de la personne (et rien d'autre de l'échange). */
export const ENTREE_MAX_MESSAGE = 1_500;
/** Souvenirs déjà retenus montrés à l'extracteur (pour remplacer plutôt qu'ajouter). */
export const EXISTANTS_MAX = 12;
/** Souvenirs retenus au plus par tour : une conversation n'est pas un interrogatoire. */
export const CAPTURES_MAX_PAR_TOUR = 5;

/** Ce qui marque une personne qui parle d'elle (première personne, en français — et « j' » collé). */
const PREMIERE_PERSONNE = /(^|[^a-z])(je|j|moi|mon|ma|mes|nous|notre|nos|m)(?=[^a-z]|$)/;

/** Les thèmes d'un fait durable — chacun au DÉBUT d'un mot (« thèse » n'est pas dans « synthèse »). Un seul suffit. */
const THEMES = new RegExp(`(?:^| )(?:${[
  // retiens / souviens-toi — la demande explicite
  "retien", "souviens toi", "rappelle toi", "n oublie pas", "note que", "sache que",
  // identité, origine, âge, lieu de vie
  "je m appelle", "mon nom", "mon prenom", "je suis ne", "je suis nee", "j ai \\d+ ans", "j habite", "je vis", "originaire", "je viens de",
  // famille et proches
  "femme", "mari", "epouse", "epoux", "fille", "fils", "enfant", "bebe", "pere", "mere", "papa", "maman", "frere", "soeur",
  "cousin", "oncle", "tante", "neveu", "niece", "grand", "famille", "fiance", "marie", "beau pere", "belle mere", "ami",
  // études, parcours
  "etudi", "diplom", "master", "doctorat", "licence", "these", "universit", "ecole", "fac", "bac", "formation", "stage",
  "j ai travaille", "avant j", "carriere", "parcours", "promotion",
  // voyages
  "voyag", "je pars", "partir", "parti", "vacances", "sejour", "billet", "vol ", "visite", "je vais a", "je vais en",
  "je serai a", "je serai en", "je rentre", "aller a", "aller en", "deplacement", "conge",
  // goûts, loisirs
  "j aime", "j adore", "je deteste", "je prefere", "prefere", "passion", "loisir", "sport", "football", "lecture", "musique",
  "cuisine", "plat", "film", "livre", "je joue", "je fais du", "je fais de la",
  // santé (dite par la personne)
  "allergi", "diabet", "regime", "malade", "enceinte", "operation", "je ne mange", "je ne bois",
  // travail, habitudes, contraintes, projets
  "toujours", "jamais", "chaque", "tous les", "d habitude", "habitude", "je commence", "je finis", "je travaille",
  "mon poste", "mon role", "mon service", "mon equipe", "ma societe", "mon bureau", "mon manager", "mon chef", "mon assistant",
  "disponible", "indisponible", "je ne peux pas", "je ne suis pas", "projet", "je compte", "je prevois", "je veux", "j envisage",
  "objectif", "reponds moi", "tutoie", "vouvoie", "en anglais", "en arabe", "court", "concis", "detaill",
  // Direction (02/11/2026, « qu'il retienne un peu plus ») : opinions sur le travail, priorités, échéances, rendez-vous
  // datés, lieux de l'entreprise, personnes citées, vocabulaire de la personne.
  "je pense", "je trouve", "je crois", "a mon avis", "selon moi", "je suis d avis", "je suis plutot", "franchement",
  "priorit", "date limite", "deadline", "echeance", "doit etre pret", "avant le", "rendez vous", "rdv", "dentiste", "medecin",
  "notre usine", "notre siege", "nos bureaux", "notre entrepot", "notre site", "notre labo", "nos clients", "notre principal",
  "quand je dis", "j appelle", "j entends par", "je vois chaque", "je rencontre", "mon contact", "mon interlocuteur",
].join("|")})`);

/** Une demande sur l'ERP — sans fait durable, elle ne mérite pas d'appel. */
const SEULEMENT_UNE_DEMANDE = /^(montre|affiche|liste|donne|combien|quel|quelle|quels|quelles|ou en est|cherche|trouve|ouvre|prepare|cree|envoie|exporte|resume|traduis|analyse|lis)\b/;

/**
 * LE FILTRE DÉTERMINISTE : `true` si le message PEUT porter un fait durable sur la personne. Faux positifs permis (le
 * modèle rendra une liste vide), faux négatifs à éviter sur les thèmes de vie.
 */
export function faitDurablePossible(message: string): boolean {
  const t = plier(sansEntete(message)).replace(/'/g, " ");
  if (t.length < 12) return false;
  if (/(^| )(retien|souviens toi|rappelle toi|n oublie pas)/.test(t)) return true;
  // « Tu te souviens de mon voyage ? » interroge la mémoire, il ne lui apprend rien.
  if (/^(tu te souviens|te souviens tu|tu te rappelles|te rappelles tu|est ce que tu (te souviens|sais|connais)|tu sais (ou|quand|qui|comment))\b/.test(t) && t.length < 140) return false;
  if (!PREMIERE_PERSONNE.test(t)) return false;
  // Une demande courte sur l'ERP, sans thème de vie : rien à retenir.
  if (SEULEMENT_UNE_DEMANDE.test(t) && t.length < 120 && !THEMES.test(t.replace(SEULEMENT_UNE_DEMANDE, ""))) return false;
  return THEMES.test(t);
}

/** L'en-tête technique d'un message vocal (« [Conversation vocale — transcription] ») n'est pas la parole. */
export function sansEntete(message: string): string {
  return message.replace(/^\s*\[(Conversation vocale|Message vocal)[^\]]*\]\s*/i, "").trim();
}

export const CONSIGNE_EXTRACTEUR = [
  "Tu es la mémoire d'un assistant. Tu lis UN échange et tu extrais les faits DURABLES que la PERSONNE dit d'ELLE-MÊME :",
  "identité, famille (prénoms, liens), études et parcours, voyages (passés ou prévus, avec leurs dates), goûts et loisirs,",
  "santé qu'elle déclare elle-même, projets, habitudes et contraintes de travail, sa société et son rôle, les personnes qu'elle",
  "cite (prénom + lien ou rôle), les lieux qu'elle cite (sites, villes), ses objectifs et priorités, ses échéances et",
  "rendez-vous datés, ses opinions sur des sujets de travail récurrents, ses préférences de réponse, son vocabulaire.",
  "Dans le doute sur un fait qui l'aidera dans les semaines à venir (une priorité, une échéance, un avis tranché), RETIENS-LE.",
  "RÈGLES :",
  "- Seulement ce que la PERSONNE a écrit ou dit. Jamais une donnée de l'entreprise.",
  "- Jamais une rémunération, une prime, un salaire, une coordonnée bancaire, un numéro de pièce d'identité, un mot de passe,",
  "  ni une donnée confidentielle sur une AUTRE personne (sa santé, son salaire, son évaluation).",
  "- Rien de passager ni de bavardage (« je suis fatigué aujourd'hui », « merci », « réponds à ce mail », une question,",
  "  ce qu'elle a mangé), rien de déjà connu à l'identique.",
  "- Chaque fait : une phrase courte, autonome, SANS pronom ni genre supposé (jamais « il » ni « elle ») — commence par le",
  "  verbe ou le sujet du fait : « Part à Lyon le 12 novembre 2026 avec sa fille Lina », « Fille : Lina », « A étudié à… ».",
  "  Dates en clair. Ne déduis rien qui n'est pas dit. Son nom (donné ci-dessus) est déjà connu : ne le retiens pas.",
  "- Si un fait CHANGE un souvenir déjà connu (liste « Déjà retenu »), donne `remplace` = son identifiant (m1, m2…) et la",
  "  phrase complète à jour. Deux faits proches se FUSIONNENT en une phrase.",
  "- `sujet` : une clé courte et stable, minuscules (« voyage:lyon », « famille:fille », « etudes:master », « gout:cafe »).",
  "SORTES : PERSONNEL_IDENTITE, FAMILLE, ETUDES_PARCOURS, SANTE_DECLAREE, VOYAGES, GOUTS_LOISIRS, PROJETS,",
  "ORGANIZATIONAL_CONTEXT, WORKING_STYLE, CONTRAINTES, PERSONNES_CITEES, USER_PREFERENCE, ENTITY_ALIAS, TERMINOLOGY.",
  "RÉPONDS UNIQUEMENT en JSON, sans texte autour :",
  "{\"souvenirs\":[{\"sorte\":\"VOYAGES\",\"contenu\":\"…\",\"sujet\":\"voyage:lyon\",\"remplace\":null}]}",
  "Aucun fait durable : {\"souvenirs\":[]}",
].join("\n");

export interface SouvenirConnu {
  /** Identifiant COURT montré à l'extracteur (m1…) ; l'appelant garde la correspondance. */
  cle: string;
  contenu: string;
}

/**
 * L'entrée de l'extracteur : courte, bornée, la date du jour pour situer « le 12 » et « l'été prochain ». La RÉPONSE de
 * l'assistant n'y entre pas : un souvenir vient des mots de la personne, et une réponse porte des données de l'ERP (un
 * salaire lu pour elle, un tiers) qui n'ont rien à faire chez l'extracteur.
 */
export function entreeExtracteur(p: { message: string; existants: readonly SouvenirConnu[]; aujourdhui: string; nom?: string | null }): string {
  const lignes = [`Aujourd'hui : ${p.aujourdhui}.`];
  if (p.nom) lignes.push(`(Contexte, à ne PAS retenir : le compte est celui de ${p.nom}.)`);
  if (p.existants.length) lignes.push("Déjà retenu :", ...p.existants.slice(0, EXISTANTS_MAX).map((e) => `${e.cle}. ${e.contenu}`));
  lignes.push("", `PERSONNE : ${sansEntete(p.message).slice(0, ENTREE_MAX_MESSAGE)}`);
  return lignes.join("\n");
}

export interface Candidat {
  sorte: SorteMemoire;
  contenu: string;
  sujet: string | null;
  /** La clé courte (m1…) d'un souvenir connu que celui-ci remplace. */
  remplace: string | null;
}

/** Lit la sortie de l'extracteur — JSON strict, tolérant aux balises ```json. Une sortie illisible = aucun souvenir. */
export function lireExtraction(brut: string): Candidat[] {
  const texte = brut.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const debut = texte.indexOf("{");
  const fin = texte.lastIndexOf("}");
  if (debut < 0 || fin <= debut) return [];
  let lu: unknown;
  try { lu = JSON.parse(texte.slice(debut, fin + 1)); } catch { return []; }
  const liste = (lu as { souvenirs?: unknown })?.souvenirs;
  if (!Array.isArray(liste)) return [];
  const out: Candidat[] = [];
  for (const s of liste) {
    const o = s as Record<string, unknown>;
    const contenu = typeof o?.contenu === "string" ? o.contenu.replace(/\s+/g, " ").trim() : "";
    if (!contenu || contenu.length > MEMOIRE_MAX_CARACTERES || !estSorteMemoire(o.sorte)) continue;
    out.push({
      sorte: o.sorte,
      contenu,
      sujet: normaliserSujet(o.sujet),
      remplace: typeof o.remplace === "string" && /^m\d{1,3}$/.test(o.remplace) ? o.remplace : null,
    });
    if (out.length >= CAPTURES_MAX_PAR_TOUR) break;
  }
  return out;
}

/** « Voyage : Lyon » → « voyage:lyon » ; vide → null. */
export function normaliserSujet(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.split(":").map((p) => plier(p).replace(/\s+/g, "-")).filter(Boolean).join(":").slice(0, 60);
  return s || null;
}

/** Ce qui ne se retient jamais — de la personne comme d'autrui (le filtre de confidentialité s'y ajoute). */
const CONFIDENTIEL = /\b(salair|remuner|prime|paie|bulletin|iban|rib|ccp|bic|swift|matricul|passeport|carte d identite|cni|mot de passe|code pin|numero de compte|evaluation annuelle|sanction|licenci)/;

/** Les mots d'une phrase qui doivent venir du message : chiffres, et noms propres hors début de phrase. */
function ancres(contenu: string): string[] {
  const out: string[] = [];
  const mots = contenu.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  mots.forEach((m, i) => {
    if (/\d/.test(m)) out.push(m.replace(/\D/g, ""));
    else if (i > 0 && /^\p{Lu}/u.test(m) && m.length > 1) out.push(plier(m));
  });
  return out.filter(Boolean);
}

/** Les noms de mois et de jours écrits en toutes lettres par le modèle (« le 12 novembre ») ne sont pas des ancres. */
const CALENDRIER = new Set("janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre lundi mardi mercredi jeudi vendredi samedi dimanche".split(" "));

export type VerdictGarde = { ok: true } | { ok: false; raison: string };

/**
 * LA GARDE : le souvenir porte sur ce que la PERSONNE a dit. Une ancre (chiffre, nom propre) absente de son message vient
 * d'ailleurs (la réponse, donc l'ERP) : refusé. L'année que le modèle ajoute à une date dite sans elle est tolérée.
 */
export function garderCandidat(c: Pick<Candidat, "contenu">, message: string, p: { nom?: string | null; aujourdhui?: Date } = {}): VerdictGarde {
  const plie = plier(c.contenu).replace(/'/g, " ");
  if (CONFIDENTIEL.test(plie)) return { ok: false, raison: "confidentiel" };
  // Son nom est celui du compte : « S'appelle Yacine Benali » n'apprend rien (le contexte le dit déjà).
  const nomPlie = plier(p.nom ?? "");
  if (nomPlie && plie.includes(nomPlie) && plie.replace(nomPlie, "").replace(/\b(s appelle|il|elle|est|se nomme|nom|son|prenom|la personne|personne|utilisateur|la|le|l)\b/g, "").trim().length < 4) {
    return { ok: false, raison: "son nom, déjà connu" };
  }
  const source = ` ${plier(sansEntete(message))} `;
  const chiffresSource = sansEntete(message).replace(/\D+/g, " ");
  const nom = new Set(termes(p.nom ?? "").concat(plier(p.nom ?? "").split(" ")));
  const annee = (p.aujourdhui ?? new Date()).getUTCFullYear();
  for (const a of ancres(c.contenu)) {
    if (/^\d+$/.test(a)) {
      if (` ${chiffresSource} `.includes(` ${a} `) || a === String(annee) || a === String(annee + 1)) continue;
      return { ok: false, raison: `chiffre « ${a} » absent du message` };
    }
    if (CALENDRIER.has(a) || nom.has(a)) continue;
    if (!source.includes(` ${a} `) && !source.includes(` ${a.slice(0, Math.max(4, a.length - 2))}`)) return { ok: false, raison: `« ${a} » absent du message` };
  }
  return { ok: true };
}

/** Deux souvenirs disent-ils la même chose ? Racines partagées (Jaccard) — « Sa fille s'appelle Lina » ≈ « Sa fille est Lina ». */
export function similarite(a: string, b: string): number {
  const x = new Set(termes(a));
  const y = new Set(termes(b));
  if (!x.size || !y.size) return 0;
  const communs = [...x].filter((m) => y.has(m)).length;
  return communs / (x.size + y.size - communs);
}

/** Au-delà, c'est un doublon : rien n'est écrit. */
export const SEUIL_DOUBLON = 0.8;
