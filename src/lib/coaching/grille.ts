/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE COACHING — TOURNÉE EN DOUBLE (§118.157). Module PUR : aucune base, aucun import.
 *
 * ── CE QUE C'EST ────────────────────────────────────────────────────────────────────────────
 *
 * Le manager accompagne un collaborateur (KAM, délégué) sur sa tournée, observe ses visites et
 * l'évalue sur une GRILLE : cinq axes (préparation, conduite, écoute, objections, conclusion),
 * chacun décrit à quatre niveaux de maîtrise — MB (1), MP (2), MA (3), PM (4). Le total est la
 * somme des niveaux retenus, sur 4 × le nombre d'axes (20 pour la grille d'origine). La fiche se
 * clôt sur un bilan : points forts observés, points à améliorer.
 *
 * La grille d'origine est `GRILLE_PAR_DEFAUT`, recopiée du classeur que la Direction a fourni
 * (« Fiche_Coaching.xlsx », 23/09/2026) mot pour mot — une seule retouche : « Points à
 * Améliorer : : » y portait deux fois les deux-points.
 *
 * ── POURQUOI LA GRILLE EST UNE DONNÉE, ET PAS DU CODE ────────────────────────────────────────
 *
 * Elle est administrée par le directeur des opérations, qui la MODIFIE (un critère reformulé, un
 * axe ajouté). Chaque modification crée une VERSION (`CoachingGrid`) et une fiche garde la
 * version sous laquelle elle a été remplie : une évaluation lue un an plus tard doit l'être dans
 * les critères qu'avait sous les yeux le manager qui l'a écrite, pas dans ceux du jour — sinon
 * « 3 » voudrait dire autre chose qu'au moment où on l'a coché (§118.107 : le parcours est un
 * fait de la demande ; ici, la grille est un fait de la fiche).
 *
 * ── LE NOMBRE DE NIVEAUX EST FIXE ────────────────────────────────────────────────────────────
 *
 * Quatre, parce que les points valent 1 à 4 et que le total s'additionne sur cette échelle :
 * les LIBELLÉS s'éditent (code, nom, qualification), le barème non. Un cinquième niveau ferait
 * d'un 16/20 d'hier et d'un 16/25 d'aujourd'hui deux nombres qu'on comparerait à tort.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NOMBRE_NIVEAUX = 4 as const;

/** Un niveau de maîtrise. Ses points sont son RANG (1 à 4) — jamais une valeur saisie. */
export interface NiveauMaitrise {
  /** « MB », « MP », « MA », « PM ». */
  code: string;
  /** « Maîtrise Basique ». */
  libelle: string;
  /** « Insuffisant / À développer ». */
  qualification: string;
}

/** Un axe d'évaluation, décrit à chacun des quatre niveaux. */
export interface AxeCoaching {
  /**
   * La CLÉ STABLE de l'axe : c'est elle que la fiche note (`{ A: 3 }`), et c'est elle qui permet
   * de comparer un axe d'une version à l'autre quand son titre a été reformulé. Un axe NOUVEAU
   * reçoit une clé neuve — il ne doit jamais hériter des notes d'un axe supprimé.
   */
  cle: string;
  /** « A. Préparation de la visite ». */
  titre: string;
  /** Le critère observable à chaque niveau, dans l'ordre 1 → 4. */
  criteres: string[];
}

export interface BilanLibelles {
  titre: string;
  pointsForts: string;
  pointsAAmeliorer: string;
}

export interface GrilleCoaching {
  titre: string;
  niveaux: NiveauMaitrise[];
  axes: AxeCoaching[];
  bilan: BilanLibelles;
}

export const GRILLE_PAR_DEFAUT: GrilleCoaching = {
  titre: "FICHE DE COACHING – TOURNÉE EN DOUBLE",
  niveaux: [
    { code: "MB", libelle: "Maîtrise Basique", qualification: "Insuffisant / À développer" },
    { code: "MP", libelle: "Maîtrise Partielle", qualification: "En progrès / À consolider" },
    { code: "MA", libelle: "Maîtrise Acquise", qualification: "Conforme aux attentes" },
    { code: "PM", libelle: "Parfaite Maîtrise", qualification: "Exemplaire / Stratégique" },
  ],
  axes: [
    {
      cle: "A",
      titre: "A. Préparation de la visite",
      criteres: [
        "Visite isolée, aucune prise en compte de l'historique",
        "Préparation correcte avec quelques données sur le médecin.",
        "Analyse préalable des habitudes et résistances ; préparation ciblée.",
        "Stratégique, intégrée à une vision globale et concurrentielle du portefeuille.",
      ],
    },
    {
      cle: "B",
      titre: "B. Conduite de la visite",
      criteres: [
        "Monologue axé produit, questions fermées ou absentes.",
        "Dialogue amorcé mais peu structuré, questions simples.",
        "Échange dynamique et interactif, centré sur les besoins client.",
        "Dialogue influent et structuré (Accueil ➔ Exploration ➔ Présentation ➔ Validation).",
      ],
    },
    {
      cle: "C",
      titre: "C. Écoute Active & Temps de Parole (70/30)",
      criteres: [
        "Écoute passive/interruption, n'écoute que pour répondre",
        "Pas d'interruption, amorce de reformulation et de validation.",
        "Écoute empathique maîtrisée, questionnement ouvert.",
        "Silence stratégique, co-construction de solutions, forte valeur ajoutée.",
      ],
    },
    {
      cle: "D",
      titre: "D. Gestion des Objections",
      criteres: [
        "Déstabilisé, réponses hésitantes ou sur la défensive.",
        "Réponses simples ou réciter du « par cœur ».",
        "Gestion fluide (Accueillir ➔ Reformuler ➔ Répondre avec données ➔ Valider).",
        "Anticipation des résistances, conduite vers le changement d'attitude.",
      ],
    },
    {
      cle: "E",
      titre: "E. Conclusion & Engagement",
      criteres: [
        "Tentative basique, client passif, aucun engagement.",
        "Intérêt modéré du médecin, engagement superficiel.",
        "Demande d'engagement claire et spécifique (faire dire / faire faire).",
        "Engagement fort, concret et durable (essais produit, changement de pratique).",
      ],
    },
  ],
  bilan: {
    titre: "Bilan & Plan d'Action",
    pointsForts: "1. Points Forts Observés :",
    pointsAAmeliorer: "2. Points à Améliorer :",
  },
};

/**
 * LES LIMITES DE LA GRILLE — OPÉRATIONNELLES, et chacune porte sa raison (§118.2).
 *
 * Douze axes : la fiche doit tenir sur une page imprimée qu'on relit avec le collaborateur, et
 * douze axes font déjà quarante-huit lignes de critères. Les longueurs bornent ce qu'une cellule
 * de classeur et une ligne d'écran lisent sans devenir un paragraphe qu'on saute.
 */
export const LIMITES_GRILLE = {
  axesMax: 12,
  titreMax: 120,
  critereMax: 400,
  codeMax: 4,
  libelleMax: 60,
  qualificationMax: 80,
  bilanMax: 120,
} as const;

const texte = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * UNE CLÉ D'AXE lisible : lettres, chiffres, tiret bas — elle voyage dans une colonne JSON et
 * dans l'adresse d'un champ de formulaire, rien d'autre n'y a sa place.
 */
export const CLE_AXE_VALIDE = /^[A-Za-z0-9_]{1,24}$/;

export type ResultatGrille = { ok: true; grille: GrilleCoaching } | { ok: false; erreurs: string[] };

/**
 * VALIDER une grille reçue (de l'éditeur du directeur des opérations, ou relue en base).
 *
 * Rend TOUTES les erreurs en une fois : un éditeur de douze axes qui refuserait une faute à la
 * fois ferait revenir la personne autant de fois qu'il y a de fautes (§118.18). Normalise au
 * passage (espaces repliés) : deux grilles qui ne diffèrent que d'une espace ne sont pas deux
 * versions.
 */
export function validerGrille(entree: unknown): ResultatGrille {
  const erreurs: string[] = [];
  const g = (entree && typeof entree === "object" ? entree : {}) as Record<string, unknown>;

  const titre = texte(g.titre);
  if (!titre) erreurs.push("Le titre de la fiche est vide.");
  else if (titre.length > LIMITES_GRILLE.titreMax) erreurs.push(`Le titre dépasse ${LIMITES_GRILLE.titreMax} caractères.`);

  const niveauxBruts = Array.isArray(g.niveaux) ? g.niveaux : [];
  if (niveauxBruts.length !== NOMBRE_NIVEAUX) {
    erreurs.push(`L'échelle compte ${NOMBRE_NIVEAUX} niveaux (points 1 à ${NOMBRE_NIVEAUX}) — ${niveauxBruts.length} reçu(s).`);
  }
  const niveaux: NiveauMaitrise[] = [];
  const codesVus = new Set<string>();
  niveauxBruts.slice(0, NOMBRE_NIVEAUX).forEach((n, i) => {
    const o = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
    const code = texte(o.code).toUpperCase();
    const libelle = texte(o.libelle);
    const qualification = texte(o.qualification);
    const rang = `Niveau ${i + 1}`;
    if (!code) erreurs.push(`${rang} : le code est vide (ex. « MB »).`);
    else if (code.length > LIMITES_GRILLE.codeMax) erreurs.push(`${rang} : le code « ${code} » dépasse ${LIMITES_GRILLE.codeMax} caractères.`);
    else if (codesVus.has(code)) erreurs.push(`${rang} : le code « ${code} » est déjà pris par un autre niveau.`);
    codesVus.add(code);
    if (!libelle) erreurs.push(`${rang} : le libellé est vide (ex. « Maîtrise Basique »).`);
    else if (libelle.length > LIMITES_GRILLE.libelleMax) erreurs.push(`${rang} : le libellé dépasse ${LIMITES_GRILLE.libelleMax} caractères.`);
    if (qualification.length > LIMITES_GRILLE.qualificationMax) erreurs.push(`${rang} : la qualification dépasse ${LIMITES_GRILLE.qualificationMax} caractères.`);
    niveaux.push({ code, libelle, qualification });
  });

  const axesBruts = Array.isArray(g.axes) ? g.axes : [];
  if (axesBruts.length === 0) erreurs.push("La grille n'a aucun axe d'évaluation.");
  if (axesBruts.length > LIMITES_GRILLE.axesMax) {
    erreurs.push(`La grille compte ${axesBruts.length} axes — ${LIMITES_GRILLE.axesMax} au plus, pour que la fiche tienne sur une page imprimée.`);
  }
  const axes: AxeCoaching[] = [];
  const clesVues = new Set<string>();
  axesBruts.slice(0, LIMITES_GRILLE.axesMax).forEach((a, i) => {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const cle = texte(o.cle);
    const titreAxe = texte(o.titre);
    const nom = titreAxe ? `Axe « ${titreAxe} »` : `Axe n° ${i + 1}`;
    if (!CLE_AXE_VALIDE.test(cle)) erreurs.push(`${nom} : clé technique invalide.`);
    else if (clesVues.has(cle)) erreurs.push(`${nom} : clé technique en double (« ${cle} »).`);
    clesVues.add(cle);
    if (!titreAxe) erreurs.push(`Axe n° ${i + 1} : le titre est vide.`);
    else if (titreAxe.length > LIMITES_GRILLE.titreMax) erreurs.push(`${nom} : le titre dépasse ${LIMITES_GRILLE.titreMax} caractères.`);
    const bruts = Array.isArray(o.criteres) ? o.criteres : [];
    const criteres = Array.from({ length: NOMBRE_NIVEAUX }, (_, k) => texte(bruts[k]));
    if (bruts.length !== NOMBRE_NIVEAUX) erreurs.push(`${nom} : ${NOMBRE_NIVEAUX} critères attendus (un par niveau) — ${bruts.length} reçu(s).`);
    criteres.forEach((c, k) => {
      const niveau = niveaux[k]?.code || `niveau ${k + 1}`;
      if (!c) erreurs.push(`${nom} : le critère du niveau ${niveau} est vide.`);
      else if (c.length > LIMITES_GRILLE.critereMax) erreurs.push(`${nom} : le critère du niveau ${niveau} dépasse ${LIMITES_GRILLE.critereMax} caractères.`);
    });
    axes.push({ cle, titre: titreAxe, criteres });
  });

  const b = (g.bilan && typeof g.bilan === "object" ? g.bilan : {}) as Record<string, unknown>;
  const bilan: BilanLibelles = {
    titre: texte(b.titre),
    pointsForts: texte(b.pointsForts),
    pointsAAmeliorer: texte(b.pointsAAmeliorer),
  };
  if (!bilan.titre) erreurs.push("Le titre du bilan est vide (ex. « Bilan & Plan d'Action »).");
  if (!bilan.pointsForts) erreurs.push("Le libellé des points forts est vide.");
  if (!bilan.pointsAAmeliorer) erreurs.push("Le libellé des points à améliorer est vide.");
  for (const [nom, v] of [["titre du bilan", bilan.titre], ["libellé des points forts", bilan.pointsForts], ["libellé des points à améliorer", bilan.pointsAAmeliorer]] as const) {
    if (v.length > LIMITES_GRILLE.bilanMax) erreurs.push(`Le ${nom} dépasse ${LIMITES_GRILLE.bilanMax} caractères.`);
  }

  if (erreurs.length > 0) return { ok: false, erreurs };
  return { ok: true, grille: { titre, niveaux, axes, bilan } };
}

/**
 * RELIRE une grille stockée. `null` quand elle ne se lit pas à coup sûr — l'appelant le DIT
 * plutôt que d'afficher une fiche sur une grille inventée (§118.26).
 */
export function lireGrille(json: unknown): GrilleCoaching | null {
  const r = validerGrille(json);
  return r.ok ? r.grille : null;
}

/** Deux grilles DISENT-elles la même chose ? Sans cela, enregistrer sans rien changer créerait une version vide. */
export function grillesIdentiques(a: GrilleCoaching, b: GrilleCoaching): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Les points d'un niveau : son rang, 1 à 4. */
export type Points = 1 | 2 | 3 | 4;

export const estPoints = (v: unknown): v is Points => v === 1 || v === 2 || v === 3 || v === 4;

/**
 * LIRE LES NOTES d'une fiche contre SA grille.
 *
 * Ne garde que les axes de la grille et les entiers 1 à 4 : une clé inconnue (axe d'une autre
 * version) ou une valeur hors barème est ÉCARTÉE, jamais arrondie. Un axe non noté est ABSENT,
 * jamais zéro — zéro est une note que personne n'a donnée, et elle ferait baisser un total.
 */
export function lireNotes(json: unknown, grille: GrilleCoaching): Record<string, Points> {
  const o = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const out: Record<string, Points> = {};
  for (const axe of grille.axes) {
    const v = typeof o[axe.cle] === "string" ? Number(o[axe.cle]) : o[axe.cle];
    if (estPoints(v)) out[axe.cle] = v;
  }
  return out;
}

/**
 * LES NOTES REFUSÉES — ce que `lireNotes` écarterait d'une saisie : une clé d'axe inconnue de la
 * grille, une valeur hors barème. Une valeur NULLE n'en est pas une (l'axe n'est simplement pas
 * encore noté). L'action refuse plutôt que d'écarter en silence : l'écran n'envoie jamais ces
 * valeurs, et s'il en envoie, c'est un défaut à voir, pas une note à perdre.
 */
export function notesRefusees(json: unknown, grille: GrilleCoaching): string[] {
  if (json === null || json === undefined) return [];
  if (typeof json !== "object" || Array.isArray(json)) return ["les notes ne se lisent pas (objet attendu)"];
  const cles = new Set(grille.axes.map((a) => a.cle));
  const out: string[] = [];
  for (const [cle, v] of Object.entries(json as Record<string, unknown>)) {
    if (v === null || v === "") continue;
    if (!cles.has(cle)) { out.push(`axe inconnu de cette grille (« ${cle} »)`); continue; }
    const n = typeof v === "string" ? Number(v) : v;
    if (!estPoints(n)) out.push(`note hors barème sur « ${grille.axes.find((a) => a.cle === cle)!.titre} » (${String(v)})`);
  }
  return out;
}

export interface BilanNotes {
  total: number;
  max: number;
  /** Les axes notés, dans l'ordre de la grille, avec leur niveau. */
  notes: { axe: AxeCoaching; points: Points; niveau: NiveauMaitrise }[];
  /** Les axes NON notés — une fiche ne se finalise pas tant qu'il en reste. */
  manquants: AxeCoaching[];
  complet: boolean;
}

/**
 * LE TOTAL DE LA FICHE — la somme des niveaux retenus, sur 4 × le nombre d'axes.
 *
 * C'est la formule du classeur d'origine (`D16 = D18 + D22 + D26 + D30 + D34`, chaque Dn
 * valant le niveau retenu sur son axe). Le maximum se calcule sur la grille, pas « sur 20 » :
 * une grille de six axes se lit sur 24.
 */
export function bilanDesNotes(grille: GrilleCoaching, notes: Record<string, Points>): BilanNotes {
  const lignes: BilanNotes["notes"] = [];
  const manquants: AxeCoaching[] = [];
  for (const axe of grille.axes) {
    const p = notes[axe.cle];
    if (p) lignes.push({ axe, points: p, niveau: grille.niveaux[p - 1]! });
    else manquants.push(axe);
  }
  const total = lignes.reduce((s, l) => s + l.points, 0);
  return { total, max: grille.axes.length * NOMBRE_NIVEAUX, notes: lignes, manquants, complet: manquants.length === 0 };
}

/**
 * LE REFUS DE FINALISATION — il NOMME les axes manquants. « Fiche incomplète » ferait chercher la
 * ligne oubliée dans une grille de vingt critères (§118.30).
 */
export function refusFinalisation(b: BilanNotes): string | null {
  if (b.complet) return null;
  const noms = b.manquants.map((a) => `« ${a.titre} »`).join(", ");
  return `Pour finaliser, notez ${b.manquants.length === 1 ? "l'axe" : "les axes"} ${noms} — une fiche partagée avec le collaborateur doit être complète.`;
}

/** « MB = Maîtrise Basique (Insuffisant / À développer) : 1 » — la ligne de légende du classeur. */
export function ligneEchelle(n: NiveauMaitrise, points: number): string {
  return `${n.code} = ${n.libelle}${n.qualification ? ` (${n.qualification})` : ""} : ${points}`;
}

/**
 * LA CLÉ PROVISOIRE d'un axe ajouté dans l'éditeur — `nouveau_1`, `nouveau_2`… Le serveur la
 * remplace par une clé qui n'a JAMAIS servi (`cleLibre` sur tout l'historique).
 *
 * Trouvé par le banc, pas par relecture : l'éditeur calculait la clé d'un axe ajouté par
 * `cleLibre` sur les axes À L'ÉCRAN. Retirer l'axe E puis en ajouter un rendait « E » — une clé
 * de la version en vigueur, donc lue par le serveur comme une MODIFICATION de l'axe E : le nouvel
 * axe « Suivi post-visite » aurait hérité, dans la synthèse, des notes de « Conclusion &
 * Engagement ». Le préfixe est réservé : le serveur n'attribue jamais une clé qui le porte, donc
 * une clé provisoire ne peut pas coïncider avec un axe existant.
 *
 * LA RÈGLE DU SERVEUR, en une phrase : une clé présente dans la version en vigueur est le MÊME
 * axe (reformulé ou non) ; toute autre clé est un axe NOUVEAU, et sa clé est réattribuée.
 */
export const PREFIXE_CLE_PROVISOIRE = "nouveau_";

export function cleProvisoire(prises: Iterable<string>): string {
  const deja = new Set(prises);
  for (let i = 1; ; i++) if (!deja.has(`${PREFIXE_CLE_PROVISOIRE}${i}`)) return `${PREFIXE_CLE_PROVISOIRE}${i}`;
}

/**
 * UNE CLÉ NEUVE pour un axe ajouté : la première lettre libre, puis `AX1`, `AX2`… — jamais une
 * clé déjà portée par un axe de la grille (sinon l'axe neuf hériterait des notes de l'ancien
 * dans la synthèse). C'est le SERVEUR qui l'attribue, sur toutes les clés jamais employées.
 */
export function cleLibre(prises: Iterable<string>): string {
  const deja = new Set(prises);
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!deja.has(c)) return c;
  }
  for (let i = 1; ; i++) if (!deja.has(`AX${i}`)) return `AX${i}`;
}
