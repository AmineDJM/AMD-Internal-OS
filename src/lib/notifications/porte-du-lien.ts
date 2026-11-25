import type { Module } from "@/lib/rbac";
import { NAVIGATION, moduleForPath } from "@/lib/labels";
import { CHEMIN_CENTRE_DE_PAIEMENT } from "@/lib/chemins/finances";
import { reécriteLienNotification } from "./lien-actuel";

/**
 * QUEL MODULE UNE NOTIFICATION OUVRE — déduit de son LIEN (Super Admin, 25/11/2026 : « une personne qui n'a PAS accès à un
 * module ne reçoit AUCUNE notification de ce module, et ne peut pas l'ouvrir »).
 *
 * LE DÉFAUT CONSTATÉ. Le Directeur des opérations, sans accès au centre de paiement, recevait « Autorisation de paiement
 * demandée » avec le lien `/centre-de-paiement?entite=…` : l'envoi visait des RÔLES, et personne ne relisait, au moment
 * d'écrire, si le destinataire pouvait ouvrir ce que la notification lui montrait.
 *
 * LA CORRESPONDANCE N'EST PAS UNE TABLE ÉCRITE À LA MAIN : elle se lit dans la NAVIGATION (le menu, ses onglets, ses
 * sous-modules — la même traversée que `moduleForPath`) et dans les chemins écrits une fois (`lib/chemins/*`). Seules les
 * routes servies HORS du menu (une fiche ouverte par un lien, un ancien chemin) ont leur ligne ci-dessous.
 *
 * QUATRE GENRES DE PORTE — parce qu'une même règle ne vaut pas pour un écran de décision et pour la fiche d'une demande :
 *   • `siege`  — un écran de DÉCISION sans cercle de demandeur (centre de paiement, centre de validations, centre Ad & Pro,
 *                Adam, Adventum Brain). Qui n'y siège pas n'en reçoit rien, jamais, et n'y entre pas ;
 *   • `ecran`  — l'écran d'un module à son adresse nue (sa liste, sa file) : gardé par le module, sans exception ;
 *   • `fiche`  — une page SOUS l'écran d'un module (une demande, un dossier, une personne), ou l'écran ouvert SUR une ligne
 *                (`/rh/demandes?demande=…`, `?focus=…`). La page admet son CERCLE — le demandeur, le sujet — en plus du
 *                module : c'est L'EXCEPTION DU DEMANDEUR (voir `admisParLaPorte`) ;
 *   • `libre`  — pas de lien, une page ouverte à toute personne connectée, ou un lien INCONNU (permis, mais journalisé
 *                par l'appelant : une route qui n'a pas de module est une route que personne ne garde ici).
 *
 * Module PUR (types et libellés seulement) : le serveur l'applique à l'écriture, à la lecture et à l'envoi poussé ; un test
 * le relit sur les liens réellement émis par le code.
 */

export type GenrePorte = "siege" | "ecran" | "fiche" | "libre";

export interface PorteDuLien {
  /** Le chemin lu (sans paramètres ni ancre), `null` sans lien interne. */
  chemin: string | null;
  /** Le module qui garde la page — `null` pour une page libre ou inconnue. */
  module: Module | null;
  genre: GenrePorte;
  /** Faux pour un lien interne dont aucune route connue ne répond : permis, et à journaliser. */
  connu: boolean;
}

/**
 * LES ÉCRANS DE DÉCISION — leur accès VAUT pouvoir de décider, et leur règle n'est pas le seul « Voir » du module :
 * `sitsOnPaymentCentre`, `ouvreLeCentreDeValidations`, `siegeAuCentreAdPro`, `peutUtiliserAssistantIA`, `ouvreLeBureauAdam`
 * (la même liste que les `SIEGES` de `rbac/acces.ts`, plus les modules du Super Admin seul). Aucune exception du demandeur :
 * un demandeur suit SA demande depuis son dossier, jamais depuis le centre.
 */
export const MODULES_SIEGES: ReadonlySet<Module> = new Set<Module>([
  "PAYMENT_CENTRE", "VALIDATION_CENTRE", "AD_PRO_CENTRE", "CHIEF_OF_STAFF", "ASSISTANT_IA", "ADVENTUM_BRAIN",
]);

interface Route {
  prefixe: string;
  /** `null` : une page ouverte à toute personne connectée (elle garde elle-même ce qu'elle montre). */
  module: Module | null;
}

/**
 * LES ROUTES SERVIES HORS DU MENU — elles reçoivent des notifications mais n'ont pas d'entrée (une fiche, un ancien chemin).
 * Chacune nomme la garde de SA page (`requireModule(…)` ou `requireUser()`), relue à la main le 25/11/2026.
 */
const ROUTES_HORS_MENU: readonly Route[] = [
  // L'ancien chemin du centre de paiement (sous les Finances) : une notification d'hier le porte encore.
  { prefixe: `/finances${CHEMIN_CENTRE_DE_PAIEMENT}`, module: "PAYMENT_CENTRE" },
  // La fiche d'une mission d'Adam : le Super Admin seul (`peutPiloterMissionsAdam`, la règle de la conversation).
  { prefixe: "/missions", module: "ASSISTANT_IA" },
  { prefixe: "/messages", module: "MESSAGING" },
  { prefixe: "/notifications", module: "NOTIFICATIONS" },
  { prefixe: "/logistics", module: "LOGISTICS" },
  { prefixe: "/directives", module: "DIRECTIVES" },
  { prefixe: "/business-development", module: "BUSINESS_DEVELOPMENT" },
  // Pages ouvertes à toute personne connectée (`requireUser`) : elles filtrent elles-mêmes ce qu'elles montrent.
  { prefixe: "/praticiens", module: null },
  { prefixe: "/salles", module: null },
  { prefixe: "/ia", module: null },
];

/** Les routes du menu — la traversée même de `moduleForPath` (entrées, onglets, chemins rattachés, sous-modules). */
function routesDuMenu(): Route[] {
  const routes: Route[] = [];
  const ajouter = (prefixe: string | undefined, module: Module) => { if (prefixe && prefixe !== "/") routes.push({ prefixe, module }); };
  for (const n of NAVIGATION) {
    for (const t of n.tabs ?? []) ajouter(t.href, t.module);
    ajouter(n.href, n.module);
    for (const m of n.match ?? []) ajouter(m, n.module);
    for (const c of n.children ?? []) {
      ajouter(c.href, c.module);
      for (const m of c.match ?? []) ajouter(m, c.module);
    }
  }
  return routes;
}

/**
 * TOUTES LES ROUTES CONNUES, la plus longue d'abord. Une route du menu cède à une route hors menu de même préfixe (ces
 * dernières sont écrites pour corriger ce que le menu dirait faux : `/missions` n'est pas l'espace de travail).
 * Le préfixe le plus long gagne, comme dans `moduleForPath`, et à longueur égale l'entrée nommée en premier.
 */
export const ROUTES_CONNUES: readonly Route[] = (() => {
  const vus = new Set<string>();
  const toutes: Route[] = [];
  for (const r of [...ROUTES_HORS_MENU, ...routesDuMenu()]) {
    if (vus.has(r.prefixe)) continue;
    vus.add(r.prefixe);
    toutes.push(r);
  }
  return toutes.sort((a, b) => b.prefixe.length - a.prefixe.length);
})();

const correspond = (chemin: string, prefixe: string) => chemin === prefixe || chemin.startsWith(`${prefixe}/`);

/** Le chemin d'un lien interne, sans paramètres, sans ancre, sans barre finale ; `null` pour un lien externe ou vide. */
export function cheminDuLien(lien: string | null | undefined): string | null {
  if (!lien || !lien.startsWith("/") || lien.startsWith("//")) return null;
  const chemin = lien.split(/[?#]/)[0].replace(/\/+$/, "");
  return chemin || "/";
}

/** `surUneLigne` : le lien porte des paramètres ou une ancre — l'écran s'ouvre sur une ligne précise. */
function resoudre(chemin: string, surUneLigne: boolean): PorteDuLien | null {
  if (chemin === "/") return { chemin, module: null, genre: "libre", connu: true };
  const route = ROUTES_CONNUES.find((r) => correspond(chemin, r.prefixe));
  if (!route) return null;
  if (!route.module) return { chemin, module: null, genre: "libre", connu: true };
  const genre: GenrePorte = MODULES_SIEGES.has(route.module) ? "siege" : chemin === route.prefixe && !surUneLigne ? "ecran" : "fiche";
  return { chemin, module: route.module, genre, connu: true };
}

/**
 * LA PORTE D'UN LIEN DE NOTIFICATION. Le chemin tel qu'il a été ÉCRIT d'abord (c'est lui qui dit ce que la notification
 * visait : un ancien lien du centre de validations reste une notification du centre) ; s'il ne répond à aucune route —
 * une route supprimée depuis —, son adresse ACTUELLE (`reécriteLienNotification`, la réécriture de l'affichage).
 */
export function porteDuLien(lien: string | null | undefined): PorteDuLien {
  const chemin = cheminDuLien(lien);
  if (!chemin) return { chemin: null, module: null, genre: "libre", connu: true };
  const ecrit = resoudre(chemin, /[?#]/.test(lien!));
  if (ecrit) return ecrit;
  const lienActuel = reécriteLienNotification(lien);
  const actuel = cheminDuLien(lienActuel);
  const reecrit = actuel && actuel !== chemin ? resoudre(actuel, /[?#]/.test(lienActuel ?? "")) : null;
  return reecrit ?? { chemin, module: null, genre: "libre", connu: false };
}

/**
 * QUI L'ON ADRESSE. `nominatif` : une personne désignée par l'appelant (`notifyUser`, le destinataire d'une directive, le
 * responsable d'une tâche) — elle peut être le demandeur ou le sujet de la fiche. `collectif` : des destinataires choisis
 * par leur RÔLE, leur module ou une audience — ils ne sont jamais le sujet de ce qu'on leur annonce.
 */
export type Adresse = "nominatif" | "collectif";

/**
 * LA RÈGLE, UNE FOIS — écriture, lecture (cloche, page, « Aujourd'hui ») et envoi poussé la lisent.
 *
 * L'EXCEPTION DU DEMANDEUR, explicite : une notification adressée NOMMÉMENT vers une FICHE (sa demande, son dossier, sa
 * fiche) reste permise sans le module — la page admet son cercle (le demandeur, le sujet) et décide elle-même. Elle ne
 * vaut ni pour un écran de module (une file n'a pas de demandeur), ni pour un écran de décision (`siege`), ni pour un
 * envoi par rôle.
 *
 * À la LECTURE, on ne sait plus comment la notification a été adressée : une fiche se lit comme nominative. Ce qui a été
 * écrit pour un collectif a déjà passé la règle stricte à l'écriture ; ce qui s'affiche ainsi mène à une page qui garde
 * son cercle.
 */
export function admisParLaPorte(porte: PorteDuLien, peut: (module: Module) => boolean, adresse: Adresse): boolean {
  if (!porte.module) return true;
  if (peut(porte.module)) return true;
  return porte.genre === "fiche" && adresse === "nominatif";
}

/**
 * LES LIENS FERMÉS À UNE PERSONNE, en clause de base — pour que les COMPTES suivent la règle (une cloche à « 3 » qui
 * n'affiche que deux lignes est un mensonge, §118.60) et qu'une liste coupée à vingt lignes en montre vingt.
 *
 * Même règle que `admisParLaPorte` à la lecture : un écran de décision fermé l'est avec tout ce qui est dessous (paramètres
 * et ancre compris) ; un écran de module fermé l'est à son adresse nue ; une fiche reste lisible. Une route plus longue qui
 * OUVRE un autre module sous un préfixe fermé est rouverte (le plus long gagne, comme partout).
 *
 * Rend `null` quand rien n'est fermé (rien à ajouter à la requête). Forme Prisma (`NotificationWhereInput`), écrite sans
 * importer Prisma : le module reste pur.
 */
export function clauseLiensFermes(peut: (module: Module) => boolean): Record<string, unknown> | null {
  const dessous = (p: string) => [{ link: p }, { link: { startsWith: `${p}?` } }, { link: { startsWith: `${p}#` } }, { link: { startsWith: `${p}/` } }];
  const fermes: Record<string, unknown>[] = [];
  for (const r of ROUTES_CONNUES) {
    if (!r.module || peut(r.module)) continue;
    if (!MODULES_SIEGES.has(r.module)) {
      fermes.push({ link: r.prefixe });
      continue;
    }
    const rouvertes = ROUTES_CONNUES.filter((q) => q.prefixe.startsWith(`${r.prefixe}/`) && (!q.module || peut(q.module)));
    fermes.push(rouvertes.length
      ? { AND: [{ OR: dessous(r.prefixe) }, { NOT: { OR: rouvertes.flatMap((q) => dessous(q.prefixe)) } }] }
      : { OR: dessous(r.prefixe) });
  }
  if (!fermes.length) return null;
  // Une notification SANS lien n'ouvre rien : elle reste. (`NOT` sur une colonne nulle rendrait NULL, et la ligne partirait.)
  return { OR: [{ link: null }, { NOT: { OR: fermes } }] };
}
