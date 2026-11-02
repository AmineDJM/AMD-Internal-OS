import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canReadEntity, type EntityDef } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { entiteDuModele } from "./modele-entite";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * APRÈS AVOIR ÉCRIT, ON RELIT — « c'est fait » n'est pas une preuve.
 *
 * Le chemin générique concluait `{ ok: true, message: "setRegulatoryPriority exécutée." }`. La
 * personne n'avait qu'une PAROLE : rien à l'écran ne lui permettait de constater ce qui avait
 * changé. C'est très exactement ce que §104.16 interdit — « c'est fait » redevient une parole
 * à croire, ce qu'aucun écran de ce produit n'a le droit de demander — et le retour de
 * l'action, qui portait souvent l'identifiant écrit, était JETÉ.
 *
 * ── CE QUE CE MODULE FAIT, ET SOUS QUELS DROITS ──────────────────────────────────────────
 *
 * Il relit la ligne TOUCHÉE, par le MÊME chemin que l'écran : `porteeEntite` compose la portée
 * par ligne du module et le cloisonnement par entité. Relire avec un accès privilégié
 * montrerait à la personne une ligne qu'elle n'a pas le droit de voir — un contournement de
 * permission introduit par un geste de vérification, c'est-à-dire le pire endroit possible.
 *
 * ── CE QU'IL NE FAIT JAMAIS ──────────────────────────────────────────────────────────────
 *
 * Il ne DEVINE pas la ligne. Deux modèles écrits, aucun identifiant lisible, une entité
 * inconnue du registre : il rend `null`, et l'appelant DIT qu'il n'a pas pu constater. Rendre
 * « à peu près la bonne ligne » serait pire que ne rien rendre : la personne validerait un
 * changement en regardant un autre enregistrement (§104.7).
 *
 * Et un `null` n'annule pas l'écriture — elle a eu lieu. Ce qui change est la PHRASE : « fait,
 * voici la ligne » ou « fait, je n'ai pas pu le constater », jamais « fait » tout court.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on a pu constater APRÈS l'écriture. Les clés sont toujours les mêmes (§118.20). */
export interface Relecture {
  entite: string;
  libelle: string;
  id: string;
  /** Les champs de détail de la ligne, tels que l'écran les montre. */
  champs: { nom: string; valeur: string }[];
}

/** L'identifiant écrit — celui que l'action REND d'abord, celui qu'on lui a DONNÉ ensuite. */
function identifiantEcrit(retour: unknown, entree: Readonly<Record<string, unknown>>): string | null {
  // LE RETOUR FAIT FOI : sur une CRÉATION, l'entrée ne porte aucun identifiant, et c'est
  // l'action qui vient de le fabriquer. Le lire ailleurs relirait la mauvaise ligne.
  if (retour && typeof retour === "object" && !Array.isArray(retour)) {
    const v = (retour as { id?: unknown }).id;
    if (typeof v === "string" && v) return v;
  }
  const donne = entree.id;
  return typeof donne === "string" && donne ? donne : null;
}

const enTexte = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(enTexte).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/**
 * RELIT LA LIGNE QUE L'ACTION VIENT D'ÉCRIRE. `null` quand on ne peut pas la désigner à coup
 * sûr, quand la personne n'a pas le droit de la lire, ou quand elle n'existe plus (suppression).
 */
export async function relireApresEcriture(
  user: SessionUser,
  modelesEcrits: readonly string[],
  entree: Readonly<Record<string, unknown>>,
  retour: unknown,
): Promise<Relecture | null> {
  const id = identifiantEcrit(retour, entree);
  if (!id) return null;

  // QUELLE LIGNE MONTRER, quand l'action écrit plusieurs modèles.
  //
  // « Un seul modèle écrit, sinon on renonce » a tenu tant que la dérivation ne voyait que le
  // corps de l'action. Depuis qu'elle suit les délégués IMPORTÉS, une écriture ordinaire déclare
  // ce qu'elle touche VRAIMENT — `createRequest` rend `administrativeRequest`, `auditLog` et
  // `notification` — et les trois sont des entités du registre. La relecture renonçait donc sur
  // le cas le plus banal du parc : une écriture, son journal, sa notification. C'est §118.61 :
  // une réparation a DÉPLACÉ une donnée, et ce lecteur-ci lisait encore l'ancienne forme.
  //
  // Le remède n'est pas une liste de modèles à ignorer — elle serait fausse à la première table
  // de journal ajoutée, en silence (§118.73). C'est un FAIT, et il est déjà sous la main :
  // l'identifiant que nous tenons désigne UNE ligne. On demande à chaque candidat s'il porte
  // cette ligne, DANS LA PORTÉE DE LA PERSONNE ; le journal d'une écriture ne porte jamais
  // l'identifiant de la ligne écrite. Si deux candidats la portent, on renonce comme avant :
  // montrer « à peu près la bonne ligne » est pire que ne rien montrer (§118.81).
  const candidats = modelesEcrits.map(entiteDuModele).filter((d): d is EntityDef => d !== null);
  if (candidats.length === 0 || candidats.length > CANDIDATS_MAX) return null;

  const trouvees: Relecture[] = [];
  for (const def of candidats) {
    // LA GARDE RESTE AVANT LA LECTURE, candidat par candidat : interroger une table que la
    // personne n'a pas le droit de lire serait un contournement introduit par un geste de
    // VÉRIFICATION, c'est-à-dire au pire endroit possible (§118.81).
    if (!canReadEntity(user, def)) continue;
    const lue = await lireUne(user, def, id);
    if (lue) trouvees.push(lue);
  }
  if (trouvees.length !== 1) return null;
  return trouvees[0]!;
}

/** Combien de modèles écrits on interroge au plus — une action en touche une poignée. */
const CANDIDATS_MAX = 8;

/** Lit la ligne `id` du modèle `def` dans la portée de la personne. `null` si elle n'y est pas. */
async function lireUne(user: SessionUser, def: EntityDef, id: string): Promise<Relecture | null> {
  const model = (prisma as unknown as Record<string, {
    findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
  }>)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
  if (!model) return null;

  const champs = def.detailFields?.length ? def.detailFields : def.listFields;
  const select = Object.fromEntries([...new Set(["id", ...champs])].map((c) => [c, true as const]));

  const portee = await porteeEntite(user, def);
  const ligne = await model.findFirst({ where: { AND: [portee, { id }] }, select }).catch(sansBloquer("relire.lireUne.findFirst", null));
  if (!ligne) return null;

  return {
    entite: def.name,
    libelle: def.label,
    id,
    champs: champs.filter((c) => c in ligne).map((c) => ({ nom: c, valeur: enTexte(ligne[c]) })),
  };
}
