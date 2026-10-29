/**
 * FILTRE DE CONFIDENTIALITÉ STRICT — Jalon 3 (Décision Q14).
 *
 * Règle absolue de sécurité :
 * Aucune rémunération (salaire de base, net à payer, primes), aucune coordonnée bancaire
 * (RIB, IBAN, CCP) ni pièce d'identité (passeport, CNI, NIN) ne doit être transmise
 * dans le contexte d'un LLM externe (MiMo ou autre).
 *
 * Ce module est pur (aucun import lourd ou serveur) et vérifiable unitairement.
 */

export const MOTS_CLES_SENSIBLES = [
  "salary",
  "basesalary",
  "netsalary",
  "grosssalary",
  "salaire",
  // Les colonnes de la fiche salarié copiées au coffre (refonte V2-E, `coffre/champs.ts`) : un nom de clé
  // anglais ne doit pas laisser passer ce que son équivalent français arrête.
  "nettopay",
  "employercost",
  "salairebase",
  "salairenet",
  "salairebrut",
  "remuneration",
  "tauxhoraire",
  "bulletindepaie",
  "emoluments",
  "rib",
  "iban",
  "bankaccount",
  "numerocompte",
  "numeroccp",
  "passport",
  "passeport",
  "idcard",
  "nationalid",
  "cni",
  "nin",
];

const MOTIF_REMPLACEMENT = "[CONFIDENTIEL]";

/**
 * Motifs regex détectant les données hautement sensibles dans les chaînes de texte :
 * 1. Coordonnées bancaires (IBAN algérien / international, RIB / CCP 20 chiffres)
 * 2. Numéros d'identité (NIN 18 chiffres, Passeport, CNI)
 * 3. Rémunérations (mentions explicites de salaires, émoluments, montants suivis de net/brut)
 */
const MOTIFS_TEXTUELS: Array<{ regex: RegExp; label: string }> = [
  // IBAN IMPRIMÉ PAR GROUPES DE QUATRE (« DZ58 0021 0001 1234 5678 9012 ») — la forme d'une facture, d'un
  // RIB photographié, d'un tableur fournisseurs. Mesuré le 28/10/2026 sur un CSV joint à l'Assistant IA :
  // la forme compacte seule était reconnue, l'IBAN groupé partait au modèle en clair.
  {
    regex: /\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){3,7}(?: [A-Z0-9]{1,4})?\b/gi,
    label: "IBAN_GROUPE",
  },
  // IBAN (DZ + 2 chiffres de contrôle + 20 caractères ou format international générique)
  {
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/gi,
    label: "IBAN",
  },
  // RIB / CCP algérien (20 chiffres, parfois groupés par espaces ou tirets)
  {
    regex: /\b\d{3}[-\s]?\d{3}[-\s]?\d{12}[-\s]?\d{2}\b/g,
    label: "RIB_20",
  },
  {
    // Sur UNE ligne : l'en-tête « iban » d'un tableau n'avale pas le nom du fournisseur de la ligne suivante.
    regex: /\b(?:RIB|IBAN|CCP|Compte[ \t]+bancaire)[ \t]*[:#=]?[ \t]*[0-9A-Z \t-]{10,30}\b/gi,
    label: "COMPTE_BANCAIRE",
  },
  // NIN algérien (Numéro d'Identification Nationale : 18 chiffres consécutifs)
  {
    regex: /\b\d{18}\b/g,
    label: "NIN_18",
  },
  // Pièces d'identité explicites (Passeport, CNI, NIN)
  {
    regex: /\b(?:Passeport|CNI|Carte\s+d['’]identit[ée]|NIN|Num[ée]ro\s+d['’]identification\s+nationale)\s*(?:N\s*°|n\s*°|num[ée]ro|[:#=])?\s*[A-Z0-9\s-]{6,25}\b/gi,
    label: "PIECE_IDENTITE",
  },
  // Rémunérations & salaires explicites (ex: "salaire net est de 180 000 DZD", "salaire: 200 000 DA"). Le montant
  // commence par un CHIFFRE : mesuré le 28/10/2026, « C'est quoi le salaire d'Assia ? » devenait « C'est quoi le
  // [CONFIDENTIEL]d'Assia ? » (l'espace seule passait pour un montant) — la question n'arrivait plus au modèle.
  {
    regex: /\b(?:salaire(?:\s+(?:de\s+base|net|brut|mensuel))?|r[ée]mun[ée]ration|net\s+[àa]\s+payer|[ée]moluments?)\s*(?:(?:est|sera|de|du|à|a)\s+(?:de\s+|d['’]\s*)?|[:=]\s*)?\d[\d\s.,]*(?:\s*(?:DZD|DA|dinars?|EUR|€|USD|\$))?\b/gi,
    label: "SALAIRE_EXPLICITE",
  },
  // Montant associé à net/brut/salaire
  {
    regex: /\b\d[\d\s.,]{2,}(?:DZD|DA|dinars?|EUR|€|USD|\$)\s+(?:net|brut|de\s+base|en\s+salaire)\b/gi,
    label: "MONTANT_SALAIRE",
  },
];

export interface ResultatCensureTexte {
  texte: string;
  censure: boolean;
  occurrences: number;
}

/**
 * Censure les données sensibles dans un texte libre.
 */
export function censurerTexte(texte: string): ResultatCensureTexte {
  if (!texte || typeof texte !== "string") {
    return { texte: texte ?? "", censure: false, occurrences: 0 };
  }

  let modifie = texte;
  let totalOccurrences = 0;

  for (const { regex } of MOTIFS_TEXTUELS) {
    // Réinitialiser le lastIndex pour les regex globales
    regex.lastIndex = 0;
    const matches = modifie.match(regex);
    if (matches && matches.length > 0) {
      totalOccurrences += matches.length;
      modifie = modifie.replace(regex, MOTIF_REMPLACEMENT);
    }
  }

  return {
    texte: modifie,
    censure: totalOccurrences > 0,
    occurrences: totalOccurrences,
  };
}

/**
 * MASQUE RÉVERSIBLE — pour un texte que le modèle doit TRANSFORMER (traduire) sans le voir en entier :
 * chaque valeur sensible devient un jeton « ⟦S1⟧ » que le modèle recopie tel quel, et que
 * `restaurer` remet à sa place dans le résultat. La valeur ne quitte jamais le serveur.
 */
export function masquerSensible(texte: string): { texte: string; valeurs: string[] } {
  const valeurs: string[] = [];
  let modifie = texte ?? "";
  for (const { regex } of MOTIFS_TEXTUELS) {
    regex.lastIndex = 0;
    modifie = modifie.replace(regex, (m) => {
      valeurs.push(m);
      return `⟦S${valeurs.length}⟧`;
    });
  }
  return { texte: modifie, valeurs };
}

/** Remet les valeurs masquées ; un jeton que le modèle aurait perdu reste perdu (jamais deviné), un jeton inventé est retiré. */
export function restaurerSensible(texte: string, valeurs: readonly string[]): string {
  // Les jetons peuvent s'imbriquer (une valeur masquée contient un jeton antérieur) : on dénoue jusqu'au point fixe.
  let t = texte;
  for (let i = 0; i < 4 && /⟦S\d+⟧/.test(t); i++) t = t.replace(/⟦S(\d+)⟧/g, (_, n: string) => valeurs[Number(n) - 1] ?? "");
  return t;
}

/**
 * LA NATURE D'UNE VALEUR SENSIBLE (décision 0012) — ce que le jeton du tour retient pour décider, au
 * moment d'afficher, si la personne a le droit de la voir. Les noms sont ceux du coffre (`NatureCoffre`).
 */
export type NatureSensible = "SALAIRE" | "IBAN" | "RIB" | "NIN" | "PASSEPORT_NUMERO" | "CNI_NUMERO";

const NATURE_DU_MOTIF: Record<string, NatureSensible> = {
  IBAN_GROUPE: "IBAN", IBAN: "IBAN", RIB_20: "RIB", COMPTE_BANCAIRE: "RIB", NIN_18: "NIN",
  PIECE_IDENTITE: "CNI_NUMERO", SALAIRE_EXPLICITE: "SALAIRE", MONTANT_SALAIRE: "SALAIRE",
};

/** La nature d'une clé sensible (`MOTS_CLES_SENSIBLES`, normalisée) — `null` si la clé ne l'est pas. */
export function natureDeCle(cle: string): NatureSensible | null {
  const c = cle.toLowerCase().replace(/[-_]/g, "");
  if (!MOTS_CLES_SENSIBLES.includes(c)) return null;
  if (["rib", "numerocompte", "numeroccp", "bankaccount"].includes(c)) return "RIB";
  if (c === "iban") return "IBAN";
  if (c === "passport" || c === "passeport") return "PASSEPORT_NUMERO";
  if (c === "idcard" || c === "cni") return "CNI_NUMERO";
  if (c === "nationalid" || c === "nin") return "NIN";
  return "SALAIRE";
}

/**
 * REMPLACER chaque valeur sensible d'un texte par ce que rend `remplacer` (un jeton du tour) — les mêmes
 * motifs que `censurerTexte`, dans le même ordre ; la nature du motif est passée avec la valeur.
 */
export function remplacerSensibles(texte: string, remplacer: (valeur: string, nature: NatureSensible) => string): string {
  let modifie = texte ?? "";
  for (const { regex, label } of MOTIFS_TEXTUELS) {
    regex.lastIndex = 0;
    modifie = modifie.replace(regex, (m) => remplacer(m, NATURE_DU_MOTIF[label] ?? "SALAIRE"));
  }
  return modifie;
}

/**
 * Censure récursivement un objet ou tableau structuré avant injection dans le contexte.
 */
export function censurerObjet<T>(donnees: T): { resultat: T; censure: boolean } {
  let aCensure = false;

  function nettoyer(valeur: unknown): unknown {
    if (valeur === null || valeur === undefined) return valeur;

    if (typeof valeur === "string") {
      const { texte, censure } = censurerTexte(valeur);
      if (censure) aCensure = true;
      return texte;
    }

    if (Array.isArray(valeur)) {
      return valeur.map(nettoyer);
    }

    if (typeof valeur === "object") {
      const resultat: Record<string, unknown> = {};
      for (const [cle, val] of Object.entries(valeur as Record<string, unknown>)) {
        const cleNormalisee = cle.toLowerCase().replace(/[-_]/g, "");
        if (MOTS_CLES_SENSIBLES.includes(cleNormalisee)) {
          resultat[cle] = MOTIF_REMPLACEMENT;
          aCensure = true;
        } else {
          resultat[cle] = nettoyer(val);
        }
      }
      return resultat;
    }

    return valeur;
  }

  const resultat = nettoyer(donnees) as T;
  return { resultat, censure: aCensure };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES JETONS DU TOUR — montrer une donnée sensible à qui a le droit, sans JAMAIS l'envoyer au modèle
 * (décision 0012, Direction 28/10/2026 : « c'est quoi le salaire d'Assia ? » → « je ne peux pas »).
 *
 *   1. La sortie d'un outil, AVANT le modèle, remplace chaque valeur sensible (salaire, net, IBAN / RIB,
 *      n° de pièce d'identité) par un REPÈRE opaque propre au tour : `⟦S1⟧`, `⟦S2⟧`… Le coffret du tour
 *      garde la vraie valeur, sa nature, son titulaire et, pour une colonne d'une fiche, son origine.
 *   2. Le modèle rédige AVEC le repère (consigne `CONSIGNE_JETONS`) : il ne voit jamais la valeur.
 *   3. Le SERVEUR, avant d'afficher et de stocker la réponse, remplace chaque repère par la valeur —
 *      seulement si la personne a le droit de la voir (`Revelateur`, `fil/tour.ts` : politique du coffre, journal) ;
 *      sinon, et pour un repère inconnu, « [confidentiel] ».
 *   4. Une valeur RÉVÉLÉE est entourée de deux séparateurs invisibles (U+2063) : l'historique renvoyé
 *      au modèle aux tours suivants, la réponse vocale et la notification la remplacent par
 *      « [confidentiel] » (`sansValeursRevelees`) — la vraie valeur ne repart nulle part.
 *
 * Pur, comme le reste de ce module : les repères se testent sans base. La révélation (serveur) est dans `fil/tour.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MASQUE_CONFIDENTIEL = "[confidentiel]";
/** Le séparateur invisible qui borne une valeur révélée — U+2063 (INVISIBLE SEPARATOR). */
export const BORNE_REVELEE = "⁣";
const RE_JETON = /⟦S(\d+)⟧/g;
const RE_JETON_SEUL = /^⟦S\d+⟧$/;
const RE_REVELEE = new RegExp(`${BORNE_REVELEE}[^${BORNE_REVELEE}]*${BORNE_REVELEE}`, "g");

/** Une colonne d'une fiche du coffre (`champs.ts`) — la révélation passe alors par le contrôle d'accès journalisé. */
export interface OrigineColonne {
  modele: "Employee";
  id: string;
  champ: string;
  /** La valeur brute de la colonne (le contrôle classe la valeur, et compare l'empreinte). */
  brut: string;
}

export interface EntreeJeton {
  /** Ce qui s'affichera à la place du repère (« 185 000 DZD », l'IBAN tel qu'imprimé). */
  valeur: string;
  nature: NatureSensible;
  /**
   * Le compte du titulaire de la valeur (le salarié), `null` s'il est inconnu (valeur lue dans un
   * document sans titulaire établi) : seuls le Super Admin et le métier qui la tient la voient alors.
   */
  titulaireUserId: string | null;
  origine?: OrigineColonne;
}

/** Le contexte d'une sortie : à qui appartiennent les valeurs qu'elle porte, quand l'outil le sait. */
export interface ContexteJetons {
  titulaireUserId?: string | null;
}

/** LE COFFRET D'UN TOUR — les valeurs remplacées, rangées par numéro de repère. Ne quitte jamais le serveur. */
export class CoffretDuTour {
  private readonly entrees: EntreeJeton[] = [];

  /** Le repère d'une valeur — la même valeur (même nature, même titulaire, même origine) garde le même. */
  jeton(e: EntreeJeton): string {
    const cle = (x: EntreeJeton) => `${x.nature}\u0000${x.valeur}\u0000${x.titulaireUserId ?? ""}\u0000${x.origine ? `${x.origine.id}.${x.origine.champ}` : ""}`;
    const deja = this.entrees.findIndex((x) => cle(x) === cle(e));
    if (deja >= 0) return `⟦S${deja + 1}⟧`;
    this.entrees.push(e);
    return `⟦S${this.entrees.length}⟧`;
  }

  /** L'entrée d'un repère (numéro à partir de 1) ; `undefined` pour un repère que ce tour n'a pas émis. */
  entree(n: number): EntreeJeton | undefined {
    return this.entrees[n - 1];
  }

  get taille(): number {
    return this.entrees.length;
  }
}

/** Les numéros des repères d'un texte, sans doublon. */
export function reperesDe(texte: string): number[] {
  return [...new Set([...(texte ?? "").matchAll(RE_JETON)].map((m) => Number(m[1])))];
}

/** Remplace chaque repère par ce que rend `valeurDe` (la valeur bornée, ou le masque). */
export function remplacerReperes(texte: string, valeurDe: (n: number) => string): string {
  return (texte ?? "").replace(RE_JETON, (_, n: string) => valeurDe(Number(n)));
}

/**
 * Un texte, jetonné : les valeurs sensibles deviennent des repères. Un repère que le coffret ne connaît
 * pas (écrit dans un document pour en pêcher un autre) est neutralisé.
 */
export function jetonnerTexte(texte: string, coffret: CoffretDuTour, ctx: ContexteJetons = {}): string {
  const neutre = (texte ?? "").replace(RE_JETON, (j, n: string) => (coffret.entree(Number(n)) ? j : "⟦?⟧"));
  return remplacerSensibles(neutre, (valeur, nature) => coffret.jeton({ valeur: valeur.trim(), nature, titulaireUserId: ctx.titulaireUserId ?? null }));
}

/**
 * TOUS LES MONTANTS d'un texte — pour une pièce du dossier RH (contrat, avenant), où un montant est une
 * rémunération : en chiffres (« 150 000 DA », « 185.000,00 DZD ») comme en lettres (« cent cinquante mille
 * dinars »). Le filtre général, lui, ne reconnaît un salaire que s'il est nommé à côté du chiffre.
 */
const RE_MONTANT_CHIFFRES = /\b\d{1,3}(?:[ .  ]\d{3})+(?:[.,]\d{1,2})?\s*(?:DZD|DA|dinars?(?:\s+alg[ée]riens?)?|EUR|€)(?![A-Za-z])|\b\d{4,}(?:[.,]\d{1,2})?\s*(?:DZD|DA|dinars?(?:\s+alg[ée]riens?)?|EUR|€)(?![A-Za-z])/gi;
const MOTS_NOMBRES = "z[ée]ro|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingts?|trente|quarante|cinquante|soixante|cents?|mille|millions?|milliards?|et";
const RE_MONTANT_LETTRES = new RegExp(`\\b(?:(?:${MOTS_NOMBRES})[\\s-]+)+(?:dinars?|DA|DZD)(?:\\s+alg[ée]riens?)?(?![A-Za-z])`, "gi");

export function jetonnerMontants(texte: string, coffret: CoffretDuTour, ctx: ContexteJetons = {}): string {
  const jeton = (m: string) => coffret.jeton({ valeur: m.trim(), nature: "SALAIRE", titulaireUserId: ctx.titulaireUserId ?? null });
  return (texte ?? "").replace(RE_MONTANT_CHIFFRES, jeton).replace(RE_MONTANT_LETTRES, jeton);
}

/** Un objet, jetonné : les clés sensibles (`salaire`, `iban`…) et les motifs dans les chaînes. */
export function jetonnerObjet<T>(donnees: T, coffret: CoffretDuTour, ctx: ContexteJetons = {}): T {
  const nettoyer = (valeur: unknown): unknown => {
    if (valeur === null || valeur === undefined) return valeur;
    if (typeof valeur === "string") return jetonnerTexte(valeur, coffret, ctx);
    if (Array.isArray(valeur)) return valeur.map(nettoyer);
    if (typeof valeur === "object") {
      const out: Record<string, unknown> = {};
      for (const [cle, val] of Object.entries(valeur as Record<string, unknown>)) {
        const nature = natureDeCle(cle);
        if (!nature) { out[cle] = nettoyer(val); continue; }
        // Une valeur déjà jetonnée par l'outil (qui connaissait son origine) reste ce repère.
        if (typeof val === "string" && RE_JETON_SEUL.test(val) && coffret.entree(Number(val.slice(2, -1)))) { out[cle] = val; continue; }
        if (val === null || val === undefined || val === "") { out[cle] = val; continue; }
        const texte = typeof val === "object" ? JSON.stringify(val) : String(val);
        out[cle] = coffret.jeton({ valeur: texte, nature, titulaireUserId: ctx.titulaireUserId ?? null });
      }
      return out;
    }
    return valeur;
  };
  return nettoyer(donnees) as T;
}

/**
 * LA SORTIE D'UN OUTIL, AVANT LE MODÈLE. Avec un coffret : jetonnée (JSON gardé JSON). Sans coffret (une
 * routine, un passage sans écran) : censurée comme avant — « [CONFIDENTIEL] », rien à révéler.
 */
export function jetonnerSortie(sortie: string, coffret: CoffretDuTour | null | undefined, ctx: ContexteJetons = {}): string {
  try {
    const objet: unknown = JSON.parse(sortie);
    return JSON.stringify(coffret ? jetonnerObjet(objet, coffret, ctx) : censurerObjet(objet).resultat);
  } catch {
    return coffret ? jetonnerTexte(sortie, coffret, ctx) : censurerTexte(sortie).texte;
  }
}

/** Le repère d'une valeur posée par un outil qui en connaît l'origine — sans coffret, le masque. */
export function jetonOuMasque(coffret: CoffretDuTour | null | undefined, e: EntreeJeton): string {
  return coffret ? coffret.jeton(e) : "[CONFIDENTIEL]";
}

/** Une valeur révélée, bornée pour que l'historique la reconnaisse. */
export const borner = (valeur: string): string => `${BORNE_REVELEE}${valeur}${BORNE_REVELEE}`;

/**
 * Ce qui repart vers un modèle (historique, voix) ou hors de l'écran (notification) : chaque valeur
 * révélée redevient « [confidentiel] », et un repère resté brut aussi.
 */
export function sansValeursRevelees(texte: string): string {
  return (texte ?? "").replace(RE_REVELEE, MASQUE_CONFIDENTIEL).replace(RE_JETON, MASQUE_CONFIDENTIEL);
}

/** Le texte qui s'écrit EN FLUX : un repère n'est pas encore jugé — il s'affiche « ••• » jusqu'à la fin du tour. */
export function masquerReperesPartiels(texte: string): string {
  return (texte ?? "").replace(RE_JETON, "•••").replace(/⟦S?\d*$/, "");
}

/** La consigne, dite au modèle quand le tour a un coffret. */
export const CONSIGNE_JETONS = [
  "DONNÉES CONFIDENTIELLES (salaires, nets, coût employeur, IBAN / RIB, n° de pièce d'identité) : tes outils te les rendent sous forme de REPÈRES opaques, ⟦S1⟧, ⟦S2⟧…",
  "Recopie le repère TEL QUEL, à l'endroit exact où la valeur doit paraître (« Le salaire de base d'Assia est de ⟦S1⟧. ») : le serveur l'affichera à la personne si elle a le droit de la voir, et « [confidentiel] » sinon.",
  "Ne dis jamais que tu ne peux pas communiquer une valeur que tes outils t'ont rendue en repère ; ne la devine pas, ne calcule rien avec un repère, n'en invente aucun.",
  "Ne mets jamais un repère dans l'entrée d'un outil (message, tâche, carte) : il n'y serait pas remplacé. Si la personne veut transmettre la valeur, dis-lui de la copier depuis ta réponse.",
].join("\n");
