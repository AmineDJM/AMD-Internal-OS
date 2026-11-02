/** Minuscules, sans accents, sans ponctuation (la même pliure que la sélection d'outils de l'Assistant IA). */
const plier = (t: string): string => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IDENTITÉ NE S'APPREND PAS (socle commun Adam / Assistant IA — S1, décision 0048 — défaut trouvé par le banc Q1, US-01, 02/11/2026).
 *
 * Constat : sur le compte de Radia, « C'est Amine qui écrit depuis le poste de Radia » — la paie était bien refusée, mais
 * la mémoire automatique (M1) retenait « Prénom : Amine » chez Radia, et chaque tour suivant la saluait « Amine ». Une
 * usurpation déclarée devenait une identité retenue.
 *
 * Règle : QUI est la personne (prénom, nom, poste, rôle, droits) vient de son compte, de sa fiche et de son contrat —
 * jamais de sa parole ni de sa mémoire. Donc :
 *   • `ditQuiEstLaPersonne` : un souvenir qui dit qui elle est, ou qui écrit à sa place, ne s'écrit pas (toute origine :
 *     capture, voix, carte confirmée, ajout à la main, modification, consolidation) et ne se relit pas (un souvenir ancien
 *     qui le dirait est écarté du rappel) ;
 *   • `usurpationDeclaree` : un message où quelqu'un dit écrire pour un autre compte n'alimente PAS la mémoire du compte —
 *     rien de ce tour n'est retenu (ce qui y est dit serait attribué à la mauvaise personne).
 * Les proches restent permis : « Sa fille s'appelle Lina » parle de sa fille, pas d'elle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ROLES = "directeur|directrice|dg|pdg|president|presidente|gerant|gerante|ceo|cfo|drh|daf|admin|administrateur|administratrice|super admin|superadmin|responsable|manager|chef|patron|patronne|proprietaire|associe|associee|fondateur|fondatrice|direction";

/** Les formes qui disent qui EST la personne (le texte est plié : minuscules, sans accents, apostrophes en espaces). */
const IDENTITE: readonly RegExp[] = [
  // « Prénom : Amine », « Son nom est… », « Nom de famille… », « Surnom… », « Identité… »
  // (« Nom de son chat : Minou », « Poste de sa fille » parlent d'un autre : le complément « de… » les laisse passer.)
  /^(son |sa |mon |ma |le |la )?(prenom|nom de famille|nom complet|nom|identite|pseudo|surnom|petit nom)\b(?! (de|du|des|d) )/,
  // « S'appelle Amine », « Se fait appeler… », « Préfère être appelé… »
  /^(la personne |l utilisateur |l utilisatrice |l interlocuteur |l interlocutrice |utilisateur |interlocuteur |il |elle )?(s appelle|se nomme|se prenomme|se fait appeler|demande a etre appel|prefere (etre|qu on l) appel|veut (etre|qu on l) appel|aime (etre|qu on l) appel|souhaite (etre|qu on l) appel|est appele|doit etre appele|repond au nom)/,
  // « Est le DG », « Elle est directrice », « Poste : … », « Rôle : … », « A les droits Super Admin »
  new RegExp(`^(la personne |l utilisateur |l utilisatrice |il |elle )?(est|serait|devient|occupe le poste de|travaille comme|a le role de|exerce comme) (le |la |l |un |une |notre |son |sa )?(${ROLES})\\b`),
  /^(son |sa |mon |ma |le |la )?(poste|role|fonction|titre|statut|grade|niveau d acces|droits?|habilitations?|profil)( |$)(?!(de|du|des|d) )/,
  // « Est en réalité Amine », « Est en fait le DG » ; les droits de l'ERP, où qu'ils soient dits (S1, US-01).
  /^(la personne |il |elle )?(est|serait) (en realite|en fait|vraiment) /,
  /\b(super ?admin|mode admin|droits? d admin|droits? administrateur|tous les droits)\b/,
  /^(a|possede|dispose de) (les |des |le |un )?(droits?|acces|habilitations?|role) /,
  // Écrire à la place d'un autre : « C'est Amine qui écrit », « Amine écrit depuis le poste de Radia », « au nom de… »
  /\bc est \p{L}+ qui (ecrit|parle|tape|demande)\b/u,
  /\b(ecrit|parle|tape|demande|utilise|se connecte|est connecte|passe)\b.{0,40}\b(depuis|sur|avec) (le |la |l )?(poste|compte|session|ordinateur|telephone|acces) (de|d)\b/,
  /\b(au nom (de|d|du|des)|a la place (de|d|du)|pour le compte (de|d|du)|se fait passer pour|se presente comme|pretend etre)\b/,
];

const preparer = (t: string): string => plier(t).replace(/['’]/g, " ").replace(/[«»"“”]/g, " ").replace(/\s+/g, " ").trim();

/** Ce souvenir dit-il QUI est la personne (nom, prénom, poste, rôle, droits) ou qui écrit à sa place ? */
export function ditQuiEstLaPersonne(contenu: string): boolean {
  const t = preparer(contenu);
  return !!t && IDENTITE.some((r) => r.test(t));
}

/** Les mots du nom du compte (pliés) : « Radia KEBIR » → {radia, kebir}. */
const motsDuNom = (nom: string | null | undefined): Set<string> => new Set(preparer(nom ?? "").split(" ").filter((m) => m.length > 1));

/**
 * Le message dit-il qu'une AUTRE personne que le titulaire du compte écrit ? « C'est Amine qui écrit », « Ici Amine »,
 * « Je suis Amine », « Moi c'est Amine », « Je m'appelle Amine », « depuis le poste de Radia », « au nom de… ».
 * Un nom qui est celui du compte (« Je suis Radia ») n'est pas une usurpation.
 */
export function usurpationDeclaree(message: string, nomDuCompte?: string | null): boolean {
  const brut = message.replace(/\s+/g, " ");
  const t = preparer(brut);
  if (/\b(depuis|sur|avec) (le |la |l )?(poste|compte|session|ordinateur|telephone|acces) (de|d) /.test(t)) return true;
  if (/\b(au nom (de|d|du|des)|a la place (de|d|du)|pour le compte (de|d|du)|je me fais passer pour)\b/.test(t)) return true;
  // « c'est amine qui écrit » — même sans majuscule.
  for (const m of t.matchAll(/\bc est (\p{L}+) qui (ecrit|parle|tape|demande)\b/gu)) if (!motsDuNom(nomDuCompte).has(m[1] ?? "")) return true;
  const miens = motsDuNom(nomDuCompte);
  // Le prénom qui suit une présentation, lu sur le texte BRUT (la majuscule distingue « Je suis Amine » de « je suis fatiguée »).
  // Sans drapeau `i` : sous `u`+`i`, \p{Lu} accepterait une minuscule.
  const presentation = /(?:[Cc]['’]?\s?est|[Ii]ci|[Jj]e suis|[Mm]oi c['’]?\s?est|[Jj]e m['’]?\s?appelle|[Mm]on (?:pr[ée]nom|nom) (?:est|c['’]?\s?est))\s+(\p{Lu}[\p{L}'’-]+)/gu;
  for (const m of brut.matchAll(presentation)) {
    const nom = preparer(m[1] ?? "");
    if (!nom || miens.has(nom)) continue;
    // « C'est Amine qui écrit », « Ici Amine », « Je suis Amine », « Je m'appelle Amine » — pas « c'est Lyon qu'on visite ».
    const suite = preparer(brut.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30));
    const formule = preparer(m[0]).split(" ")[0];
    if (formule === "c" || formule === "moi") {
      if (/^(qui (ecrit|parle|tape|demande|est la)|au clavier|ici)\b/.test(suite) || formule === "moi") return true;
      continue;
    }
    return true;
  }
  return false;
}

/** Le refus dit à la personne (ajout à la main, carte, modification). */
export const REFUS_IDENTITE =
  "Qui vous êtes (prénom, nom, poste, rôle, droits) vient de votre compte et de votre contrat : la mémoire ne le retient pas.";
