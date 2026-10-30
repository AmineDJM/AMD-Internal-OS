/**
 * RECONSTRUIT L'UTILISATEUR à partir de son compte — sans session, puisqu'il n'y en a pas.
 *
 * Les DROITS sont relus en base (`getAccess`), jamais supposés : une mission lancée le lundi par
 * quelqu'un dont on a fermé un module le mardi ne doit pas continuer à s'en servir le mercredi.
 * C'est la propriété qui rend un balayage sans session acceptable — et c'est la même personne,
 * avec les mêmes droits, que la porte d'attention emploie pour lui parler par un connecteur.
 *
 * J8 : la reconstruction vit au socle de l'ERP (`lib/contexte-geste.ts`), à côté du contexte d'un geste exécuté hors
 * requête — la personne d'un travail et celle que `requireUser` rend au worker sont, par construction, la même.
 */
export { personneDuGeste as proprietaire } from "@/lib/contexte-geste";
