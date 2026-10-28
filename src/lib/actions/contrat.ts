/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT D'UNE ACTION — DÉRIVÉ DE SA SOURCE, JAMAIS DÉCLARÉ À CÔTÉ.
 *
 * ── POURQUOI PAS UNE TABLE ÉCRITE À LA MAIN ──────────────────────────────────────────────
 *
 * L'ERP porte 712 actions serveur. Pour qu'Adam puisse en appeler UNE QUELCONQUE, il lui faut
 * savoir ce qu'elle attend. La façon évidente — écrire une fiche par action — a été mesurée
 * ailleurs dans ce dépôt : 520 déclarations d'op, 503 propose/execute, 117 résolveurs. Elle
 * produit exactement le défaut que le dirigeant a nommé : on ajoute la capacité de retirer
 * « classe thérapeutique », pas la capacité de tout faire. Et une table écrite à la main est
 * fausse le jour où quelqu'un ajoute un champ sans y penser — silencieusement.
 *
 * §118.17 : un garde-fou s'arme sur un FAIT DU PROCESSUS, jamais sur une variable qu'un auteur
 * futur devrait penser à poser. Ici le fait est la SOURCE de l'action. Le contrat se dérive
 * d'elle, donc il ne peut pas prendre de retard sur elle.
 *
 * Contrainte qui a décidé de la forme : un fichier `"use server"` ne peut EXPORTER que des
 * fonctions asynchrones. Le contrat ne peut donc pas vivre dans le fichier de l'action ; il
 * est LU depuis lui. Ce module est la lecture — pur, sans un seul import, testable sur une
 * chaîne de caractères, et exécutable partout (§ frontière client/serveur).
 *
 * DÉCOUPÉ PAR RESPONSABILITÉ en `actions/contrat/` : `types`, `decoupage` (source → actions),
 * `formulaire` (rang, alias, délégation locale), `ecritures` (ce qu'elle écrit, délégué importé),
 * `porte`, `lecture-champs`, `arguments`. Ce fichier garde le DÉCRIVANT (`decrireAction`), le
 * point d'entrée par fichier et la phrase dite au modèle, et réexporte le reste — ses importeurs
 * n'ont pas bougé. Les morceaux n'importent que leurs frères, jamais ce fichier.
 *
 * ── CE QU'IL REFUSE DE DEVINER ───────────────────────────────────────────────────────────
 *
 * Trois choses seulement doivent être EXACTES, parce qu'une erreur sur elles produit un faux
 * succès : l'identité de l'action, les noms de ses champs, et le fait qu'elle écrive. Le reste
 * (le libellé du module, l'indice de porte) peut être approximatif SANS DANGER, parce que
 * l'action revérifie ses droits à l'exécution — la porte lue ici n'autorise rien, elle sert à
 * ne pas proposer ce que la personne ne peut pas faire.
 *
 * Quand les champs ne se lisent PAS à coup sûr, le contrat le DIT (`illisible`) au lieu de
 * rendre une liste plausible (§118.26 : le silence d'une fiche se lit comme une permission de
 * deviner). Une action illisible n'est pas appelable génériquement — sans quoi Adam la
 * appellerait avec des noms de champs inventés, recevrait `{ ok: false }` ou, pire, un
 * `{ ok: true }` n'ayant rien modifié, et annoncerait que c'est fait.
 *
 * `obligatoire: true` veut dire « le code REFUSE sans ce champ », prouvé par sa garde. `false`
 * veut dire « non prouvé obligatoire », pas « facultatif » — et l'asymétrie est voulue : se
 * tromper dans ce sens fait recevoir un refus honnête (« Le nom est obligatoire. »), se
 * tromper dans l'autre ferait déranger un humain pour rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ChampAction, ContratAction, SourceAction, TableEnums, TableRelations, TypeChamp } from "./contrat/types";
import { decouperActions, fonctionsLocales, sansCommentaires } from "./contrat/decoupage";
import { deleguesDuCorps, nomsDuFormulaire, rangDuFormulaire } from "./contrat/formulaire";
import { RE_ECRITURE, faitsEcritureImportes, importsProjet, modelesEcrits } from "./contrat/ecritures";
import { lirePorte } from "./contrat/porte";
import { fonctionsInternes, lecteursInternes } from "./contrat/internes";
import {
  HELPERS_PARTAGES, constantesDuFichier, enumsLocaux, estReference, helpersDuFichier, lecteursLocaux, lectureDynamique,
  lireChamps, modeleDesigne,
} from "./contrat/lecture-champs";
import { decouperParametres, lireArguments, lireObjetUnique, lireUnParametre } from "./contrat/arguments";

export type {
  ChampAction, ContratAction, PorteLue, SourceAction, TableEnums, TableRelations, TypeChamp,
} from "./contrat/types";
export { decouperActions, fonctionsLocales, sansCommentaires } from "./contrat/decoupage";
export { nomsDuFormulaire, rangDuFormulaire } from "./contrat/formulaire";
export { faitsEcritureImportes, importsProjet } from "./contrat/ecritures";
export {
  HELPERS_PARTAGES, constantesDuFichier, enumsLocaux, helpersDuFichier, lecteursLocaux,
} from "./contrat/lecture-champs";
export { lireArguments, lireObjetUnique, type LectureArguments } from "./contrat/arguments";

/**
 * LE CONTRAT D'UNE ACTION.
 *
 * `constantes` porte les `const X = "…"` du fichier (pour résoudre `userCan(user, MODULE, …)`),
 * `enums` les valeurs admises connues — celles du fichier ET celles du schéma, fournies par
 * l'appelant pour que ce module n'importe rien.
 */
export function decrireAction(
  src: SourceAction,
  constantes: Readonly<Record<string, string>> = {},
  enums: TableEnums = {},
  /** Les lecteurs de champ RECONNUS dans ce fichier, en plus des quatre helpers partagés. */
  lecteursDuFichier: Readonly<Record<string, TypeChamp>> = {},
  /** Ce que le schéma dit des références. Vide = aucun champ ne portera de modèle. */
  relations: TableRelations = {},
  /** Les fonctions du MÊME fichier, pour suivre une délégation d'UN niveau. */
  locales: Readonly<Record<string, SourceAction>> = {},
  /**
   * LES SYMBOLES IMPORTÉS PAR LE FICHIER (`nom` → `@/lib/...`) et LE SOURCE de chaque module,
   * par spécificateur. Les imports vivent dans l'EN-TÊTE du fichier et non dans le corps de
   * l'action : `contratsDuFichier` les résout UNE fois pour tout le fichier, et le scanner —
   * seul à lire le disque — fournit les sources.
   *
   * Vides = aucun délégué importé n'est suivi, et les faits d'écriture restent ceux du corps :
   * c'est le comportement d'AVANT ce mécanisme, donc le défaut ne s'aggrave jamais de son
   * absence.
   */
  importsFichier: Readonly<Record<string, string>> = {},
  sourcesImportees: Readonly<Record<string, string>> = {},
): ContratAction {
  const { fichier, fonction, signature, corps } = src;
  /**
   * CE QUE LE CORPS DE L'ACTION DIT D'ELLE-MÊME. `deleguesDuCorps` ne suit une délégation LOCALE
   * que lorsqu'un formulaire est passé : les branches sans formulaire n'ont rien à en unir.
   */
  const baseCorps = {
    id: `${fichier}:${fonction}`,
    fichier, fonction, avantFormulaire: 0,
    porte: lirePorte(corps, constantes),
    ecrit: RE_ECRITURE.test(corps),
    modelesEcrits: modelesEcrits(corps),
    audit: /recordAudit\s*\(/.test(corps),
  };

  // ── LE DÉLÉGUÉ IMPORTÉ, LUI, NE DÉPEND D'AUCUNE FORME D'APPEL (§118.158) ────────────────
  //
  // `faitsEcritureImportes` suit un APPEL, pas un formulaire. Il n'était pourtant lu qu'après
  // la branche des formulaires : une action SANS entrée, ou à arguments typés, qui confie son
  // écriture à un module de domaine sortait `ecrit: false`, `modelesEcrits: []`. Trouvé sur
  // `leverBlocageSite`, dont le délégué écrit `appSetting` — un réglage, c'est-à-dire l'un des
  // modèles que `generique.ts` interdit : la garde d'auto-escalade ne le VOYAIT pas, et la carte
  // aurait dit « aucune écriture en base détectée » sur le geste qui désarme un disjoncteur.
  // C'est l'angle mort que §118.119f a fermé pour les formulaires, rouvert par la porte d'à
  // côté (§118.71). Les modèles importés s'unissent à ce qu'on DÉCLARE, jamais à ce qu'on
  // attribue aux champs (voir « DEUX CONSOMMATEURS » plus bas) : l'attribution reste lue sur
  // `baseCorps.modelesEcrits`.
  const importes = faitsEcritureImportes(corps, importsFichier, sourcesImportees);
  const declares = {
    ecrit: baseCorps.ecrit || importes.ecrit,
    modelesEcrits: [...new Set([...baseCorps.modelesEcrits, ...importes.modelesEcrits])].sort(),
    audit: baseCorps.audit || importes.audit,
  };

  const rang = rangDuFormulaire(signature);
  if (rang === null) {
    // Sans argument : rien à décrire, donc APPELABLE. C'est le cas des bascules (« révoquer
    // toutes les sessions »). Une entrée typée, elle, ne passe pas par un formulaire : Adam ne
    // saurait pas fabriquer l'objet, et le dire vaut mieux que de tenter.
    if (signature === "") {
      return { ...baseCorps, ...declares, appel: "sans-entree", champs: [], illisible: null };
    }
    // L'OBJET UNIQUE D'ABORD : `lireArguments` le refuserait pour « pas une valeur simple »,
    // alors que ses membres sont écrits dans la signature (§118.87).
    const objet = lireObjetUnique(signature);
    const lue = objet && "champs" in objet ? objet : objet ?? lireArguments(signature);
    const forme = objet ? "objet" as const : "arguments" as const;
    return "champs" in lue
      ? {
          ...baseCorps, ...declares, appel: forme, illisible: null,
          champs: lue.champs.map((ch) => (ch.type === "reference" || (ch.type === "liste" && estReference(ch.nom))
            ? { ...ch, modele: modeleDesigne(ch.nom, baseCorps.modelesEcrits, relations) }
            : ch)),
        }
      : {
          ...baseCorps, ...declares, appel: forme, champs: [],
          illisible: `entrée typée (${signature}) — ${lue.refus}`,
        };
  }

  // ── CE QUI PRÉCÈDE LE FORMULAIRE ────────────────────────────────────────────────────────
  //
  // Le paramètre JUSTE AVANT est l'état précédent de `useActionState` : on le remplit avec
  // `undefined`, ce qu'un premier envoi lui donne de toute façon. Il doit l'ACCEPTER — sans
  // cette vérification, un jour quelqu'un écrirait `(id, autreChose, formData)` et l'on
  // passerait `undefined` à une valeur obligatoire, en silence (§118.78).
  const params = decouperParametres(sansCommentaires(signature)).map((p) => p.trim()).filter(Boolean);
  const etat = rang >= 1 ? params[rang - 1] ?? "" : "";
  if (rang >= 1 && !/\|\s*undefined\b/.test(etat) && !/^\w+\?\s*:/.test(etat)) {
    return {
      ...baseCorps, appel: "etat-formulaire" as const, champs: [],
      illisible: `le paramètre « ${etat.split(":")[0]!.trim()} » précède le formulaire sans accepter `
        + `« undefined » — ce n'est pas l'état précédent d'un formulaire React, et on ne devine pas sa valeur`,
    };
  }
  const avant: ChampAction[] = [];
  for (const brut of params.slice(0, Math.max(0, rang - 1))) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) {
      return {
        ...baseCorps, appel: "arguments-etat-formulaire" as const, champs: [],
        illisible: `entrée mixte (${sansCommentaires(signature).replace(/\s+/g, " ").trim()}) — le paramètre ${lu.refus}`,
      };
    }
    avant.push({ ...lu.champ, modele: modeleDesigne(lu.champ.nom, baseCorps.modelesEcrits, relations) });
  }
  const appel = rang === 0
    ? "formulaire" as const
    : avant.length > 0 ? "arguments-etat-formulaire" as const : "etat-formulaire" as const;

  const lecteurs = { ...HELPERS_PARTAGES, ...lecteursDuFichier };
  const formulaires = nomsDuFormulaire(signature, corps);
  const locaux = lecteursLocaux(corps, formulaires, lecteurs);
  const tousLecteurs = { ...lecteurs, ...locaux.lecteurs };
  const delegues = deleguesDuCorps(corps, formulaires, locales, new Set(Object.keys(tousLecteurs)));

  // ── CE QU'UNE DÉLÉGATION ÉCRIT EST CE QUE L'ACTION ÉCRIT ────────────────────────────────
  //
  // MESURÉ, et c'était mon propre défaut. `createSector` valide son entrée puis passe le
  // formulaire à `ecrireSecteur`, qui écrit TROIS tables et enregistre un audit. Le corps de
  // l'action, lui, n'écrit rien : elle sortait donc `ecrit: false`, `modelesEcrits: []`,
  // `audit: false` — une action qui écrit trois tables DÉCRITE comme une lecture, en silence.
  //
  // Deux coûts nommables, et le second est le vrai. La carte de confirmation doit dire ce que
  // le geste TOUCHE (§118.83) : elle aurait présenté une écriture comme une consultation. Et
  // `actions/generique.ts` arme sa garde d'auto-escalade sur le MODÈLE ÉCRIT lu dans la source
  // (§118.74) : une action qui délègue son écriture est INVISIBLE à cette garde — c'est l'angle
  // mort du FAIT que §118.78 a déjà payé sur `mission-runtime-actions`, et le refermer là sans
  // le refermer ici laisserait une porte non gardée à côté d'une porte gardée (§118.71).
  //
  // Le remède est celui que §118.87c a déjà posé pour les CHAMPS : l'union, un seul niveau,
  // dans le seul fichier dont on a le texte. Elle ne peut qu'ÉLARGIR ce qu'on déclare écrire —
  // donc au pire elle refuse davantage, jamais moins.
  //
  // ── ET LE DÉLÉGUÉ D'UN AUTRE FICHIER ───────────────────────────────────────────────────
  //
  // `deleguesDuCorps` ne suit un appel que lorsqu'il reçoit le FORMULAIRE — c'est ce qui lui
  // permet d'en lire les champs. Une action qui sort son écriture dans un module de DOMAINE
  // (`creerDemandeEtatStock({ actorId, … })`) ne passe aucun formulaire, et sortait donc
  // `ecrit: false` : le mensonge d'au-dessus, par la porte d'à côté. MESURÉ avant d'y toucher :
  // 49 actions du parc portaient un nom d'écriture et se déclaraient sans écriture.
  //
  // `faitsEcritureImportes` est donc un SECOND mécanisme, plus étroit — trois faits, jamais les
  // champs, un seul niveau. L'écrivain ne peut PAS revenir dans le fichier de l'action : un
  // `"use server"` n'exporte que des fonctions asynchrones, et chacune devient un point
  // d'entrée appelable SANS la garde de l'action. Sortir l'écriture était donc obligatoire, et
  // rendre la dérivation aveugle n'était pas une option. (`importes` est lu plus haut, avant
  // l'aiguillage des formes d'appel : il vaut pour toutes.)
  //
  // ── DEUX CONSOMMATEURS, DEUX BESOINS — et les confondre a coûté 187 champs ──────────────
  //
  // `modelesEcrits` sert deux questions qui ne veulent pas la même chose :
  //   · la garde d'auto-escalade veut TOUS les modèles touchés — plus large est plus sûr ;
  //   · `lireChamps` cherche le modèle PRIMAIRE auquel attribuer une référence — plus large
  //     est plus AMBIGU, donc il renonce à nommer.
  //
  // MESURÉ en unissant les deux : `notification`, `auditLog` et `expenseOrder` entrant dans la
  // liste, 198 actions ont perdu l'attribution de leurs références et le parc est passé de 546
  // champs modélisés à 359 — le plancher de désignation (500) est tombé, et avec lui la
  // capacité d'Adam à viser une ligne par son nom plutôt que par un `cuid` (§118.85).
  //
  // Les modèles d'un délégué IMPORTÉ n'entrent donc PAS dans ce que lit `lireChamps` : ils
  // s'unissent au contrat APRÈS, là où seule la garde les consulte. `ecrit` et `audit`, eux,
  // sont des booléens sans effet sur l'attribution : ils s'unissent tout de suite.
  //
  // ── UN DÉLÉGUÉ INTERNE ÉCRIT AUSSI PAR SES ÉCRIVAINS IMPORTÉS ─────────────────────────────
  //
  // Une aide de `actions/internes/` est le code du fichier, déplacé (`contrat/internes.ts`) : ce qu'elle confie à
  // un écrivain importé, l'action le confiait quand ce code était dans son corps. On le suit donc comme s'il y
  // était — un niveau, par son appel dans le corps du délégué —, et ces modèles-là rejoignent ce qu'on DÉCLARE,
  // jamais l'attribution des champs (même règle que les délégués importés ci-dessous).
  const importesInternes = delegues
    .filter((d) => d.interne)
    .map((d) => faitsEcritureImportes(d.corps, d.interne!.imports, sourcesImportees));
  const base = {
    ...baseCorps,
    ecrit: baseCorps.ecrit || delegues.some((d) => RE_ECRITURE.test(d.corps)) || importes.ecrit || importesInternes.some((f) => f.ecrit),
    modelesEcrits: [...new Set([...baseCorps.modelesEcrits, ...delegues.flatMap((d) => modelesEcrits(d.corps))])],
    audit: baseCorps.audit || delegues.some((d) => /recordAudit\s*\(/.test(d.corps)) || importes.audit || importesInternes.some((f) => f.audit),
  };
  /** Les modèles à DÉCLARER — l'union complète, une fois l'attribution des champs faite. */
  const modelesDeclares = [...new Set([
    ...base.modelesEcrits, ...importes.modelesEcrits, ...importesInternes.flatMap((f) => f.modelesEcrits),
  ])].sort();

  if (lectureDynamique(corps, Object.keys(lecteurs), formulaires, locaux.parametres, Object.keys(locaux.lecteurs))) {
    return {
      ...base, modelesEcrits: modelesDeclares, appel, champs: [],
      illisible: "les noms de champs sont calculés à l'exécution — la source ne les énonce pas",
    };
  }

  const testesSeulement = new Set<string>();
  const propres = lireChamps(
    corps, enums, tousLecteurs, base.modelesEcrits, relations, Object.keys(locaux.lecteurs), formulaires, locaux.presences,
    testesSeulement,
  );

  // CE QUE LES FONCTIONS DU FICHIER LISENT DANS LE MÊME FORMULAIRE (voir `deleguesDuCorps`).
  //
  // UN DÉLÉGUÉ DYNAMIQUE N'EFFACE PAS CE QU'ON SAIT — mesuré, et j'avais d'abord tranché dans
  // l'autre sens. `createRequest` lit son titre, son type et sa société EN CLAIR, puis appelle
  // `collectAllFields(formData)`, qui ramasse les champs personnalisés `f_*`. Rendre l'action
  // illisible pour cette raison coûtait une capacité RÉELLE — créer une demande administrative
  // — pour protéger d'un défaut qui n'existe pas : un champ personnalisé en plus n'a jamais
  // empêché l'action de réussir. Un refus à tort est pire que le défaut qu'on corrige (§118.27).
  // On IGNORE donc ce délégué-là, et l'on ne le déclare illisible que s'il ne reste RIEN.
  let delegueMuet: string | null = null;
  const parDelegation: ChampAction[] = [];
  for (const d of delegues) {
    const fdD = nomsDuFormulaire(d.signature, d.corps);
    // Un délégué interne lit avec les lecteurs de SON module, en plus de ceux du fichier.
    const lecteursD = d.interne ? { ...d.interne.lecteurs, ...lecteurs } : lecteurs;
    const locD = lecteursLocaux(d.corps, fdD, lecteursD);
    if (lectureDynamique(d.corps, Object.keys(lecteursD), fdD, locD.parametres, Object.keys(locD.lecteurs))) {
      delegueMuet ??= d.fonction;
      continue;
    }
    parDelegation.push(...lireChamps(
      d.corps, enums, { ...lecteursD, ...locD.lecteurs }, base.modelesEcrits, relations, Object.keys(locD.lecteurs),
      fdD, locD.presences,
    ));
  }
  // UN TEST DE PRÉSENCE CÈDE À UNE LECTURE TYPÉE, et pas seulement dans le même corps. Une
  // écriture partielle teste `formData.has("startDate")` puis passe la main à `readFields`, qui lit
  // la DATE : le corps de l'action était lu en premier et « startDate : texte » gagnait l'union —
  // une date, une liste de parties, redevenues du texte dans le contrat (mesuré sur
  // `updateLegalDocument`, §118.194). La règle est celle du corps unique : un champ seulement
  // testé ne se déclare que si personne d'autre ne le lit.
  const typesParDelegation = new Set(parDelegation.map((ch) => ch.nom));
  const vus = new Set<string>();
  const duFormulaire = [...propres.filter((ch) => !(testesSeulement.has(ch.nom) && typesParDelegation.has(ch.nom))), ...parDelegation]
    .filter((ch) => (vus.has(ch.nom) ? false : (vus.add(ch.nom), true)))
    .sort((a, b) => a.nom.localeCompare(b.nom));
  // UN ARGUMENT ET UN CHAMP DE MÊME NOM ne peuvent pas coexister : l'entrée n'aurait qu'une
  // valeur pour deux places, et l'on ne saurait pas laquelle la personne a voulu remplir.
  const collision = avant.map((a) => a.nom).filter((n) => duFormulaire.some((f) => f.nom === n));
  if (collision.length > 0) {
    return {
      ...base, modelesEcrits: modelesDeclares, appel, champs: [],
      illisible: `« ${collision.join(", ") }» est à la fois un argument et un champ du formulaire — `
        + `une seule valeur ne peut pas remplir deux places`,
    };
  }
  const champs = [...avant, ...duFormulaire];
  if (duFormulaire.length > 0) {
    return { ...base, modelesEcrits: modelesDeclares, appel, champs, avantFormulaire: avant.length, illisible: null };
  }

  return {
    ...base, modelesEcrits: modelesDeclares, appel, champs: [],
    illisible: delegueMuet
      ? `« ${delegueMuet} » lit le formulaire pour cette action et calcule ses noms de champs à `
        + `l'exécution — rien dans la source n'énonce l'entrée attendue`
      : "aucune lecture de champ trouvée dans le corps — l'entrée attendue reste inconnue",
  };
}

/** Tous les contrats d'un fichier — le point d'entrée pur, testable sur une chaîne. */
export function contratsDuFichier(
  fichier: string,
  source: string,
  enumsSchema: TableEnums = {},
  relations: TableRelations = {},
  /** Le source des modules `@/lib/...` importés par ce fichier — fourni par le scanner. */
  sourcesImportees: Readonly<Record<string, string>> = {},
): ContratAction[] {
  const constantes = constantesDuFichier(source);
  const enums = { ...enumsSchema, ...enumsLocaux(source) };
  const lecteurs = helpersDuFichier(source);
  // UNE FOIS PAR FICHIER : les imports sont un fait de l'en-tête, pas de chaque action.
  const imports = importsProjet(source);
  // LES AIDES INTERNES COMPTENT COMME LE FICHIER (`contrat/internes.ts`) : ses fonctions et ses lecteurs, sous ceux
  // du fichier — une fonction ou un lecteur défini sur place garde la main.
  const locales = { ...fonctionsInternes(imports, sourcesImportees), ...fonctionsLocales(source) };
  Object.assign(lecteurs, { ...lecteursInternes(imports, sourcesImportees), ...lecteurs });
  return decouperActions(fichier, source).map((a) =>
    decrireAction(a, constantes, enums, lecteurs, relations, locales, imports, sourcesImportees));
}

/**
 * CE QU'ON DIT AU MODÈLE. Une phrase par action, lisible par un humain comme par un modèle —
 * et qui NOMME son ignorance au lieu de la taire.
 */
export function direContrat(c: ContratAction): string {
  if (c.illisible) return `${c.id} — non appelable directement : ${c.illisible}`;
  if (c.champs.length === 0) return `${c.id} — sans entrée.`;
  const champ = (ch: ChampAction) => {
    const marque = ch.obligatoire ? "" : " (facultatif)";
    const val = ch.valeurs ? ` ∈ {${ch.valeurs.join(", ")}}` : "";
    // CE QU'UNE RÉFÉRENCE DÉSIGNE, quand le schéma le dit : sans cette mention, un modèle ne
    // peut pas savoir qu'il a le droit d'écrire un NOM là où le type dit « reference », et il
    // invente un identifiant ou renonce. Ce que le code accepte, la fiche doit le dire (§118.19).
    const quoi = ch.modele ? `→${ch.modele}` : "";
    return `${ch.nom} : ${ch.type}${quoi}${val}${marque}`;
  };
  return `${c.id} — ${c.champs.map(champ).join(" ; ")}`;
}
