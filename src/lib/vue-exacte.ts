import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { MARQUE_VUE_COOKIE } from "./vue-exacte-ui";
import { COMPANY_COOKIE } from "./company";

/** Nom du cookie de « Vue exacte » (impersonation), honoré uniquement pour un Super Admin. */
export const IMPERSONATE_COOKIE = "amd_impersonate";
export { MARQUE_VUE_COOKIE };

/** Durée d'une vue : 4 h, puis retour automatique au profil réel (la garde d'identité recharge l'onglet). */
const DUREE_VUE_S = 60 * 60 * 4;

/**
 * POSER / EFFACER LA VUE — toujours ENSEMBLE, le cookie qui donne la vue (httpOnly, lu par `session.ts`)
 * et le témoin que l'écran lit (`vue-exacte-ui.ts`) : mêmes chemin et durée, pour que l'onglet sache
 * quand la vue a changé sans jamais pouvoir la créer.
 */
export async function poserVueExacte(targetId: string): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";
  jar.set(IMPERSONATE_COOKIE, targetId, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: DUREE_VUE_S });
  jar.set(MARQUE_VUE_COOKIE, targetId, { httpOnly: false, secure, sameSite: "lax", path: "/", maxAge: DUREE_VUE_S });
  // L'ENTITÉ AFFICHÉE est un choix de l'administrateur : elle ne filtre pas l'écran de la personne visualisée,
  // qui s'ouvre sur SA portée par défaut.
  jar.set(COMPANY_COOKIE, "", { path: "/", maxAge: 0 });
}

/** Efface la vue (sortie, connexion, déconnexion) : une session neuve ne reprend jamais la vue d'une autre. */
export async function effacerVueExacte(): Promise<void> {
  const jar = await cookies();
  const enVue = Boolean(jar.get(IMPERSONATE_COOKIE)?.value);
  jar.set(IMPERSONATE_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  jar.set(MARQUE_VUE_COOKIE, "", { httpOnly: false, path: "/", maxAge: 0 });
  // Et l'entité choisie DANS la vue ne survit pas à la sortie (seulement si une vue était ouverte).
  if (enVue) jar.set(COMPANY_COOKIE, "", { path: "/", maxAge: 0 });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE DEMANDE NE SE CRÉE PAS « COMME » QUELQU'UN — la Vue exacte lit en son nom, écrit au vôtre.
 *
 * « Quand un KAM recrée une demande Ad&Pro après une suppression, la nouvelle demande s'affiche
 * « Introuvable […] ne vous est pas visible » alors qu'elle apparaît dans le tableau Ad&Pro ; après
 * actualisation avec le compte admin ça marche » (Direction, 05/10).
 *
 * MESURÉ, par les vrais points d'entrée (`ad-pro/vue-exacte-creation.test.ts`) : avec un vrai KAM, la
 * fiche de la demande recréée s'ouvre — sponsoring, congrès international et national, événement,
 * y compris après la suppression de la première par le Super Admin. Le défaut n'est pas un cache : il
 * tient à la « Vue exacte ». Le Super Admin qui visualise l'ERP « comme » un KAM LIT en son nom
 * (`session.ts` honore le cookie) et ÉCRIT au sien (§118.184 : une vue n'est pas une usurpation, une
 * requête qui écrit ignore la vue). Créer une demande dans cet état produit donc :
 *   • une demande déposée par l'ADMINISTRATEUR — sans la gamme du KAM, sans son circuit ;
 *   • un tableau Ad&Pro qui la MONTRE, parce que la réponse de l'action est rendue côté écriture
 *     (le Super Admin, qui voit tout) ;
 *   • puis une fiche « Introuvable — ou ne vous est pas visible », parce que la navigation qui suit
 *     est une LECTURE, rendue pour le KAM visualisé, qui n'est pas le demandeur ;
 *   • et tout redevient normal « avec le compte admin », la vue quittée.
 *
 * ⚠️ DÉCISION DE LA DIRECTION (06/10) — « même si je visualise au nom de Leila, je veux pouvoir tester
 * son compte ». Le geste n'est donc PLUS refusé : sous une Vue exacte, les six actions de CRÉATION d'une
 * demande Ad & Pro se font AU NOM de la personne visualisée (`requireUserAuNomDeLaVue`, session.ts) —
 * son droit de créer, sa gamme, son circuit — et sa fiche s'ouvre dans la même vue. Toute AUTRE écriture
 * reste au nom du Super Admin (§118.184). Seul le Super Admin réel peut le faire (`impersonatedBy`).
 *
 * Hors requête (banc, battement), `cookies()` lève : personne ne visualise rien — rendu `null`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Le nom de la personne que ce Super Admin visualise EN CE MOMENT, ou `null`. Mêmes conditions que
 * `session.ts` pour honorer la vue : session réelle Super Admin, cookie qui désigne une AUTRE personne,
 * et cette personne existe et est active — un cookie périmé ou forgé ne bloque rien.
 */
export async function personneVisualisee(user: { id: string; role: string }): Promise<string | null> {
  if (user.role !== "SUPER_ADMIN") return null;
  let cible: string | undefined;
  try {
    cible = (await cookies()).get(IMPERSONATE_COOKIE)?.value;
  } catch {
    return null;
  }
  if (!cible || cible === user.id) return null;
  const t = await prisma.user.findUnique({ where: { id: cible }, select: { name: true, isActive: true } });
  return t?.isActive ? t.name : null;
}

