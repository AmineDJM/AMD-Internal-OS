/**
 * LA LECTURE DES CHAMPS D'UN FORMULAIRE — lecteurs reconnus (partagés, du fichier, locaux), clés
 * calculées à l'exécution, obligation prouvée par la garde, valeurs admises, modèle désigné par le
 * schéma, et les tables lues en tête de fichier (constantes, listes de littéraux).
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import { sansCommentaires } from "./decoupage";
import type { ChampAction, TableEnums, TableRelations, TypeChamp } from "./types";

// ───────────────────────────────────────────────────────────────────────────────────────────
// LES VALEURS ADMISES
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Les listes de littéraux déclarées EN TÊTE d'un fichier (`const STATUTS: T[] = [...]`,
 * `new Set([...])`). C'est la forme sous laquelle l'ERP écrit ses allowlists.
 */
export function enumsLocaux(source: string): TableEnums {
  const table: Record<string, readonly string[]> = {};
  const re = /^const\s+([A-Za-z_0-9]+)(?:\s*:\s*[A-Za-z0-9_<>\[\]| ]+)?\s*=\s*(?:new Set\()?\[([^\]]*)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const valeurs = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    if (valeurs.length >= 2) table[m[1]!] = valeurs;
  }
  return table;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// LA LECTURE D'UNE ACTION
// ───────────────────────────────────────────────────────────────────────────────────────────

export const HELPERS_PARTAGES: Readonly<Record<string, TypeChamp>> = {
  // `fdCase` (§118.172) : la case à cocher PRÉCÉDÉE de son témoin caché — `fdBool` lit la PREMIÈRE
  // valeur, donc le témoin, et une case cochée ne réactivait jamais rien.
  fdStr: "texte", fdNum: "nombre", fdDate: "date", fdBool: "booleen", fdCase: "booleen",
};

/** `id`, `userId`, `dossierId`… désignent une autre fiche. C'est le pont vers `resoudreCible`. */
export const estReference = (nom: string): boolean => nom === "id" || /[a-z0-9]Id$/.test(nom);

/**
 * QUE DÉSIGNE CE CHAMP ? LE SCHÉMA RÉPOND, OU PERSONNE.
 *
 * `careBeneficiary.doctorId` pointe vers `MedicalDoctor` parce que la relation Prisma le dit —
 * pas parce que le nom y ressemble. La tentation du nom a été MESURÉE : elle ajoutait 35 champs
 * sur 730, et faisait pointer le `messageId` de la messagerie Microsoft vers le modèle `Message`
 * de l'ERP, deux objets qui n'ont rien à voir. Un champ de plus obtenu en devinant vaut moins
 * qu'un champ de moins obtenu à coup sûr : ici la conséquence d'une erreur est d'agir sur la
 * mauvaise ligne (§118.16, §104.7).
 *
 * PLUSIEURS modèles écrits qui répondent différemment n'en désignent AUCUN (§118.34).
 */
export function modeleDesigne(nom: string, modelesEcrits: readonly string[], relations: TableRelations): string | null {
  const ecrits = [...new Set(modelesEcrits.map((m) => m.charAt(0).toUpperCase() + m.slice(1)))];
  const via = [...new Set(ecrits.map((m) => relations[`${m}.${nom}`]).filter((x): x is string => Boolean(x)))];
  return via.length === 1 ? via[0]! : null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN LECTEUR LOCAL EST UN LECTEUR — quatre actions le prouvaient en creux.
 *
 * `setOrderArrival` écrit `const parseDate = (k: string) => { const v = fdStr(formData, k); … }`
 * puis `parseDate("expectedArrival")`, `parseDate("arrivedDate")`. Les clés sont LITTÉRALES et
 * à trois lignes de là ; le détecteur de dynamisme, lui, voyait `fdStr(formData, k)` — une clé
 * non littérale — et déclarait toute l'action incompréhensible. C'est §118.78 une fois de plus :
 * le refus était écrit à côté de ce qu'il déclarait ne pas savoir lire.
 *
 * Quatre actions du parc : `setOrderArrival`, `createTask`, `updateVisit`, `saveAdoptionSettings`.
 *
 * ── CE QUI RESTE REFUSÉ, ET C'EST LA MOITIÉ QUI COMPTE ───────────────────────────────────
 *
 * Reconnaître le lecteur ne suffit pas : si on l'APPELLE avec une variable (`clean(champ)` dans
 * une boucle), les clés redeviennent inconnues et l'action redevient illisible. Sans cette
 * seconde règle, on aurait échangé un refus honnête contre une liste de champs INCOMPLÈTE —
 * et un champ manquant peut être celui qui aiguille l'écriture (§118.26).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lecteursLocaux(
  corps: string,
  formulaires: readonly string[],
  lecteursConnus: Readonly<Record<string, TypeChamp>>,
): { lecteurs: Record<string, TypeChamp>; parametres: Set<string>; presences: Set<string> } {
  const lecteurs: Record<string, TypeChamp> = {};
  const parametres = new Set<string>();
  const presences = new Set<string>();
  if (formulaires.length === 0) return { lecteurs, parametres, presences };
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fd = formulaires.map(ech).join("|");
  const noms = Object.keys(lecteursConnus).map(ech).join("|");
  const propre = sansCommentaires(corps);

  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=]*?)?=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(propre)) !== null) {
    const nom = m[1]!;
    const premier = /^\s*([A-Za-z_$][\w$]*)\s*:\s*string\b/.exec(m[2]!);
    if (!premier) continue;
    const cle = premier[1]!;
    // La FENÊTRE qui suit la flèche : on n'a pas besoin des bornes exactes du corps, seulement
    // d'y trouver la preuve d'une lecture. Trop large ne fait qu'ajouter du contexte ; on ne
    // conclut que sur une occurrence qui NOMME à la fois le formulaire et le paramètre.
    const fenetre = propre.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const k = ech(cle);
    const lit = (methode: string) => new RegExp(`\\b(?:${fd})\\s*\\.\\s*${methode}\\s*\\(\\s*${k}\\s*\\)`).test(fenetre);
    const type: TypeChamp | null =
      lit("getAll") ? "liste"
      : lit("get") ? "texte"
      : (() => {
          const r = new RegExp(`\\b(${noms})\\s*\\(\\s*(?:${fd})\\s*,\\s*${k}\\s*\\)`).exec(fenetre);
          return r ? lecteursConnus[r[1]!]! : null;
        })()
        // UN TEST DE PRÉSENCE n'est pas une lecture (§118.172) : `(cle) => formData.has(cle)` dit
        // si le formulaire PORTE un champ, jamais ce qu'il vaut. Il reste un lecteur local — sans
        // quoi `formData.has(cle)`, clé non littérale, rendrait l'action illisible — mais il ne
        // TYPE rien et ne prouve aucune obligation : `if (porte("wilaya") && !wilaya.ok)` déclarait
        // la wilaya OBLIGATOIRE sur une action qui la rend facultative.
        ?? (lit("has") ? (presences.add(nom), "texte" as const) : null);
    if (!type) continue;
    lecteurs[nom] = type;
    parametres.add(cle);
  }
  return { lecteurs, parametres, presences };
}

/**
 * Le nom du champ est-il CALCULÉ à l'exécution ? Alors on ne peut rien annoncer.
 *
 * Le test porte sur le premier caractère non blanc après la virgule (ou la parenthèse) : un
 * guillemet est un littéral, autre chose est une variable. Une première version testait
 * `[^"]` juste après la virgule et comptait 563 actions sur 619 comme dynamiques — parce
 * qu'un retour à la ligne n'est pas un guillemet. Un détecteur trop large aurait fermé la
 * porte à 90 % du parc en annonçant l'avoir ouverte.
 */
export function lectureDynamique(
  corps: string,
  lecteurs: readonly string[],
  formulaires: readonly string[],
  /** Les paramètres des lecteurs LOCAUX : une clé qui porte ce nom-là est littérale à l'appel. */
  parametresLocaux: ReadonlySet<string> = new Set(),
  /** Les lecteurs LOCAUX eux-mêmes : appelés avec une variable, la clé redevient inconnue. */
  locaux: readonly string[] = [],
): boolean {
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noms = lecteurs.map(ech).join("|");
  /** La clé lue est-elle le PARAMÈTRE d'un lecteur local ? Alors ce n'est pas du dynamisme. */
  const local = (cle: string | undefined) => Boolean(cle && parametresLocaux.has(cle));
  const cherche = (re: RegExp, rang: number): boolean => {
    for (const m of corps.matchAll(re)) if (!local(m[rang])) return true;
    return false;
  };
  // (a) UN LECTEUR appelé avec une clé qui n'est pas un littéral.
  if (cherche(new RegExp(`\\b(?:${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*(?!\\s*")([A-Za-z_\`$][\\w$]*)`, "g"), 1)) return true;
  // (d) UN LECTEUR LOCAL appelé avec une variable : reconnaître le lecteur ne suffit pas, il
  //     faut que ses CLÉS soient littérales — sinon on rendrait une liste de champs amputée.
  // LE RÉCEPTEUR COMPTE, ici comme ailleurs (§118.78) : sans le regard négatif sur le point,
  // un lecteur local nommé `has` s'accrochait à `supported.has(a)` — un ENSEMBLE, sans le
  // moindre rapport avec le formulaire — et déclarait l'action illisible. Mesuré sur
  // `updateVisit`, où c'est exactement ce qui se passait.
  if (locaux.length > 0
    && new RegExp(`(?<![.\\w$])(?:${locaux.map(ech).join("|")})\\s*\\(\\s*(?!\\s*")[A-Za-z_\`$]`).test(corps)) return true;
  if (formulaires.length === 0) return false;
  const fd = formulaires.map(ech).join("|");
  // (b) LE FORMULAIRE LUI-MÊME interrogé sur une clé calculée — le récepteur compte : sans lui,
  //     `PROJECT_TEXT.has(field)` (un ENSEMBLE) faisait passer l'action pour dynamique.
  if (cherche(new RegExp(`\\b(?:${fd})\\s*\\.\\s*(?:get|getAll|has)\\s*\\(\\s*(?!\\s*")([A-Za-z_\`$][\\w$]*)`, "g"), 1)) return true;
  // (c) LE FORMULAIRE PARCOURU : on ne sait alors rien annoncer.
  return new RegExp(`\\b(?:${fd})\\s*\\.\\s*(?:entries|keys|forEach)\\s*\\(`).test(corps);
}

export function lireChamps(
  corps: string,
  enums: TableEnums,
  lecteurs: Readonly<Record<string, TypeChamp>>,
  modelesEcrits: readonly string[],
  relations: TableRelations,
  /** Les lecteurs LOCAUX, appelés avec la seule clé (`parseDate("arrivedDate")`). */
  locaux: readonly string[] = [],
  /** Les noms sous lesquels le corps tient le FORMULAIRE (paramètre et alias directs). */
  formulaires: readonly string[] = [],
  /** Les lecteurs locaux qui ne font que TESTER la présence (`(k) => formData.has(k)`). */
  presences: ReadonlySet<string> = new Set(),
  /** REMPLI par la fonction : les champs que ce corps n'a fait que TESTER (voir l'union des délégués). */
  seulementTestes?: Set<string>,
): ChampAction[] {
  const parNom = new Map<string, ChampAction>();
  /** Le nom de variable sous lequel un champ a été rangé — pour retrouver sa garde et son cast. */
  const variableDe = new Map<string, string>();
  /** Les champs seulement TESTÉS (présence) — déclarés à la fin, s'ils ne sont lus nulle part. */
  const faibles = new Set<string>();

  const poser = (nom: string, type: TypeChamp) => {
    const deja = parNom.get(nom);
    // LA CARDINALITÉ L'EMPORTE SUR CE QUE LA VALEUR DÉSIGNE — deux axes, jamais confondus
    // (§118.16). `setRowGrants` lit `getAll("rowId")` : c'est une LISTE de références. Une
    // première version laissait le nom en `…Id` écraser la liste, et Adam aurait accordé UNE
    // ligne là où la personne en demandait vingt — un faux succès parfait, l'écran affichant
    // simplement moins de droits que prévu.
    const t = type === "liste" || deja?.type === "liste"
      ? "liste"
      : estReference(nom) ? "reference" : type;
    if (!deja || t !== deja.type) {
      parNom.set(nom, {
        nom, type: t, obligatoire: deja?.obligatoire ?? false, valeurs: deja?.valeurs ?? null,
        modele: deja?.modele ?? null,
      });
    }
  };

  // LES LECTEURS SONT CEUX DU FICHIER, pas une liste de quatre noms (voir `helpersDuFichier`).
  const noms = Object.keys(lecteurs).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  for (const m of corps.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_0-9]+)\\s*=\\s*(?:await\\s+)?(${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"([^"]+)"`, "g"))) {
    poser(m[3]!, lecteurs[m[2]!]!);
    variableDe.set(m[3]!, m[1]!);
  }
  for (const m of corps.matchAll(new RegExp(`\\b(${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"([^"]+)"`, "g"))) {
    poser(m[2]!, lecteurs[m[1]!]!);
  }
  // LES LECTEURS LOCAUX prennent la CLÉ SEULE : `parseDate("arrivedDate")`. Les faire passer
  // par les motifs à deux arguments ci-dessus ne les verrait jamais.
  if (locaux.length > 0) {
    const nomsLocaux = locaux.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    for (const m of corps.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_0-9]+)\\s*=\\s*(?:await\\s+)?(${nomsLocaux})\\s*\\(\\s*"([^"]+)"`, "g"))) {
      if (presences.has(m[2]!)) { faibles.add(m[3]!); continue; }
      poser(m[3]!, lecteurs[m[2]!]!);
      variableDe.set(m[3]!, m[1]!);
    }
    for (const m of corps.matchAll(new RegExp(`\\b(${nomsLocaux})\\s*\\(\\s*"([^"]+)"`, "g"))) {
      if (presences.has(m[1]!)) { faibles.add(m[2]!); continue; }
      poser(m[2]!, lecteurs[m[1]!]!);
    }
  }
  // LE RÉCEPTEUR COMPTE (§118.79b, §118.172) : `user.access.modules.get("MEDICAL")` n'est pas un
  // champ du formulaire, `presents.has("institution")` (un ENSEMBLE de colonnes) non plus — et
  // l'import des praticiens déclarait « MEDICAL », « institution », « service » et « delegate »
  // comme des champs à remplir. Les lectures directes se bornent aux noms du formulaire.
  const recepteur = formulaires.length > 0
    ? `\\b(?:${formulaires.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*`
    : "";
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.getAll\\s*\\(\\s*"([^"]+)"`, "g"))) poser(m[1]!, "liste");
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.get\\s*\\(\\s*"([^"]+)"`, "g"))) poser(m[1]!, "texte");
  // UN TEST DE PRÉSENCE DÉCLARE un champ, il ne le TYPE pas : `formData.has("capDaysPerMonth")`
  // précède `num(formData, "capDaysPerMonth")` dans une écriture partielle, et la dernière passe
  // gagnait — un nombre redevenait du texte. Il ne pose qu'un champ que rien d'autre n'a lu.
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.has\\s*\\(\\s*"([^"]+)"`, "g"))) faibles.add(m[1]!);
  for (const nom of faibles) if (!parNom.has(nom)) { poser(nom, "texte"); seulementTestes?.add(nom); }

  for (const champ of parNom.values()) {
    const v = variableDe.get(champ.nom);
    if (v) {
      champ.obligatoire = new RegExp(`if\\s*\\(\\s*!\\s*${v}\\b|\\|\\|\\s*!\\s*${v}\\b|&&\\s*!\\s*${v}\\b`).test(corps);
      champ.valeurs = valeursAdmises(corps, v, enums);
    }
    if (!champ.valeurs) champ.valeurs = valeursAdmisesInline(corps, champ.nom, enums);
    // Une LISTE de références (`getAll("rowId")`) porte aussi son modèle : la cardinalité et ce
    // que la valeur désigne sont deux axes, et les confondre a déjà coûté (§118.16).
    if (champ.type === "reference" || (champ.type === "liste" && estReference(champ.nom))) {
      champ.modele = modeleDesigne(champ.nom, modelesEcrits, relations);
    }
  }
  return [...parNom.values()].sort((a, b) => a.nom.localeCompare(b.nom));
}

/** `X as StatutProjet` ou `LISTE.includes(x)` — deux façons dont l'ERP borne une valeur. */
function valeursAdmises(corps: string, variable: string, enums: TableEnums): readonly string[] | null {
  const cast = new RegExp(`\\b${variable}\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(corps);
  if (cast && enums[cast[1]!]) return enums[cast[1]!]!;
  for (const [nom, valeurs] of Object.entries(enums)) {
    if (new RegExp(`\\b${nom}\\b\\s*\\.\\s*(?:includes|has)\\s*\\(\\s*${variable}\\b`).test(corps)) return valeurs;
  }
  return null;
}

/** Le cas `fdStr(fd, "status") as StatutProjet`, sans variable intermédiaire. */
function valeursAdmisesInline(corps: string, nom: string, enums: TableEnums): readonly string[] | null {
  // Deux formes réelles, et la seconde a échappé à la première version : `fdStr(fd, "k") as T`
  // et `(fdStr(fd, "k") ?? "AUTRE") as T` — la parenthèse fermante n'est pas au même endroit.
  const echappe = nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lecture = `(?:fdStr|fdNum)\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"${echappe}"\\s*\\)`;
  for (const motif of [
    `${lecture}(?:\\s*\\?\\?\\s*"[^"]*")?\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`,
    `\\(\\s*${lecture}\\s*\\?\\?\\s*"[^"]*"\\s*\\)\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`,
  ]) {
    const m = new RegExp(motif).exec(corps);
    if (m && enums[m[1]!]) return enums[m[1]!]!;
  }
  return null;
}

/** Les `const X = "…"` d'un fichier — pour résoudre `userCan(user, MODULE, …)`. */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI LIT UN CHAMP DE FORMULAIRE ? — la question posée à la SOURCE, pas à une liste.
 *
 * Le lecteur ne connaissait que `fdStr`, `fdNum`, `fdDate`, `fdBool`. Or le parc en compte
 * QUATORZE : `str` (114 appels), `num` (30), `int` (9), `list`, `readIds`, `fd`, `posInt`,
 * `fdList`, `parseIds`, `checked`, `fdDateTime`… Résultat mesuré : 23 actions déclarées
 * « aucune lecture de champ trouvée dans le corps » — dont DIX-HUIT du seul
 * `regulatory-actions.ts`, où chaque champ est pourtant nommé en clair
 * (`str(formData, "priority")`). Le refus était celui du LECTEUR, pas de la source : §118.78,
 * une seconde fois, à un autre étage.
 *
 * ── SUR QUOI LA RECONNAISSANCE S'ARME ────────────────────────────────────────────────────
 *
 * Pas sur une liste de noms — elle serait fausse au quinzième helper, EN SILENCE (§118.73).
 * Sur la DÉFINITION : une fonction dont le premier paramètre est un `FormData` et le second
 * une clé `string`. C'est exactement ce qu'est un lecteur de champ, et c'est ce qui distingue
 * `str(formData, "id")` de `createStockLocation(formData, "ANNEX")` — dont le second
 * paramètre est une union de littéraux (`"HOSPITAL" | "ANNEX"`), donc une VALEUR et non une
 * clé. Ce faux positif existe dans le parc ; sans ce point, on aurait déclaré un champ nommé
 * « ANNEX » qui n'a jamais existé.
 *
 * Le TYPE vient du type de RETOUR déclaré. Un helper qui n'en déclare pas rend « texte » :
 * ce n'est pas une supposition, c'est le medium — un `FormData` ne transporte que du texte, et
 * `enFormulaire` sérialise tout. Se tromper de type sur un champ de formulaire coûte une
 * indication au modèle, jamais un appel faux (contrairement aux ARGUMENTS positionnels, où le
 * type gouverne la valeur réellement passée — d'où la rigueur inverse là-bas).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function helpersDuFichier(source: string): Record<string, TypeChamp> {
  const out: Record<string, TypeChamp> = {};
  // `function NAME(p: FormData, k: string): RET` ET `const NAME = (p: FormData, k: string): RET =>`
  const re = /(?:function|const)\s+([A-Za-z_][\w]*)\s*(?:=\s*)?(?:async\s*)?\(\s*\w+\s*:\s*FormData\s*,\s*\w+\s*:\s*string\s*\)\s*(?::\s*([^={\n]+))?/g;
  for (const m of source.matchAll(re)) {
    const retour = (m[2] ?? "").trim();
    out[m[1]!] = typeDuRetour(retour);
  }
  return out;
}

/** Ce qu'un type de retour dit du champ. Inconnu → « texte », la nature même d'un formulaire. */
function typeDuRetour(retour: string): TypeChamp {
  const t = retour.replace(/\s+/g, " ").replace(/Promise<(.*)>/, "$1").trim();
  if (/^(?:readonly )?string\s*\[\]/.test(t)) return "liste";
  if (/^number\b/.test(t)) return "nombre";
  if (/^Date\b/.test(t)) return "date";
  if (/^boolean\b/.test(t)) return "booleen";
  return "texte";
}

export function constantesDuFichier(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/^const\s+([A-Za-z_][A-Za-z_0-9]*)\s*(?::[^=]+)?=\s*"([^"]+)"/gm)) out[m[1]!] = m[2]!;
  return out;
}
