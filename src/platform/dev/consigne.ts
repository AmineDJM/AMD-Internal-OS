import type { ConsigneDev } from "./ports";

/**
 * LA CONSIGNE ENVOYÉE À CLAUDE CODE (lot C2) — pure. Contexte MINIMAL (§ 5 de l'architecture) : objectif, branche
 * réservée, périmètre, critères, commandes, extraits utiles ; jamais l'historique. Bornée à 65 536 caractères (limite
 * de la Routines API) en rognant d'abord le contexte.
 *
 * Elle arrive dans la session dans un bloc `<routine-fire-payload>` : le prompt de la routine (posé par la Direction,
 * modèle dans la décision 0043) dit de l'exécuter.
 */

export const LIMITE_CONSIGNE = 65_536;

const liste = (xs: readonly string[], vide: string) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : `- ${vide}`);

export function construireConsigne(c: ConsigneDev, limite = LIMITE_CONSIGNE): string {
  const tete = [
    `# Chantier Adventum — ${c.depot}`,
    "",
    "## Objectif",
    c.objectif.trim(),
    "",
    "## Branche (réservée à ce chantier)",
    `Travaille UNIQUEMENT sur la branche \`${c.branche}\` du dépôt \`${c.depot}\` (crée-la depuis la branche par défaut si elle n'existe pas) et pousse-y chaque étape. Ne pousse sur aucune autre branche.`,
    c.numeroPr ? `Une PR existe déjà : #${c.numeroPr}. Reprends-la (même branche), ne l'abandonne pas.` : "Ouvre une PR (brouillon accepté) depuis cette branche vers la branche par défaut quand le travail est vérifié.",
    ...(c.autoFix ? ["Active l'AUTO-FIX sur cette PR (surveille la CI et les relectures, et pousse toi-même les correctifs clairs)."] : []),
    "",
    "## Périmètre autorisé (fichiers)",
    liste(c.perimetre, "aucun périmètre déclaré : demande avant de toucher un fichier"),
    "Ne modifie rien hors de ce périmètre. Si c'est indispensable, arrête-toi et explique pourquoi dans la PR.",
    "",
    "## Critères d'acceptation",
    liste(c.criteres, "le comportement demandé fonctionne et les vérifications passent"),
    "",
    "## Vérifications à lancer avant chaque push",
    liste(c.commandes, "les commandes du CLAUDE.md du dépôt"),
    "",
    "## Rendu",
    "Termine par un commit poussé sur la branche. Dans la PR, résume : ce qui est fait, les vérifications et leur résultat, les limites. Adventum vérifie lui-même sur GitHub (commits, fichiers touchés, checks) : ne déclare jamais réussi ce qui n'est pas vérifié.",
  ].join("\n");
  const contexte = (c.contexte ?? "").trim();
  if (!contexte) return tete.slice(0, limite);
  const enTete = "\n\n## Contexte (extraits utiles)\n";
  const place = limite - tete.length - enTete.length;
  if (place <= 20) return tete.slice(0, limite);
  return `${tete}${enTete}${contexte.length > place ? `${contexte.slice(0, place - 1)}…` : contexte}`;
}
