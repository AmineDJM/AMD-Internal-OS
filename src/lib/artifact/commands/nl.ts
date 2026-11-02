/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉCODEUR DIRECT (§30, §57-58, §98) — les phrases qui n'ont pas besoin d'un modèle.
 *
 * ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────────────────
 *
 * « Centre le titre. » « Un peu plus à gauche. » « Encore. » « Supprime la page 12. » Ces
 * phrases-là sont SANS AMBIGUÏTÉ. Les envoyer à un modèle coûterait une seconde d'attente et
 * quelques milliers de jetons pour retrouver ce qu'une expression régulière trouve en zéro.
 * §30 le demande explicitement, et §29 fixe une cible de moins d'une seconde qu'un aller-retour
 * modèle ne tiendrait pas.
 *
 * ── LA RÈGLE QUI ÉVITE LE PIÈGE ─────────────────────────────────────────────────────────
 *
 * Ce décodeur ne devine JAMAIS. Il ne rend une commande que sur un motif à haute confiance, et
 * rend `null` pour tout le reste — auquel cas le modèle prend la main. Un décodeur qui
 * essaierait de « comprendre à peu près » ferait pire que rien : il attraperait des phrases
 * qu'il comprend mal, en silence, alors que le modèle les aurait bien traitées.
 *
 * ── LES COMMANDES RELATIVES (§57) ───────────────────────────────────────────────────────
 *
 * « Un peu plus à gauche » n'a de sens que par rapport à quelque chose : la DERNIÈRE cible
 * touchée. Elle vient du working set de la session, pas d'une mémoire du décodeur — c'est ce qui
 * fait que « encore » marche après un rechargement de page.
 *
 * Module PUR : aucune lecture de fichier, aucun accès base. Il traverse la frontière client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import { normaliserTexte } from "@/lib/artifact/object-model/text";
import type { CommandeArtefact, Cible } from "@/lib/artifact/commands/ir";
import { lireDistanceCm, lireInterligne, sansMesures } from "@/lib/artifact/commands/quantites";
import { CIBLE_VIDE, cibleId, cibleIndex, cibleRole, commande } from "@/lib/artifact/commands/ir";

/** Ce que le décodeur sait du contexte : où la personne regarde, ce qu'elle vient de toucher. */
export interface ContexteDecodage {
  format: ArtifactFormat;
  /** Identifiants touchés par la dernière commande — la cible de « encore », « plus à gauche ». */
  derniereCible: string[];
  activePage: number | null;
  activeSlide: number | null;
  activeSheet: string | null;
}

export type IntentionDirecte =
  | { genre: "commandes"; commandes: CommandeArtefact[] }
  | { genre: "annuler" }
  | { genre: "retablir" }
  | { genre: "sauvegarder"; sousLeNom: string | null }
  | { genre: "comparer"; depuis: number | null }
  | { genre: "fermer" };

/** Un « petit » pas : ce que veut dire « un peu ». Un demi-centimètre se voit sans surprendre. */
const PAS_PETIT_CM = 0.5;
const PAS_NORMAL_CM = 1.5;
const PAS_GRAND_CM = 3;

/** Combien de points d'espacement « remonter un peu » retire. */
const PAS_ESPACEMENT_PT = 6;

/**
 * Les rangs écrits en toutes lettres.
 *
 * « UN » ET « UNE » N'Y SONT PAS, et c'est le fruit d'un test qui a échoué : dans « supprime UN
 * paragraphe », « un » est un article indéfini, pas le nombre 1. Les y laisser faisait supprimer
 * le PREMIER paragraphe sur une phrase qui ne désignait rien. « Premier » couvre le rang 1 sans
 * cette ambiguïté, et « supprime le paragraphe un » ne se dit pas.
 */
const NOMBRES_ECRITS: Record<string, number> = {
  premier: 1, premiere: 1, première: 1,
  deuxieme: 2, deuxième: 2, second: 2, seconde: 2, deux: 2,
  troisieme: 3, troisième: 3, trois: 3,
  quatrieme: 4, quatrième: 4, quatre: 4,
  cinquieme: 5, cinquième: 5, cinq: 5,
  sixieme: 6, sixième: 6, six: 6,
  septieme: 7, septième: 7, sept: 7,
  huitieme: 8, huitième: 8, huit: 8,
  neuvieme: 9, neuvième: 9, neuf: 9,
  dixieme: 10, dixième: 10, dix: 10,
  dernier: -1, derniere: -1, dernière: -1,
};

/**
 * « le troisième », « le 3ᵉ », « 12 » → 3, 3, 12. `null` quand rien n'est dit.
 *
 * LES MESURES SONT RETIRÉES D'ABORD. « décale le paragraphe 3 de 1,2 cm » donnait 1 — le
 * chiffre des unités de la distance — et déplaçait donc le paragraphe 1 en annonçant que
 * c'était fait. La mauvaise cible annoncée comme faite est le défaut le plus coûteux de tout
 * ce système (§104.7).
 */
function rang(phrase: string): number | null {
  const chiffres = /\b(\d{1,4})\b/.exec(sansMesures(phrase));
  if (chiffres) return Number(chiffres[1]);
  for (const [mot, n] of Object.entries(NOMBRES_ECRITS)) {
    if (new RegExp(`\\b${mot}\\b`).test(phrase)) return n;
  }
  return null;
}

/**
 * LE MOT VISÉ À L'INTÉRIEUR DE LA CIBLE — « uniquement le troisième mot », « le dernier mot ».
 *
 * `null` quand la phrase ne parle pas d'un mot : la mise en forme porte alors sur toute la
 * cible, comme avant. Attraper un « mot » qu'on comprend mal serait PIRE que ne rien attraper
 * (§104.5) — on n'accepte donc que « le Nᵉ mot » et « le dernier mot », rien d'autre.
 */
function motVise(p: string): number | null {
  if (!/\bmots?\b/.test(p)) return null;
  if (/\b(dernier|derniere|dernière)\s+mots?\b/.test(p)) return -1;
  const avant = /([\wéèêàûîôç]+)\s+mots?\b/i.exec(sansMesures(p));
  if (!avant) return null;
  const n = rang(avant[1]!);
  return n !== null && n >= 1 && n <= 500 ? n : null;
}

/**
 * L'amplitude demandée, en centimètres.
 *
 * UNE MESURE ÉCRITE L'EMPORTE TOUJOURS. « décale de 1,2 cm » vaut 1,2 cm, pas « un pas
 * normal » : une édition de précision qui arrondit n'est pas une édition de précision. Les
 * mots d'amplitude ne servent que lorsque la personne n'a PAS chiffré.
 */
function amplitude(p: string): number {
  const mesure = lireDistanceCm(p);
  if (mesure !== null) return mesure;
  if (/\b(beaucoup|nettement|franchement|bien plus|largement)\b/.test(p)) return PAS_GRAND_CM;
  if (/\b(un peu|legerement|légèrement|un chouia|un poil|petit peu)\b/.test(p)) return PAS_PETIT_CM;
  return PAS_NORMAL_CM;
}

/** La cible : d'abord ce qui est nommé dans la phrase, sinon la dernière touchée. */
function cibleDe(p: string, ctx: ContexteDecodage): Cible {
  if (/\b(titre|entete|en-tete|en-tête)\b/.test(p)) return cibleRole("titre");
  const n = rang(p);
  if (n !== null && /\b(paragraphe|alinea|alinéa|ligne|bloc)\b/.test(p)) {
    return n === -1 ? cibleRole("dernier") : cibleIndex(n);
  }
  if (ctx.derniereCible.length === 1) return cibleId(ctx.derniereCible[0]);
  if (/\b(le|la|l')\s*(dernier|derniere|dernière)\b/.test(p)) return cibleRole("dernier");
  return { ...CIBLE_VIDE };
}

/** Toutes les pages citées : « les pages 12, 14 et 18 », « pages 3 à 7 ». */
export function pagesCitees(phrase: string): number[] {
  const p = normaliserTexte(phrase);
  const pages = new Set<number>();
  // Les intervalles D'ABORD : sans cela, « 3 à 7 » ne donnerait que 3 et 7.
  for (const m of p.matchAll(/(\d{1,4})\s*(?:a|à|-|jusqu'a|jusqu'à)\s*(\d{1,4})/g)) {
    const de = Number(m[1]);
    const vers = Number(m[2]);
    if (de >= 1 && vers >= de && vers - de < 2000) for (let k = de; k <= vers; k += 1) pages.add(k);
  }
  const sansIntervalles = p.replace(/(\d{1,4})\s*(?:a|à|-|jusqu'a|jusqu'à)\s*(\d{1,4})/g, " ");
  for (const m of sansIntervalles.matchAll(/\b(\d{1,4})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * DÉCODE une phrase. Rend `null` dès qu'il y a le moindre doute — le modèle prendra la main.
 */
export function decoder(phrase: string, ctx: ContexteDecodage): IntentionDirecte | null {
  const p = normaliserTexte(phrase);
  if (!p) return null;

  // ── Les gestes de session ────────────────────────────────────────────────────────────
  //
  // Chacun est ancré des DEUX côtés. « Refais » seul veut dire « rétablis » ; « refais-moi ce
  // contrat dans un style plus formel » est une réécriture, que seul le modèle sait traiter.
  // Sans l'ancre de fin, le décodeur attrapait la seconde et rétablissait une modification que
  // personne n'avait annulée — un défaut trouvé par un test, pas en relecture.
  const fin = "(?:\\s*(?:s'il te plait|s'il te plaît|stp|merci))?\\s*[.!]?$";
  if (new RegExp(`^(?:finalement\\s+)?(?:annule|annuler|reviens en arriere|retour arriere|undo|defais|défais)(?:\\s+(?:la\\s+)?(?:derniere|dernière)(?:\\s+\\w+)?|\\s*(?:ca|ça|le|la))?${fin}`).test(p)) {
    return { genre: "annuler" };
  }
  if (new RegExp(`^(?:retablis|rétablis|refais|redo|remets)(?:\\s*(?:le|la|ca|ça))?${fin}`).test(p)) {
    return { genre: "retablir" };
  }
  if (new RegExp(`^(?:ferme|fermer|referme)(?:\\s+(?:le|la|ce)?\\s*documents?)?${fin}`).test(p)) {
    return { genre: "fermer" };
  }
  /**
   * « QU'EST-CE QUE TU AS CHANGÉ ? » (§52) — une QUESTION, pas une commande.
   *
   * Elle est décodée ici plutôt que laissée au modèle pour une raison de fond : le modèle
   * répondrait de mémoire, à partir de ce qu'il croit avoir fait. Or c'est exactement la
   * question à laquelle il ne faut PAS répondre de mémoire — on la pose justement quand on
   * doute. La réponse doit venir d'une comparaison de deux états réels.
   *
   * « par rapport à la v3 » fixe l'autre borne ; sans elle, on compare à la version sur
   * laquelle le document a été ouvert.
   */
  // `T` = le trait d'union OU l'espace. `normaliserTexte` retire les accents mais GARDE les
  // traits d'union — « qu'est-ce », « montre-moi », « dis-moi » s'écrivent ainsi et sont la
  // façon normale de poser la question. Les oublier renvoyait la phrase au modèle, ce qui est
  // précisément ce qu'on veut éviter ici.
  const T = "[-\\s]";
  if (new RegExp(
    `^(?:qu'?est${T}ce que tu as (?:change|modifie)|qu'?as${T}tu (?:change|modifie)`
    + `|tu as (?:change|modifie) quoi|quels? (?:sont les )?changements`
    + `|(?:montre|dis)${T}(?:moi )?(?:les|tes) (?:changements|modifications)|compare)\\b`,
  ).test(p)) {
    const v = /\bv(?:ersion)?\s*(\d{1,4})\b/.exec(p);
    return { genre: "comparer", depuis: v ? Number(v[1]) : null };
  }
  if (/^(?:(?:ok|c'est bon|parfait)[ ,.]*)?(?:sauvegarde|enregistre|sauve|save)\b/.test(p)) {
    const sous = /(?:sous|en tant que|sous le nom (?:de )?)\s+(.+)$/.exec(phrase.trim());
    // On ne retire QUE la ponctuation de fin de phrase et les guillemets : un `.replace` global
    // des points effaçait le point de l'extension et rendait « Contrat v2.docx » en « v2docx ».
    return { genre: "sauvegarder", sousLeNom: sous ? sous[1].replace(/[«»"]/g, "").replace(/[.,;!?]+$/, "").trim() : null };
  }

  // ── PDF : les pages ──────────────────────────────────────────────────────────────────
  if (ctx.format === "PDF") {
    if (/\b(supprime|supprimer|enleve|enlève|retire|efface|vire)\b/.test(p) && /\bpages?\b/.test(p)) {
      const pages = pagesCitees(p);
      if (pages.length === 0) return null;
      return { genre: "commandes", commandes: [commande("pdf.supprimer_pages", { pages })] };
    }
    if (/\b(pivote|tourne|fais pivoter|rotation)\b/.test(p)) {
      const pages = pagesCitees(p).filter((n) => n !== 90 && n !== 180 && n !== 270);
      const deg = /\b270\b/.test(p) ? 270 : /\b180\b/.test(p) ? 180 : 90;
      const cibles = pages.length ? pages : (ctx.activePage ? [ctx.activePage] : []);
      if (cibles.length === 0) return null;
      return { genre: "commandes", commandes: [commande("pdf.pivoter", { pages: cibles, degres: deg })] };
    }
    return null;
  }

  // ── Word : le cœur du dialogue de référence ──────────────────────────────────────────
  if (ctx.format === "DOCX") {
    if (/\b(centre|centrer|au centre|au milieu)\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.align", { cible: cibleDe(p, ctx), alignement: "center" })] };
    }
    if (/\bjustifie\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.align", { cible: cibleDe(p, ctx), alignement: "justify" })] };
    }
    // « le titre un peu plus à gauche » — un RETRAIT, pas un alignement : la personne veut
    // décaler, pas coller au bord. Aligner à gauche donnerait un saut brutal au lieu d'un pas.
    if (/\bplus (a |à )?(gauche|droite)\b/.test(p) || /\b(decale|décale|deplace|déplace)\b.*\b(gauche|droite)\b/.test(p)) {
      const versGauche = /gauche/.test(p);
      const pas = amplitude(p);
      return {
        genre: "commandes",
        commandes: [commande("docx.retrait", { cible: cibleDe(p, ctx), gaucheCm: versGauche ? -pas : pas })],
      };
    }
    if (/\b(aligne|alignement)\b.*\b(a gauche|à gauche)\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.align", { cible: cibleDe(p, ctx), alignement: "left" })] };
    }
    if (/\b(aligne|alignement)\b.*\b(a droite|à droite)\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.align", { cible: cibleDe(p, ctx), alignement: "right" })] };
    }
    // « augmente l'interligne de ce paragraphe », « interligne 1,5 », « double interligne ».
    // AVANT « remonte / descends » : sans cela, « augmente l'interligne » n'était rien, et la
    // personne obtenait de l'air AUTOUR du paragraphe au lieu d'en avoir ENTRE ses lignes.
    {
      const inter = lireInterligne(p);
      if (inter !== null) {
        return { genre: "commandes", commandes: [commande("docx.interligne", { cible: cibleDe(p, ctx), interligne: inter })] };
      }
    }
    // « remonte un peu le tableau » / « descends-le »
    if (/\b(remonte|remonter|monte|fais remonter)\b/.test(p) || /\b(descends|descendre|baisse)\b/.test(p)) {
      const remonte = /\b(remonte|remonter|monte|fais remonter)\b/.test(p);
      const cible = /\btableau\b/.test(p) ? { ...CIBLE_VIDE, contient: null, index: rang(p) ?? 1 } : cibleDe(p, ctx);
      if (/\btableau\b/.test(p)) {
        // Un tableau ne se « remonte » pas par l'espacement : on le déplace d'un cran.
        return { genre: "commandes", commandes: [commande("docx.deplacer", { cible, direction: remonte ? "haut" : "bas", pas: 1 })] };
      }
      const delta = amplitude(p) === PAS_PETIT_CM ? PAS_ESPACEMENT_PT : PAS_ESPACEMENT_PT * 2;
      return {
        genre: "commandes",
        commandes: [commande("docx.espacement", { cible, avantPt: remonte ? 0 : delta, apresPt: null })],
      };
    }
    if (/\b(supprime|supprimer|enleve|enlève|retire|efface)\b/.test(p) && /\b(paragraphe|alinea|alinéa)\b/.test(p)) {
      const n = rang(p);
      if (n === null) return null;
      return {
        genre: "commandes",
        commandes: [commande("docx.supprimer_paragraphe", { cible: n === -1 ? cibleRole("dernier") : cibleIndex(n) })],
      };
    }
    // « réduis-le à 16 », « mets-le en 14 », « passe le titre à 20 »
    const taille = /\b(?:a|à|en|de)\s*(\d{1,3})\s*(?:pt|points?)?\b/.exec(p);
    /**
     * « UNIQUEMENT LE TROISIÈME MOT EN ARIAL 10 » — police ET taille, sur CE mot seulement.
     *
     * Avant, la phrase tombait sur la règle de police ou celle de taille, qui repeignaient tout
     * le paragraphe : quarante mots changés pour un mot demandé, et la personne ne s'en
     * apercevait qu'en relisant. L'empreinte réelle ne dépasse jamais l'empreinte demandée
     * (§118.16) — ici sur l'axe de la PROFONDEUR : un mot < un paragraphe.
     */
    {
      const mot = motVise(p);
      if (mot !== null) {
        const nomPolice = /\b(?:en|police)\s+([A-Z][A-Za-zÀ-ÿ]{2,}(?:\s+[A-Z][A-Za-zÀ-ÿ]*){0,2})/.exec(phrase);
        /**
         * « EN ARIAL 10 » : le nombre suit le NOM DE POLICE, pas « en » ou « à ». La règle
         * générale de taille (`\ben\s*(\d+)`) ne le voyait donc pas, et le mot sortait à la
         * bonne police mais à la taille d'avant — une demande à moitié faite, annoncée entière.
         */
        const apresPolice = nomPolice ? /(\d{1,3})\s*(?:pt|points?)?\s*$/.exec(phrase.trim()) : null;
        const pt = taille ? Number(taille[1]) : apresPolice ? Number(apresPolice[1]) : null;
        const rendu = {
          cible: { ...cibleDe(p, ctx), mot },
          ...(nomPolice ? { police: nomPolice[1]!.trim() } : {}),
          ...(pt !== null && pt >= 4 && pt <= 200 ? { taillePt: pt } : {}),
          ...(/\b(gras)\b/.test(p) ? { gras: true } : {}),
          ...(/\bitalique\b/.test(p) ? { italique: true } : {}),
        };
        const aQuelqueChose = "police" in rendu || "taillePt" in rendu || "gras" in rendu || "italique" in rendu;
        if (aQuelqueChose) {
          return { genre: "commandes", commandes: [commande("docx.format_texte", rendu)] };
        }
      }
    }
    if (taille && /\b(taille|reduis|réduis|agrandis|passe|mets|met|police)\b/.test(p)) {
      const pt = Number(taille[1]);
      if (pt >= 4 && pt <= 200) {
        return { genre: "commandes", commandes: [commande("docx.format_texte", { cible: cibleDe(p, ctx), taillePt: pt })] };
      }
    }
    // « mets-le en Aptos », « en Times New Roman »
    const police = /\b(?:en|police)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9]*(?:\s+[A-Z][A-Za-zÀ-ÿ0-9]*){0,3})\s*$/.exec(phrase.trim());
    if (police && /\b(police|mets|met|passe|en)\b/.test(p) && !/\b(gras|italique|souligne|souligné|majuscule)\b/.test(p)) {
      const nom = police[1].trim();
      // Un mot courant n'est pas un nom de police : sans ce filet, « mets-le en gras » demanderait
      // la police « gras ».
      if (nom.length >= 3 && !/^(gras|italique|centre|haut|bas|gauche|droite|page|ligne|forme|majuscule)$/i.test(nom)) {
        return { genre: "commandes", commandes: [commande("docx.format_texte", { cible: cibleDe(p, ctx), police: nom })] };
      }
    }
    if (/\b(en gras|mets? en gras|gras)\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.format_texte", { cible: cibleDe(p, ctx), gras: !/\b(pas|plus|enleve|enlève|retire|sans)\b/.test(p) })] };
    }
    if (/\b(en italique|italique)\b/.test(p)) {
      return { genre: "commandes", commandes: [commande("docx.format_texte", { cible: cibleDe(p, ctx), italique: !/\b(pas|plus|enleve|enlève|retire|sans)\b/.test(p) })] };
    }
    return null;
  }

  // ── PowerPoint ───────────────────────────────────────────────────────────────────────
  if (ctx.format === "PPTX") {
    const diapo = /\bdiapo(?:sitive)?\s*(\d{1,3})\b/.exec(p);
    const numDiapo = diapo ? Number(diapo[1]) : ctx.activeSlide;
    if (/\b(supprime|supprimer|enleve|enlève|retire)\b/.test(p) && /\bdiapo/.test(p) && diapo) {
      return { genre: "commandes", commandes: [commande("pptx.supprimer_diapo", { diapo: Number(diapo[1]) })] };
    }
    if (/\bplus (a |à )?(gauche|droite|haut|bas)\b/.test(p) && numDiapo) {
      const pas = amplitude(p);
      const dx = /gauche/.test(p) ? -pas : /droite/.test(p) ? pas : null;
      const dy = /haut/.test(p) ? -pas : /bas/.test(p) ? pas : null;
      const cible = ctx.derniereCible.length === 1 ? cibleId(ctx.derniereCible[0]) : cibleRole("titre");
      return { genre: "commandes", commandes: [commande("pptx.deplacer", { diapo: numDiapo, cible, dxCm: dx, dyCm: dy })] };
    }
    return null;
  }

  // ── Excel — une seule forme est sans ambiguïté : « mets B4 à … ». ────────────────────
  const affectation = /\b([a-z]{1,3}\d{1,7})\s*(?:=|a|à)\s*(.+)$/.exec(p);
  if (affectation && /\b(mets|met|ecris|écris|saisis|remplis|change)\b/.test(p)) {
    const valeur = affectation[2].trim();
    if (valeur.startsWith("=")) {
      return { genre: "commandes", commandes: [commande("xlsx.formule", { feuille: ctx.activeSheet, plage: affectation[1].toUpperCase(), formule: valeur })] };
    }
    return { genre: "commandes", commandes: [commande("xlsx.valeur", { feuille: ctx.activeSheet, plage: affectation[1].toUpperCase(), texte: valeur })] };
  }
  return null;
}

/**
 * « Là c'est bon », « parfait », « c'est parfait » — un accord, pas une commande (§58).
 *
 * L'ANCRE DE FIN EST LE POINT. « C'est bon, supprime la page 3 » commence par un accord et
 * porte une instruction : le traiter comme un simple accord ferait répondre « parfait ! » sans
 * rien supprimer, et la personne croirait la page partie. Un accord est un accord SEUL.
 */
export function estAccord(phrase: string): boolean {
  const p = normaliserTexte(phrase);
  return /^(?:(?:la|là|bon|et)\s+)?(?:c'est bon|c'est parfait|parfait|nickel|impeccable|tres bien|très bien|ok|voila|voilà|super)\s*[.!]?$/.test(p);
}
