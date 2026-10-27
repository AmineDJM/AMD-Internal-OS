/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS D'UNE DEMANDE Ad & Pro — module PUR (sa seule dépendance est le SOCLE).
 *
 * ── LA RÈGLE EN VIGUEUR : DÉCISION DE LA DIRECTION DU 27/10/2026 ─────────────────────────
 *
 * « Peu importe le créateur, la demande passe d'abord par son N+1 — le National Sales si c'est un
 * délégué (le KAM, c'est le délégué), sinon le Directeur des opérations, toujours —, puis la
 * Direction Marketing, qui prévalide. Le DG valide uniquement à la fin, le total, et seulement s'il
 * dépasse le seuil. Si c'est le DG qui crée, la Direction Marketing prévalide, et puis voilà ; pareil
 * pour le Super Admin. Pareil pour les prises en charge, les événements et les autres. » Telles que
 * `parcoursAdPro` les rend :
 *
 *     délégué (KAM)        →  National Sales  →  Directeur des opérations  →  DIRECTION MARKETING
 *     tout autre demandeur →                     Directeur des opérations  →  DIRECTION MARKETING
 *     Dir. des opérations, DG, Direction, Super Admin  →                         DIRECTION MARKETING
 *     Direction Marketing  →  prévalidée d'office
 *
 * La porte du DG n'est plus une étape : elle est toujours dans le TAMIS, et le DG statue sur le
 * TOTAL des postes (`lib/seuils/porte-dg-total.ts`, `ad-pro/porte-dg.ts`).
 *
 * ── LES RÈGLES QUI ONT PRÉCÉDÉ (22/09 et 28/09/2026), pour lire les instances nées avant ─────
 *
 * Une instance garde le parcours FIGÉ à sa naissance (`finalSlug`, `skippedSlugs`) : celles nées sous
 * l'ancienne règle (KAM → National Sales seul ; « tout autre → direct Direction Marketing » ; la porte
 * du DG franchie sous le seuil ; la demande de la Direction Marketing tranchée par la Direction des
 * opérations) terminent leur chemin tel qu'il leur avait été promis.
 *
 * ── LA PROPRIÉTÉ QUI PORTAIT TOUT LE RESTE EST TOMBÉE, ET C'EST LE FAIT DU JOUR ─────────
 *
 * Le lot précédent reposait sur ceci, écrit ici en toutes lettres : « le parcours est une
 * TRONCATURE, pas un tamis : chaque chaîne est une tranche CONTIGUË de la même colonne
 * vertébrale, donc deux bornes suffisent ». La nouvelle règle la REND FAUSSE, et aucun ordre
 * d'étapes ne la sauve : un KAM traverse `preliminary` SANS `final`, un National Sales traverse
 * `final` SANS `preliminary`. Ce sont deux filtres DIFFÉRENTS à deux positions différentes ;
 * dans une colonne linéaire, leurs deux tranches ne peuvent pas être contiguës à la fois.
 *
 * On ne force donc pas la contiguïté par une réécriture de la colonne — ce serait déformer le
 * circuit pour plaire à une propriété d'implémentation. Le parcours devient ce qu'il est : un
 * TAMIS déclaré. Deux faits au lieu d'un, parce qu'ils répondent à deux questions distinctes
 * (§118.16) — `decision` dit OÙ la chaîne s'arrête, `ignorees` dit ce qu'elle NE TRAVERSE PAS.
 * Les confondre les ferait diverger : une demande s'arrêterait là où l'écran annonce qu'elle
 * continue.
 *
 * Ce que ce changement DÉPLACE (§118.61) : l'émission financière héritée. Elle ne se lisait que
 * sur la QUEUE coupée après la borne ; une étape SAUTÉE AU MILIEU portant `emitExpenseOrder`
 * aurait vu son ordre de dépense disparaître — l'argent accordé, rien d'engagé, aucune étape en
 * échec. `etapesNonAtteintes` couvre donc les deux : la queue ET le tamis.
 *
 * ── LE DIRECTEUR DES OPÉRATIONS EST LE RÔLE `OPERATIONS_DIRECTOR` (27/10/2026) ──────────
 *
 * L'étape `final` était tenue par le rôle `DIRECTION` (lecture de 09/2026). La Direction l'a tranché :
 * « il faut que ce soit lui, l'Operations Director ». La graine (`ETAPE_DIRECTEUR_OPERATIONS`) et la
 * migration `20270131130500_adpro_circuit_prevalidation` le posent ; tant qu'aucun compte actif ne
 * porte ce rôle, la migration laisse `DIRECTION` à ses côtés pour qu'aucune demande ne reste sans
 * validateur. Le rôle reçoit les modules du pôle Ad & Pro (`rbac.ts`, `AD_PRO_OPERATIONS`).
 *
 * ── POURQUOI CE MODULE EXISTE, ET POURQUOI IL EST PUR ───────────────────────────────────
 *
 * Trois couches se posent la même question et aucune n'a le droit d'importer les deux autres
 * (§118.16, §118.72, §118.97) : `origin.ts` la pose à la CRÉATION (par où l'on entre),
 * `engine.ts` à chaque AVANCE (y a-t-il une étape après celle-ci ?), et la vue caviardée à
 * l'AFFICHAGE (cet avis est-il encore confidentiel ?). Trois réponses écrites séparément
 * auraient divergé, et le symptôme aurait été le pire de tous : une demande qui s'arrête là où
 * l'écran annonce qu'elle continue.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES RÔLES viennent du SOCLE (`personnes/roles-vente.ts`) et sont RÉEXPORTÉS ici.
 *
 * « Est-ce un KAM ? » est une lecture de ce qu'une personne EST : la déduction de la Business
 * Unit en a besoin autant que ce circuit, et `ad-pro/` n'a pas le droit d'importer `workflow/`
 * — `domains.test.ts` l'a compté et refusé (70 traversées pour un plafond de 69). La lecture est
 * donc au socle, à côté de `designation.ts` et `joignabilite.ts`, et ce module la réexporte pour
 * que ses appelants n'aient pas à savoir d'où elle vient.
 */
import { estDirectionMarketing, estKam, ROLE_DIRECTION_MARKETING, ROLE_KAM, type RolesPersonne } from "@/lib/personnes/roles-vente";
import type { WorkflowCategory } from "./types";

export { ROLE_KAM, ROLE_DIRECTION_MARKETING, estKam, estDirectionMarketing };
export type DemandeurParcours = RolesPersonne;

/** Les slugs de la colonne vertébrale Ad & Pro, DANS L'ORDRE où on les traverse. */
export const SLUG_PRELIMINAIRE = "preliminary" as const;
/** La porte du Directeur Général — franchie automatiquement sous le seuil (§118.138). */
export const SLUG_DG = "dg" as const;
export const SLUG_DIRECTION = "final" as const;
export const SLUG_MARKETING = "marketing" as const;


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS, EN UNE SEULE TABLE — entrée ET sortie décidées au même endroit.
 *
 * Écrire l'entrée dans `origin.ts` et la sortie ici aurait suffi à produire le défaut suivant,
 * qui a été trouvé en raisonnant sur un cas réel avant de l'écrire : un délégué médical qui
 * porte AUSSI la casquette Direction Marketing (rôle secondaire) est un KAM au sens du texte,
 * mais sa demande ne peut pas être arbitrée par lui-même. Une sortie décidée sur le seul fait
 * « c'est un KAM » l'aurait bornée à une étape SITUÉE AVANT celle où la demande se trouve : la
 * vue aurait masqué l'étape courante et l'écran n'aurait plus montré aucune action à prendre.
 * Le rang et le métier ne se confondent pas ; ils sont lus ensemble, ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface Parcours {
  /** Le slug de l'étape d'ENTRÉE — celle où la demande se pose en naissant. */
  entree: string;
  /**
   * Le slug de l'étape qui TRANCHE, ou `null` quand c'est la dernière de la définition.
   * `null` est le repli délibéré : rien à borner, donc la chaîne va jusqu'au bout.
   */
  decision: string | null;
  /**
   * LES ÉTAPES DE LA COLONNE VERTÉBRALE QUE CETTE DEMANDE NE TRAVERSE PAS.
   *
   * Le tamis, et il ne contient JAMAIS que des slugs de la colonne vertébrale connue. Une étape
   * qu'un Super Admin a ajoutée n'y figure pas, donc elle est TRAVERSÉE : sauter en silence une
   * étape que quelqu'un a délibérément posée serait défaire sa décision, et une garde qui écarte
   * ce qu'elle ne comprend pas est désactivée dans la semaine (§118.16).
   */
  ignorees: readonly string[];
  /**
   * PRÉVALIDÉE D'OFFICE (27/10) : la demande de la Direction Marketing n'attend personne — l'étape de
   * prévalidation est franchie à la naissance, au nom de sa créatrice, et le journal le dit.
   */
  dOffice?: boolean;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT DE PRÉVALIDATION — décision de la Direction du 27/10/2026, pour TOUTES les natures à
 * circuit (sponsoring, PEC nationale et internationale, événement, « autre »).
 *
 * « Peu importe le créateur, la demande passe d'abord par son N+1 — le National Sales si c'est un
 * délégué (le KAM, c'est le délégué), sinon le Directeur des opérations, toujours —, puis la
 * Direction Marketing, qui PRÉVALIDE. » Le DG n'est PAS sur cette route : il valide à la FIN, le
 * TOTAL des postes de la demande, et seulement au-dessus du seuil (`ad-pro/porte-dg.ts`).
 *
 *     Délégué médical (KAM) →  National Sales  →  Directeur des opérations  →  Direction Marketing
 *     National Sales        →                     Directeur des opérations  →  Direction Marketing
 *     tout autre demandeur  →                     Directeur des opérations  →  Direction Marketing
 *       (Manager Promotion médicale compris)
 *     Directeur des opérations, DG, Direction, Super Admin  →                  Direction Marketing
 *     Direction Marketing   →  prévalidée D'OFFICE (personne ne prévalide sa propre demande, et
 *                              personne au-dessus d'elle n'a à le faire — dit au journal)
 *
 * La porte du DG (`dg`) est donc TOUJOURS dans le tamis : l'étape peut encore exister dans une
 * définition en base, elle n'est plus traversée par une demande née après la règle. Une instance
 * née AVANT garde la chaîne qui lui avait été promise (son tamis est gelé à la naissance).
 *
 * Il n'y a plus de borne : la Direction Marketing est la dernière étape et c'est elle qui conclut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function parcoursAdPro(args: {
  /** Rang dans la hiérarchie d'approbation : 0 demandeur ordinaire · 1 National Sales · 2 Direction Marketing / Manager Promotion médicale · 3 Direction, DG, Directeur des opérations, Super Admin. */
  rang: number;
  /** Le demandeur exerce-t-il comme délégué médical (le KAM) ? */
  kam: boolean;
  /** Le demandeur EST-il la Direction Marketing (rôle principal ou secondaire) ? Sa demande est prévalidée d'office. */
  directionMarketing?: boolean;
  /**
   * LA NATURE DE LA DEMANDE — OBLIGATOIRE. Elle ne change plus la route (27/10 : « pareil pour les
   * prises en charge, les événements et les autres »), mais un appelant qui l'omettrait se tromperait
   * en silence le jour où une nature reprendrait une règle à elle (§118.127b).
   */
  categorie: WorkflowCategory;
}): Parcours {
  const tamisCommun = [SLUG_DG];
  // LA DIRECTION, LE DG, LE DIRECTEUR DES OPÉRATIONS, LE SUPER ADMIN : personne au-dessus d'eux dans la
  // ligne — leur demande va directement à la prévalidation de la Direction Marketing.
  if (args.rang >= 3) {
    return { entree: SLUG_MARKETING, decision: null, ignorees: [SLUG_PRELIMINAIRE, ...tamisCommun, SLUG_DIRECTION], dOffice: false };
  }
  // LA DIRECTION MARKETING ELLE-MÊME : prévalidée d'office. Le rang l'emporte sur le métier (§118.142) :
  // quiconque porte la Direction Marketing (rang 2), même délégué par ailleurs, suit la branche de ce rang.
  if (args.rang === 2 && args.directionMarketing) {
    return { entree: SLUG_MARKETING, decision: null, ignorees: [SLUG_PRELIMINAIRE, ...tamisCommun, SLUG_DIRECTION], dOffice: true };
  }
  // LE DÉLÉGUÉ MÉDICAL (le KAM) de rang 0 : son National Sales, puis le Directeur des opérations.
  if (args.rang === 0 && args.kam) {
    return { entree: SLUG_PRELIMINAIRE, decision: null, ignorees: [...tamisCommun], dOffice: false };
  }
  // TOUT AUTRE DEMANDEUR — National Sales, Manager Promotion médicale, demandeur ordinaire : le
  // Directeur des opérations, puis la Direction Marketing.
  return { entree: SLUG_DIRECTION, decision: null, ignorees: [SLUG_PRELIMINAIRE, ...tamisCommun], dOffice: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS TEL QU'IL SERA GELÉ EN BASE — une seule lecture, deux faits.
 *
 * Les trois couches ont besoin des DEUX faits (où la chaîne s'arrête, ce qu'elle ne traverse
 * pas) et ils viennent de la MÊME branche : les calculer par deux appels séparés laisserait un
 * appelant lire l'un sans l'autre, et le symptôme serait une demande qui saute une étape sans
 * que la vue le dise, ou l'inverse (§118.5).
 *
 * ── UNE SEULE RÈGLE DE FILTRAGE, ET ELLE PROTÈGE DANS LE BON SENS ───────────────────────
 *
 * Le parcours ne nomme que des étapes qui EXISTAIENT à la naissance de la demande. Une étape
 * absente de la définition n'est donc ni borne ni ignorée, et si un Super Admin l'AJOUTE plus
 * tard, elle est TRAVERSÉE. C'est le sens sûr : sauter en silence une étape que quelqu'un vient
 * de poser délibérément défait sa décision sans une ligne pour le dire, alors qu'une étape de
 * validation en trop se voit, se lit et se franchit (§118.16, §118.27).
 */
export function parcoursEffectif(
  demandeur: DemandeurParcours | null | undefined,
  slugsDeLaDefinition: readonly string[],
  rang: number,
  categorie: WorkflowCategory,
): Parcours {
  const brut = parcoursAdPro({ rang, kam: estKam(demandeur), directionMarketing: estDirectionMarketing(demandeur), categorie });
  const connus = new Set(slugsDeLaDefinition);
  return {
    entree: brut.entree,
    decision: brut.decision !== null && connus.has(brut.decision) ? brut.decision : null,
    ignorees: brut.ignorees.filter((slug) => connus.has(slug)),
    dOffice: brut.dOffice === true,
  };
}

/**
 * CETTE ÉTAPE EST-ELLE CELLE QUI TRANCHE ? Une seule lecture de la borne, pour les quatre
 * questions qui en dépendent — y a-t-il une suite, faut-il projeter l'accord définitif, faut-il
 * émettre, et l'avis est-il encore confidentiel.
 */
export function estDecisionnaire(slugEtape: string, borne: string | null): boolean {
  return borne !== null && slugEtape === borne;
}

/**
 * CETTE ÉTAPE EST-ELLE HORS DU PARCOURS DE CETTE DEMANDE ? Le tamis, lu une seule fois.
 *
 * Une étape ignorée n'est pas « franchie automatiquement » : elle n'est pas SUR la route. La
 * distinction compte, parce qu'un franchissement automatique se trace (il a eu lieu, sous le
 * seuil) alors qu'une étape hors parcours n'a rien à tracer — tracer un franchissement que
 * personne n'a demandé ferait lire au demandeur qu'un validateur a laissé passer sa demande.
 */
export function estIgnoree(slugEtape: string, ignorees: readonly string[]): boolean {
  return ignorees.includes(slugEtape);
}

/**
 * LE SEUIL EFFECTIF d'une étape — ce en dessous de quoi elle est franchie automatiquement.
 *
 * Deux sources, et l'ORDRE entre elles est la moitié de la règle :
 *   • un seuil posé À LA MAIN sur l'étape (champ « Seuil DZD » du constructeur de circuits)
 *     l'emporte TOUJOURS. Le Super Admin qui l'a écrit a pris une décision pour CE circuit ; la
 *     valeur globale ne doit pas l'écraser en silence ;
 *   • à défaut, et pour la seule porte du DG, le seuil GLOBAL des réglages. C'est lui que la
 *     demande vise — « ce seuil doit pouvoir être configuré par le super admin », au singulier —
 *     et c'est lui que lit aussi le matériel promotionnel, qui n'a pas d'étapes en base.
 *
 * Toute autre étape sans seuil écrit n'en a pas : rendre ici une valeur par défaut ferait
 * franchir automatiquement des étapes que personne n'a demandé de franchir.
 */
export function seuilFranchissement(
  slug: string,
  seuilDeLEtape: number | null | undefined,
  seuilDgGlobal: number | null | undefined,
): number | null {
  if (seuilDeLEtape != null && seuilDeLEtape > 0) return seuilDeLEtape;
  if (slug !== SLUG_DG) return null;
  return seuilDgGlobal != null && seuilDgGlobal > 0 ? seuilDgGlobal : null;
}

/**
 * LE DIRECTEUR GÉNÉRAL DOIT-IL VALIDER ce montant ? RÉEXPORTÉ DU SOCLE.
 *
 * Cette fonction PROMETTAIT ici une « lecture unique, partagée par le circuit Ad & Pro et par le
 * matériel promotionnel », et c'était faux deux fois : son seul importeur du dépôt était son
 * propre test (§118.14, §118.49), et `promo-material/circuit.ts` recopiait la même arithmétique
 * dans `etapeApplicable` parce que le domaine `adpro` n'a pas le droit d'importer le domaine
 * `tasks` (`platform/domains.ts`). Deux copies qui s'accordaient par chance, et un commentaire
 * qui affirmait un partage que le code n'avait pas (§118.116).
 *
 * La règle vit désormais au SOCLE (`lib/seuils/ad-pro.ts`, zéro import), lue par les trois
 * couches qui en ont besoin sans avoir le droit de se parler : ce circuit, le matériel
 * promotionnel, et le CENTRE DE VALIDATION Ad & Pro. Le nom est conservé ici parce qu'il est
 * celui que ce circuit emploie ; il ne désigne plus qu'une seule implémentation.
 */
export { porteDgRequise as dgRequis } from "@/lib/seuils/ad-pro";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉTAPES QUE CETTE INSTANCE N'ATTEINDRA JAMAIS — la queue coupée ET le tamis.
 *
 * Sert à UNE chose, et elle est nécessaire : une émission financière déclarée sur une étape que
 * la demande n'atteindra pas doit être HONORÉE par l'étape qui tranche. Sans cela, une demande
 * sort APPROUVÉE, avec son budget accordé écrit en base, et Finance ne reçoit RIEN — l'argent
 * est accordé et rien n'est engagé, sans une seule étape en échec. Le faux succès parfait, sur
 * la seule chose que la dépense attend.
 *
 * ── POURQUOI CETTE FONCTION A DÛ S'ÉLARGIR, ET CE QUE COÛTAIT L'ANCIENNE ────────────────
 *
 * Elle ne lisait que la QUEUE coupée après la borne (`queueCoupee`), parce que le parcours était
 * alors une TRONCATURE. Depuis que c'est un TAMIS, une étape peut être sautée AU MILIEU : celle
 * qui porte `emitExpenseOrder` aurait vu son ordre de dépense disparaître, exactement dans le
 * silence que le paragraphe ci-dessus décrit. Le paramètre `ignorees` est donc OBLIGATOIRE et
 * sans valeur par défaut : un appelant qui l'oublierait retomberait sur le défaut d'origine, en
 * silence, et c'est le typecheck qui doit le lui dire (§118.61).
 *
 * L'ÉTAPE QUI TRANCHE N'EST JAMAIS RENDUE : elle EST atteinte, c'est elle qui hérite. Le garde
 * tient même si un appelant compose une paire incohérente (une borne qui figure aussi dans le
 * tamis) — la paire serait fautive, mais rien ne doit faire hériter une étape d'elle-même.
 *
 * On ne DÉPLACE pas les drapeaux dans la définition : le Super Admin les a posés là où il les
 * voulait, et une définition réécrite par le code serait une seconde vérité (§118.5). C'est
 * l'exécution qui hérite, et seulement de ce qui n'est réellement pas atteint.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function etapesNonAtteintes(
  slugsOrdonnes: readonly string[],
  decision: string | null,
  ignorees: readonly string[],
): string[] {
  const tamis = new Set(ignorees);
  const rangDecision = decision === null ? -1 : slugsOrdonnes.indexOf(decision);
  return slugsOrdonnes.filter((slug, i) => {
    if (i === rangDecision) return false;
    if (rangDecision >= 0 && i > rangDecision) return true;
    return tamis.has(slug);
  });
}
