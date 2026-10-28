/**
 * RBAC — l'ACCÈS EFFECTIF d'une personne : les types de session (`SessionUser`, `EffectiveAccess`),
 * l'accès attribué (`accesAttribue`), les accès temporaires des validateurs et `getAccess` (base,
 * intérims, pipeline Regulatory, sections), mis en cache par requête. Réexporté par la porte `lib/rbac`.
 */

import { cache } from "react";
import type { AccessScope, EntityType, UserAccess, UserRole } from "@prisma/client";
import { prisma } from "../prisma";
import { isRetiredModule } from "../modules-retired";
import { activeStandInsFor } from "../hr/stand-in-resolve";
import { getAppSettings } from "../settings"; // settings n'importe que prisma → aucun cycle
import { pipelineAccessFor } from "../regulatory/pipeline-access";
import { carrierAccess } from "../regulatory/assignment";
import { NAVIGATION, NAV_LEGACY_LABELS } from "../labels"; // labels n'importe de rbac QUE le type `Module` → aucun cycle runtime
import { lireSections } from "../annuaires/acces"; // module PUR, zéro import → aucun cycle
import { sansBloquer } from "@/lib/journal"; // module PUR, zéro import → aucun cycle
import { MODULES, type Action, type Module } from "./modules";
import { PERMISSIONS } from "./permissions";
import { defaultScope, hasGlobalView, recruitmentAccessFor, seesWholeSecretariat } from "./roles";

// `cache` is a React Server Components API; fall back to identity outside an
// RSC render (e.g. unit tests) so the module loads everywhere.
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * Résout le MODULE d'une demande de validation — pour l'accès TEMPORAIRE accordé au
 * validateur. D'abord via le libellé stocké (l'option de navigation choisie à la
 * création, ex. « PCH — Marchés »), sinon via l'URL de l'objet lié (préfixe de route
 * le plus spécifique, ex. `/pch/123` → PCH). Renvoie null si rien de fiable.
 */
/**
 * Toutes les destinations connues : entrées de menu ET leurs ONGLETS. Depuis que plusieurs
 * modules se présentent en onglets sous une entrée unique (Ventes & Marchés = Ventes ·
 * Logistique · PCH, Ad & Pro, Budgets, RH…), l'onglet est le seul endroit où vit le lien entre
 * une route et son module. Ignorer les onglets ferait perdre l'accès temporaire d'un validateur
 * sur tout module fusionné.
 */
const NAV_TARGETS: { href: string; module: Module; label: string }[] = NAVIGATION.flatMap((n) => [
  { href: n.href, module: n.module, label: n.label },
  ...(n.tabs ?? []).map((t) => ({ href: t.href, module: t.module, label: t.label })),
  // LES SOUS-MODULES (Ressources humaines, Direction 06/10) : leur route ET leurs chemins rattachés disent leur module —
  // « /rh/conges » est aux Demandes RH, pas au module RH du parent.
  ...(n.children ?? []).flatMap((c) => [c.href, ...(c.match ?? [])].map((href) => ({ href, module: c.module, label: c.label }))),
]);

function moduleFromLink(link: string): Module | null {
  const path = link.split(/[?#]/)[0];
  const byHref = [...NAV_TARGETS]
    .filter((n) => n.href !== "/")
    .sort((a, b) => b.href.length - a.href.length) // route la plus spécifique d'abord
    .find((n) => path === n.href || path.startsWith(`${n.href}/`));
  return byHref?.module ?? null;
}

/**
 * LES LIBELLÉS RÉEMPLOYÉS — un nom de menu qui a désigné un AUTRE module.
 *
 * « Projets » a nommé Pilotage (les sujets) jusqu'au renommage de §118.163 ; il ne nomme plus que
 * le registre BD. Une demande de validation libellée « Projets » ne dit donc pas, par son nom,
 * lequel des deux elle vise : seul le LIEN le dit. Sans lien, on n'ouvre AUCUN module sur la foi du
 * nom. L'ancienne lecture (Pilotage) est déjà ouverte à tous les rôles — mesuré, 19 sur 19 —, donc
 * rien ne se perd ; la nouvelle (le registre BD, fermé par défaut à 13 rôles) aurait été un
 * élargissement silencieux accordé au validateur d'un sujet. La ligne liée, elle, reste accordée,
 * et la page « Demandes de validations » aussi : il peut toujours décider.
 */
const LIBELLES_REEMPLOYES: ReadonlySet<string> = new Set(["Projets"]);

function moduleFromValidation(moduleLabel: string | null, link: string | null): Module | null {
  let fromLabel: Module | null = null;
  if (moduleLabel) {
    const byLabel = NAV_TARGETS.find((n) => n.label === moduleLabel);
    if (byLabel) fromLabel = byLabel.module;
    // Libellé d'AVANT un renommage de menu : une demande créée sous l'ancien nom doit continuer
    // d'ouvrir le même module à son validateur.
    else if (NAV_LEGACY_LABELS[moduleLabel]) fromLabel = NAV_LEGACY_LABELS[moduleLabel];
    else {
      const up = moduleLabel.trim().toUpperCase();
      if ((MODULES as readonly string[]).includes(up)) fromLabel = up as Module;
    }
  }
  // Le libellé générique « Demandes de validations » (→ VALIDATIONS) n'est jamais la
  // cible réelle : dans ce cas l'URL de l'objet lié est le signal fiable.
  const fromLink = link ? moduleFromLink(link) : null;
  // QUAND LES DEUX DÉSIGNENT DEUX MODULES, LE LIEN L'EMPORTE (§118.163). Un libellé de menu est
  // un NOM, et un nom se renomme ou se réemploie : « Projets » désignait Pilotage jusqu'à ce que
  // Pilotage devienne « Sujets » et que « Projets » ne nomme plus que le registre BD. Une demande
  // ancienne libellée « Projets » aurait alors ouvert au validateur un module sans rapport avec
  // ce qu'il doit décider. Le lien, lui, désigne l'objet même qu'il doit ouvrir — c'est la seule
  // raison d'être de cet accès temporaire.
  if (fromLabel && fromLink && fromLabel !== fromLink) return fromLink;
  if (moduleLabel && LIBELLES_REEMPLOYES.has(moduleLabel.trim())) return fromLink;
  if (fromLabel && fromLabel !== "VALIDATIONS") return fromLabel;
  return fromLink ?? fromLabel;
}

// ───────────────────────── Effective (resolved) access ─────────────────────────

export interface EffectiveModuleAccess {
  actions: Set<Action>;
  scope: AccessScope;
  /**
   * LES SECTIONS qu'un accès PERSONNALISÉ ouvre à l'intérieur du module — aujourd'hui les
   * annuaires cochés sur le module Annuaires (§118.147). Absent = aucune section en plus.
   */
  sections?: ReadonlySet<string>;
}
export interface EffectiveAccess {
  modules: Map<Module, EffectiveModuleAccess>;
  rowGrants: Map<EntityType, Set<string>>;
  /** Rôle secondaire résolu (toujours renseigné par `getAccess` ; optionnel pour les
   *  fabriques de test qui construisent un accès minimal). */
  secondaryRole?: UserRole | null;
  /** Rôle principal résolu EN DIRECT depuis la base (le JWT fige le rôle au login →
   *  il peut être périmé après un changement de rôle). Utilisé par la session comme
   *  rôle faisant autorité. Optionnel : les fabriques de test peuvent l'omettre. */
  role?: UserRole;
  /** PIPELINE — voit-il les dossiers VERROUILLÉS ? Réglé en Administration, résolu ici une
   *  fois par requête parce que le verrou est consulté par des fonctions SYNCHRONES
   *  (`scopeRegulatory`, `regulatoryLockWhere`) qui ne peuvent pas lire la base.
   *  Optionnel : les fabriques de test construisent un accès minimal. */
  pipelineView?: boolean;
  /** PIPELINE — tient-il le CADENAS (ouvrir un dossier = le publier à toute l'entreprise) ? */
  pipelineManage?: boolean;
  /** CENTRE DE PAIEMENT — a-t-il un SIÈGE NOMMÉ ? Une désignation personnelle, indépendante du
   *  rôle, qui n'ouvre QUE le centre (voir `PaymentCentreSeat`). Résolu ici pour la même raison
   *  que le pipeline : `sitsOnPaymentCentre` est SYNCHRONE et appelée partout, elle ne peut pas
   *  lire la base. Optionnel : les fabriques de test construisent un accès minimal. */
  paymentCentreSeat?: boolean;
  /**
   * LES INTÉRIMS QUI ÉLARGISSENT CET ACCÈS AUJOURD'HUI (§118.196, lot E4 — audit 360°, M13) — qui l'on
   * remplace, jusqu'à quand, quels modules en viennent réellement. Un droit prêté qui ne se voit nulle
   * part ne se distingue pas d'un droit propre : le bandeau d'intérim (coque) le dit. Optionnel : les
   * fabriques de test construisent un accès minimal.
   */
  interims?: readonly InterimEnCours[];
  /**
   * Les actions que SEUL un intérim donne — celles que la personne ne détenait pas elle-même. Les gestes
   * de DROITS (ouvrir l'accès d'un tiers à une entité, fermer un compte, désigner ou valider un intérim)
   * les lisent (`estPrete`) : un droit prêté ne s'accorde pas à son tour.
   */
  pretes?: ReadonlyMap<Module, ReadonlySet<Action>>;
}

/** Un intérim en cours, vu de l'intérimaire (§118.196). */
export interface InterimEnCours {
  absentId: string;
  absentNom: string;
  jusquau: Date;
  /** Les modules réellement ouverts par cet intérim (ceux que la console ne bloque pas chez l'intérimaire). */
  modules: Module[];
}
export interface SessionUser {
  id: string;
  role: UserRole;
  /** « Autre rôle » : fonction secondaire cumulée (réglée par le Super Admin). */
  secondaryRole?: UserRole | null;
  access: EffectiveAccess;
}

/** Une ligne d'accès PERSONNALISÉ telle que la console l'écrit — les seules colonnes que la règle lit. */
export type LigneAccesAttribue = Pick<UserAccess,
  "module" | "canView" | "canCreate" | "canUpdate" | "canDelete" | "canValidate" | "canExport" | "canUpload" | "scope" | "sections">;

/**
 * L'ACCÈS ATTRIBUÉ — ce que le rôle, l'« autre rôle » et la console donnent à une personne, AVANT tout
 * accès implicite (validation en attente, département dirigé, dossier porté, partage, siège, intérim).
 *
 * `getAccess` en part ; l'INTÉRIM y lit ce que l'absent DÉTIENT (§118.196, lot E4 — audit 360°, M13).
 * Écrite une fois : un second calcul « de ce qu'une personne a » finirait par ne plus voir le blocage que
 * l'administrateur vient de poser (§118.5), et l'intérimaire hériterait du module qu'on a retiré à
 * l'absent. PURE : aucune lecture de base.
 */
export function accesAttribue(
  role: UserRole,
  secondaryRole: UserRole | null,
  overrides: readonly LigneAccesAttribue[],
): { modules: Map<Module, EffectiveModuleAccess>; blockedModules: Set<Module> } {
  const overrideMap = new Map(overrides.map((o) => [o.module as Module, o]));
  const modules = new Map<Module, EffectiveModuleAccess>();
  // Modules explicitement BLOQUÉS par l'administrateur. On les retient pour que les accès
  // IMPLICITES posés plus bas (porter un dossier, se voir partager une catégorie…) ne défassent
  // pas une décision prise à la main — un blocage qui se lèverait tout seul serait pire
  // qu'inutile : il serait imprévisible.
  const blockedModules = new Set<Module>();

  for (const module of MODULES) {
    // UN MODULE RETIRÉ N'ENTRE PAS DANS L'ACCÈS EFFECTIF — et c'est LA garde qui compte.
    // `userCan` répond alors non partout d'un seul coup : écrans, actions serveur, routes
    // d'API et outils d'Adam. Le masquage du menu ne fait que rendre l'interface cohérente ;
    // s'il était seul, l'assistant continuerait de créer des projets dans un module retiré.
    // Voir `lib/modules-retired.ts`.
    if (isRetiredModule(module)) continue;
    const ov = overrideMap.get(module);
    // Override « BLOQUÉ » (ligne présente, canView=false) : **absolu**. Il retire le
    // module quoi qu'il arrive — y compris par-dessus un défaut de rôle PRINCIPAL **ou
    // SECONDAIRE**. C'est ce qui rend l'action de l'admin (« bloquer X à Untel »)
    // réellement effective en temps réel, même si son « autre rôle » l'accorde.
    const blocked = !!ov && !ov.canView;
    if (blocked) blockedModules.add(module);
    const actions = new Set<Action>();
    let scope: AccessScope = "ASSIGNED";
    let hasView = false;

    const addRoleDefaults = (r: UserRole) => {
      const def = PERMISSIONS[r]?.[module];
      if (def?.includes("VIEW")) {
        hasView = true;
        for (const a of def) actions.add(a);
        if (defaultScope(r, module) === "ALL") scope = "ALL";
      }
    };

    // Rôle principal : l'override par utilisateur (s'il existe) REMPLACE ses défauts.
    if (ov) {
      if (ov.canView) {
        hasView = true;
        actions.add("VIEW");
        if (ov.canCreate) actions.add("CREATE");
        if (ov.canUpdate) actions.add("UPDATE");
        if (ov.canDelete) actions.add("DELETE");
        if (ov.canValidate) actions.add("VALIDATE");
        if (ov.canExport) actions.add("EXPORT");
        if (ov.canUpload) actions.add("UPLOAD");
        if (ov.scope === "ALL") scope = "ALL";
      }
    } else {
      addRoleDefaults(role);
    }

    // Un « accès personnalisé » (override) ne doit pas RÉTRÉCIR SILENCIEUSEMENT la
    // portée qu'un rôle possède NATIVEMENT : si le rôle voit tout le module par défaut
    // (ex. National Sales voit TOUTES les demandes de congrès à pré-valider), on conserve
    // la portée ALL même quand l'admin a coché « accès personnalisé » sans (re)choisir
    // « tout » dans le sélecteur de portée (qui retombe sinon sur ASSIGNED). Symétrique
    // de la règle du rôle secondaire ci-dessous.
    if (ov?.canView && defaultScope(role, module) === "ALL") scope = "ALL";

    // Rôle SECONDAIRE : ses capacités se cumulent (union des actions, portée la plus
    // large) — SAUF si l'admin a explicitement **BLOQUÉ** ce module pour ce compte :
    // un blocage prime sur l'« autre rôle » (sinon on ne pourrait jamais retirer un
    // module à quelqu'un qui le détient via son rôle secondaire). Hors blocage, un
    // ancien réglage « accès personnalisé » ne doit pas neutraliser silencieusement
    // l'« autre rôle » attribué ensuite (ex. un National Sales en secondaire doit voir
    // TOUTES les demandes de congrès à pré-valider).
    if (!blocked && secondaryRole && secondaryRole !== role) addRoleDefaults(secondaryRole);

    // LES SECTIONS ne viennent QUE d'un accès personnalisé : un rôle n'en porte pas, et un
    // accès bloqué n'en ouvre aucune. Les clés sont relues par la règle pure — une clé
    // inconnue en base est écartée, jamais interprétée.
    const sections = ov?.canView ? lireSections(ov.sections) : [];
    if (hasView && !blocked) modules.set(module, { actions, scope, ...(sections.length ? { sections: new Set(sections) } : {}) });
  }
  return { modules, blockedModules };
}

/**
 * Resolve a user's effective access: per-user UserAccess overrides win over the
 * role default for a module; row grants are loaded for assigned-scope checks.
 * Cached per request so repeated `scope*`/`userCan` calls hit the DB once.
 */
export const getAccess = perRequest(
  async (userId: string, roleHint: UserRole): Promise<EffectiveAccess> => {
    const [overrides, grants, userRow, pendingValidations, departmentsLed, standIns, appSettings, centreSeat] = await Promise.all([
      prisma.userAccess.findMany({ where: { userId } }),
      prisma.rowGrant.findMany({ where: { userId }, select: { entityType: true, entityId: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { role: true, secondaryRole: true } }),
      // Accès TEMPORAIRE de validation : étapes EN ATTENTE dont je suis le validateur.
      prisma.validationStep.findMany({
        where: { validatorId: userId, status: "PENDING", request: { status: "PENDING" } },
        select: { request: { select: { module: true, link: true, entityType: true, entityId: true } } },
      }),
      // Dirige-t-il un département ? C'est ce FAIT — et non son rôle — qui ouvre le module
      // Recrutement. L'adjoint compte : il tient le service quand le responsable est absent.
      prisma.department.count({ where: { OR: [{ head: { userId } }, { deputy: { userId } }] } }),
      // Remplace-t-il quelqu'un en congé aujourd'hui ? La délégation est bornée par les droits
      // de l'absent et s'éteint d'elle-même à la fin du congé — voir `lib/hr/stand-in.ts`.
      activeStandInsFor(userId).catch(sansBloquer("rbac.activeStandInsFor", [])),
      // Les accès au PIPELINE (dossiers verrouillés) sont un réglage d'instance, pas un rôle :
      // le Super Admin décide qui voit le portefeuille à l'étude et qui tient le cadenas.
      // `getAppSettings` est lui-même mis en cache par requête et retombe sur ses valeurs par
      // défaut en cas de souci — le doute referme le verrou, il ne l'ouvre pas.
      getAppSettings(),
      // LE SIÈGE NOMMÉ AU CENTRE DE PAIEMENT. Une désignation PERSONNELLE, accordée une par une
      // par le Super Admin : elle n'ouvre que le centre, et rien d'autre. On la résout ici parce
      // que `sitsOnPaymentCentre` est synchrone et appelée depuis l'écran, l'action, l'assistant
      // et la recherche — lui donner une lecture de base rendrait toute la chaîne asynchrone.
      prisma.paymentCentreSeat.count({ where: { userId } }).catch(sansBloquer("rbac.paymentCentreSeat", 0)),
    ]);

    // Rôle principal résolu EN DIRECT depuis la base : le JWT fige le rôle au login, donc
    // un compte promu (ex. Délégué Médical → National Sales) garderait un accès et un
    // libellé périmés jusqu'à sa reconnexion. On prend le rôle réel de la base (repli sur
    // l'indice du JWT si l'utilisateur est introuvable — cas des fabriques de test).
    const role = (userRow?.role ?? roleHint) as UserRole;
    // « Autre rôle » : l'utilisateur CUMULE son rôle principal ET son rôle secondaire.
    const secondaryRole = userRow?.secondaryRole ?? null;

    // L'ACCÈS ATTRIBUÉ (rôle, « autre rôle », console) — la règle même où l'intérim lit ce que l'absent
    // détient (`accesAttribue`, §118.196). Les accès IMPLICITES s'y ajoutent plus bas.
    const { modules, blockedModules } = accesAttribue(role, secondaryRole, overrides);

    // ── Confidentialité STRICTE du Drive et des Projets (Dossiers) ──────────────
    // Ces deux modules sont « privés par conception » : on ne voit que SES fichiers /
    // SES projets + ceux qu'on nous a explicitement PARTAGÉS ou CONFIÉS (portée
    // ASSIGNED). Seule la **vue globale** (Super Admin / Direction) voit tout. On
    // NEUTRALISE donc toute portée « ALL » pour un rôle ordinaire — qu'elle vienne
    // d'un override de la matrice, d'un réglage hérité ou d'un rôle secondaire — afin
    // qu'un compte comme l'Assistante de Direction n'ait JAMAIS accès à l'ensemble
    // des drives / projets de la société. (La visibilité fine reste assurée par
    // `scopeDossiers` / `getDriveListing` / `resolveDriveAccess`.)
    if (!hasGlobalView({ role, secondaryRole })) {
      for (const mod of ["DRIVE", "DOSSIERS"] as const) {
        const m = modules.get(mod);
        if (m && m.scope === "ALL") m.scope = "ASSIGNED";
      }
    }

    const rowGrants = new Map<EntityType, Set<string>>();
    for (const g of grants) {
      if (!rowGrants.has(g.entityType)) rowGrants.set(g.entityType, new Set());
      rowGrants.get(g.entityType)!.add(g.entityId);
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * POSER UN ACCÈS IMPLICITE — jamais par-dessus un blocage explicite de l'administrateur.
     *
     * ── LE DÉFAUT QU'ON CORRIGE ────────────────────────────────────────────────────────────
     *
     * Les accès implicites posés plus bas (tenir les RH ouvre les Moyens généraux, diriger un
     * département ouvre le Recrutement, avoir une validation en attente ouvre le module visé…)
     * ignoraient `blockedModules`. Un administrateur qui RETIRAIT un module à quelqu'un dans la
     * console le voyait donc revenir au rafraîchissement suivant, sans explication : la règle
     * implicite le rendait, en silence, à chaque requête.
     *
     * Le commentaire de `blockedModules` promet pourtant l'inverse depuis toujours — « un blocage
     * qui se lèverait tout seul serait pire qu'inutile : il serait imprévisible ». La promesse
     * n'était tenue que par le siège du centre de paiement. Elle l'est maintenant partout, par
     * ce passage OBLIGÉ : plus aucun `modules.set` implicite n'existe hors de cette fonction.
     *
     * `mode` distingue les deux gestes réels : ÉLARGIR ce qu'on a déjà (le cas ordinaire) ou
     * REMPLACER (le recrutement et le pipeline calculent un accès complet, qui ne se cumule pas).
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    const grantImplicit = (
      module: Module,
      actions: readonly Action[],
      scope: AccessScope | null,
      mode: "widen" | "replace" = "widen",
    ): boolean => {
      // LE BLOCAGE EXPLICITE PRIME, TOUJOURS. C'est la décision d'une personne, prise à la main,
      // devant l'écran des accès ; une règle automatique ne la défait pas.
      if (blockedModules.has(module)) return false;
      // UN MODULE RETIRÉ N'ENTRE PAS — pas plus par une porte implicite que par la console : la garde
      // d'`accesAttribue` serait défaite par la première validation en attente qui le nomme, ou par un
      // intérim (§118.75, §118.196).
      if (isRetiredModule(module)) return false;
      const cur = modules.get(module);
      if (!cur || mode === "replace") {
        modules.set(module, { actions: new Set<Action>(actions), scope: scope ?? "ASSIGNED" });
        return true;
      }
      for (const a of actions) cur.actions.add(a);
      // On n'élargit la portée que vers le HAUT : un accès implicite ne rétrécit jamais ce
      // qu'un rôle accorde nativement.
      if (scope === "ALL") cur.scope = "ALL";
      return true;
    };

    // ── Accès TEMPORAIRE de validation ──────────────────────────────────────────
    // Un validateur dont une étape est EN ATTENTE obtient, LE TEMPS de décider, une
    // LECTURE (VIEW/EXPORT) du module concerné + l'accès à la LIGNE liée — de sorte
    // qu'il puisse RÉELLEMENT ouvrir le document / la demande d'origine à valider.
    // Dès que l'étape est traitée (approuvée/refusée), elle n'est plus renvoyée par
    // la requête → l'accès disparaît de lui-même. Toujours en LECTURE SEULE.
    for (const s of pendingValidations) {
      const mod = moduleFromValidation(s.request.module, s.request.link);
      if (mod) grantImplicit(mod, ["VIEW", "EXPORT"], null);
      if (s.request.entityType && s.request.entityId) {
        if (!rowGrants.has(s.request.entityType)) rowGrants.set(s.request.entityType, new Set());
        rowGrants.get(s.request.entityType)!.add(s.request.entityId);
      }
    }
    // Un validateur qui a une étape EN ATTENTE doit TOUJOURS pouvoir ouvrir la page
    // « Demandes de validations » pour décider — même si son rôle n'accorde pas ce
    // module par défaut (ex. un VIEWER, ou un compte dont l'accès a été personnalisé
    // sans VALIDATIONS). Sinon `requireModule("VALIDATIONS")` le redirige et la demande
    // qui l'attend reste invisible. On garantit donc au moins la LECTURE de la page.
    if (pendingValidations.length > 0) grantImplicit("VALIDATIONS", ["VIEW"], null);

    // ── LE SIÈGE NOMMÉ OUVRE LE MODULE QU'IL SERT, ET LUI SEUL ──
    //
    // Désigner quelqu'un au centre sans lui ouvrir l'entrée de menu produirait exactement le
    // défaut qu'on corrige : un accès accordé qui ne mène nulle part, et une personne qui doit
    // connaître l'URL pour exercer un droit qu'on croit lui avoir donné.
    //
    // On accorde `PAYMENT_CENTRE` en VUE + VALIDATE, et RIEN d'autre : le siège ne donne pas les
    // Finances, ni la vue globale, ni un module de plus. Un BLOCAGE explicite de l'administrateur
    // prime, comme partout ailleurs — sinon on ne pourrait plus retirer le module à quelqu'un.
    if (centreSeat > 0) grantImplicit("PAYMENT_CENTRE", ["VIEW", "VALIDATE"], "ALL");

    // ── LES MOYENS GÉNÉRAUX NE S'OUVRENT PLUS TOUT SEULS ──────────────────────────────────
    //
    // Ce module s'accordait ICI, implicitement, à quiconque tenait les ressources humaines
    // (`RH` en écriture) — au motif que les RH pilotent la dotation des départements. C'était
    // une PORTE DÉROBÉE : la console d'administration affichait « Aucun accès » sur la ligne
    // Moyens généraux, et la personne l'avait quand même. Retirer le module depuis la console
    // ne changeait rien, et il fallait connaître cette ligne de code pour comprendre pourquoi.
    //
    // Un droit qui ne se lit pas là où on le règle n'est pas administrable. Les Moyens généraux
    // s'accordent donc comme tous les autres : par la matrice du rôle, ou nommément depuis la
    // console. Ceux qui l'avaient par ce détour le reçoivent d'un clic, et cette fois cela se
    // VOIT sur leur ligne.

    // ── LE DRH ET LES FINANCES VOIENT TOUT LE BUREAU DU SECRÉTARIAT ──
    //
    // Ce sont eux qui PAIENT et qui CONTRÔLENT ce que le secrétariat engage : une mission
    // chauffeur, un achat de fournitures, une prestation, un visa d'invité finissent tous en
    // décaissement ou en dossier du personnel. Ne leur montrer que « leurs » demandes — celles
    // qu'ils ont eux-mêmes émises — revenait à leur demander de valider des dépenses dont ils
    // ne voyaient ni l'origine, ni les pièces, ni le circuit.
    //
    // On accorde la portée ALL en LECTURE, jamais le pilotage : le bureau reste tenu par
    // l'assistante de direction. Voir n'est pas instruire.
    if (seesWholeSecretariat({
      rhCanUpdate: modules.get("RH")?.actions.has("UPDATE") ?? false,
      financeCanUpdate: modules.get("FINANCES")?.actions.has("UPDATE") ?? false,
    })) {
      grantImplicit("ADMIN_REQUESTS", ["VIEW", "EXPORT"], "ALL");
    }

    // ── LE RECRUTEMENT : TOUT LE MONDE DEMANDE, LES RH INSTRUISENT ──
    // N'importe qui peut demander un poste (Direction, 07/10) ; qui dirige un département le suit de
    // plus près ; qui tient les RH instruit tout. La règle est dans `recruitmentAccessFor` — ici on ne
    // fait que la poser, en ÉLARGISSANT, comme « Mon Équipe » ci-dessous : un rôle qui accorde déjà
    // davantage (Direction, DG) ne s'en trouve pas rétréci, et un BLOCAGE de la console prime.
    const recruitment = recruitmentAccessFor({
      headsDepartment: departmentsLed > 0,
      rhCanUpdate: modules.get("RH")?.actions.has("UPDATE") ?? false,
    });
    grantImplicit("RECRUITMENT", recruitment.actions, recruitment.scope);

    // ── LA CAMPAGNE BUDGÉTAIRE : QUI DIRIGE UN DÉPARTEMENT PRÉPARE LE BUDGET DE SON PÔLE ──
    // Un FAIT de l'organigramme (responsable ou adjoint), pas un rôle. En LECTURE et portée bornée (ASSIGNED) : l'écran
    // ne lui montre que SES pôles, jamais la vue de la Direction ni le cadrage (`lib/budget-campagne/regles.ts`).
    if (departmentsLed > 0) grantImplicit("BUDGET_CAMPAIGN", ["VIEW"], null);

    // ── « MON ÉQUIPE » SUIT L'ORGANIGRAMME, PAS LE RÔLE ──
    //
    // Encadrer n'est pas un rôle : c'est un FAIT de l'organigramme. La Direction Marketing, un
    // responsable régulatoire, un directeur commercial encadrent tous quelqu'un sans partager
    // le moindre rôle — et l'on ne peut pas prévoir dans une matrice quels rôles encadrent, ni
    // la corriger à chaque nomination.
    //
    // Le module est donc accordé à TOUT LE MONDE, et c'est la GARDE de navigation (`myTeam`,
    // dans `nav-access.ts`) qui n'affiche l'entrée qu'à ceux qui ont réellement des N-1. Ce
    // n'est pas un trou : l'écran d'une personne sans équipe ne contient rien à voir — il ne
    // lit que SES subordonnés, et elle n'en a pas.
    grantImplicit("MY_TEAM", ["VIEW"], null);

    // ── « ANNUAIRES » EST UNE PORTE, PAS UN DROIT ──
    //
    // Le concentrateur ne montre RIEN par lui-même : chacun de ses onglets est gardé par le
    // module du référentiel qu'il affiche, et un onglet interdit n'est pas rendu. Accorder la
    // porte à tout le monde ne donne donc accès à aucune donnée de plus — cela évite seulement
    // qu'un droit « Annuaires » à régler dans la console redise, en retard, ce que MEDICAL et
    // WORKSPACE décident déjà (§118.5, §118.74).
    grantImplicit("DIRECTORIES", ["VIEW"], null);

    // ── INTÉRIM D'UN CONGÉ ──
    //
    // Quelqu'un est absent, quelqu'un d'autre tient sa place : l'intérimaire reçoit, LE TEMPS DU
    // CONGÉ, les modules que l'absent a délégués — jamais plus que ce que l'absent avait
    // lui-même, jamais la suppression, et jamais ses espaces personnels (Drive, messagerie).
    //
    // La délégation s'ÉTEINT SEULE : elle n'est calculée que si le congé couvre aujourd'hui.
    // Personne n'a rien à révoquer au retour, et c'est précisément ce qui la rend sûre — un
    // accès ouvert « pour cette fois » par un administrateur, lui, ne se referme jamais.
    //
    // CE QUI SE PRÊTE se lit sur ce que l'absent DÉTIENT (`accesAttribue`), borné par la matrice de
    // son rôle principal — jamais la matrice seule (§118.196, lot E4 — audit 360°, M13) : un module
    // qu'on lui a bloqué, un accès plus étroit que son rôle, un module retiré ne passent pas. Et ce
    // qui en vient se DIT : `interims` nourrit le bandeau de la coque, `pretes` garde ce que la
    // personne ne détenait pas elle-même — les gestes de droits le lisent (`estPrete`).
    const interims: InterimEnCours[] = [];
    const pretes = new Map<Module, Set<Action>>();
    for (const intérim of standIns) {
      const ouverts: Module[] = [];
      for (const d of intérim.delegations) {
        const avant = modules.get(d.module)?.actions;
        const neufs = d.actions.filter((a) => !avant?.has(a));
        if (!grantImplicit(d.module, d.actions, null)) continue;
        ouverts.push(d.module);
        if (neufs.length > 0) {
          const s = pretes.get(d.module) ?? new Set<Action>();
          for (const a of neufs) s.add(a);
          pretes.set(d.module, s);
        }
      }
      interims.push({ absentId: intérim.absenteeUserId, absentNom: intérim.absenteeName, jusquau: intérim.endDate, modules: ouverts });
    }

    // ── PORTER UN DOSSIER RÉGLEMENTAIRE OUVRE LE MODULE ─────────────────────────
    //
    // On confie un dossier à quelqu'un depuis le tableau Regulatory, et cette personne recevait
    // la notification « Vous êtes chargé(e) de ce dossier »… dont le lien menait à une
    // redirection : son rôle n'ouvrait pas le module, donc `requireModule` la renvoyait à
    // l'accueil et `scopeRegulatory` ne lui montrait aucune ligne. On lui confiait un dossier
    // qu'elle ne pouvait ni voir ni ouvrir.
    //
    // La portée reste ASSIGNED : `scopeRegulatory` ne retient que les dossiers où elle est
    // NOMMÉE (responsable, assistante, participante, créatrice). Porter trois dossiers n'ouvre
    // pas le portefeuille de la société — et le VERROU du pipeline continue de passer avant tout.
    if (!modules.has("REGULATORY")) {
      const carried = await prisma.regulatoryProduct
        .findFirst({
          where: {
            OR: [
              { responsibleId: userId },
              { assistantId: userId },
              { assignedUsers: { some: { id: userId } } },
            ],
          },
          select: { id: true },
        })
        .catch(sansBloquer("rbac.regulatoryProduct", null));
      const grant = carrierAccess({
        carries: Boolean(carried),
        blocked: blockedModules.has("REGULATORY"),
        hasModule: modules.has("REGULATORY"),
      });
      if (grant) grantImplicit("REGULATORY", grant.actions, grant.scope, "replace");
    }
    // …ET PORTER UN DOSSIER VERROUILLÉ OUVRE LE PIPELINE (Direction, 08/10), à la même portée nommée : le pipeline
    // était sous Regulatory, et ce porteur-là y voyait son dossier (s'il a aussi la confidence du pipeline). La
    // scission ne le lui retire pas — un BLOCAGE de la console sur le pipeline prime, comme partout. Sans la
    // confidence, il ne voyait rien du pipeline : on ne lit alors même pas la base.
    const pipeline = pipelineAccessFor({ id: userId, role, secondaryRole }, appSettings);
    if (pipeline.view && !modules.has("REGULATORY_PIPELINE")) {
      const carriedLocked = await prisma.regulatoryProduct
        .findFirst({
          where: {
            isLocked: true,
            OR: [
              { responsibleId: userId },
              { assistantId: userId },
              { assignedUsers: { some: { id: userId } } },
            ],
          },
          select: { id: true },
        })
        .catch(sansBloquer("rbac.regulatoryProduct", null));
      const grant = carrierAccess({
        carries: Boolean(carriedLocked),
        blocked: blockedModules.has("REGULATORY_PIPELINE"),
        hasModule: modules.has("REGULATORY_PIPELINE"),
      });
      if (grant) grantImplicit("REGULATORY_PIPELINE", grant.actions, grant.scope, "replace");
    }

    // ── Accès IMPLICITE au module Budget quand une enveloppe est PARTAGÉE avec ce compte ──
    // Partager une enveloppe (par personne OU par rôle, en visualisation ou en gestion) doit
    // suffire à ce que le destinataire puisse OUVRIR le module Budget et l'y voir — même si son
    // rôle n'a AUCUN accès Budget par défaut (sinon la porte `requireModule("BUDGETS")` le
    // redirige et l'enveloppe partagée reste invisible). On n'accorde qu'une LECTURE ; le
    // filtrage fin (quelles enveloppes) reste assuré par `canViewEnvelope` dans les requêtes.
    if (!modules.has("BUDGETS")) {
      const roles = [role, secondaryRole].filter(Boolean) as string[];
      const shared = await prisma.budgetEnvelope
        .findFirst({
          where: {
            OR: [
              { accessUserIds: { has: userId } },
              { managerUserIds: { has: userId } },
              ...(roles.length ? [{ accessRoles: { hasSome: roles } }, { managerRoles: { hasSome: roles } }] : []),
            ],
          },
          select: { id: true },
        })
        .catch(sansBloquer("rbac.budgetEnvelope", null));
      if (shared) grantImplicit("BUDGETS", ["VIEW", "EXPORT"], null);
    }

    // ── Accès IMPLICITE au module Drive quand quelque chose est PARTAGÉ avec ce compte ──
    // Être membre d'une CATÉGORIE (par personne OU par rôle, consultation ou gestion), ou tenir
    // un partage NOMINATIF sur un fichier/dossier, doit suffire à OUVRIR le module Drive — même
    // si le rôle n'accorde aucun accès Drive par défaut. Sans cela, recevoir un document du Drive
    // dans la messagerie donnait un lien qui menait à un refus : l'accès existait en base, et la
    // porte du module le rendait inutile.
    // On n'accorde qu'une LECTURE du module ; le filtrage fin (quels nœuds, quels droits) reste
    // assuré par canViewDriveSpace / resolveDriveAccess / driveVisibilityWhere dans les requêtes.
    if (!modules.has("DRIVE")) {
      const roles = [role, secondaryRole].filter(Boolean) as string[];
      const [space, share] = await Promise.all([
        prisma.driveSpace
          .findFirst({
            where: {
              isArchived: false,
              OR: [
                { accessUserIds: { has: userId } },
                { managerUserIds: { has: userId } },
                ...(roles.length ? [{ accessRoles: { hasSome: roles } }, { managerRoles: { hasSome: roles } }] : []),
              ],
            },
            select: { id: true },
          })
          .catch(sansBloquer("rbac.driveSpace", null)),
        prisma.driveShare.findFirst({ where: { userId }, select: { id: true } }).catch(sansBloquer("rbac.driveShare", null)),
      ]);
      if (space || share) grantImplicit("DRIVE", ["VIEW"], null);
    }

    // ── LE PIPELINE (dossiers VERROUILLÉS) ──────────────────────────────────────
    // Résolu ICI et non au moment de la lecture : `scopeRegulatory` et `regulatoryLockWhere`
    // sont synchrones et servent partout (tableau, recherche, sélecteurs de produits,
    // assistant). Un droit qui exigerait une requête à chaque appel ne pourrait pas y vivre.
    // (`pipeline` est résolu plus haut : le porteur d'un dossier verrouillé en dépend.)

    return {
      modules, rowGrants, secondaryRole, role,
      pipelineView: pipeline.view, pipelineManage: pipeline.manage,
      paymentCentreSeat: centreSeat > 0,
      interims, pretes,
    };
  },
);
