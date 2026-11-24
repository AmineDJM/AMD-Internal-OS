import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REFERENTS, ENTITE_DU_MODELE, LIENS_DIRECTS, REFERENCES_TEXTE, faitIrreversible, delegueDe, libelleDe, nomDe } from "./branches";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LOT DE SUPPRESSION — une demande et TOUTES ses branches partent ensemble, dans une seule
 * entrée de corbeille, et reviennent ensemble (§118.162).
 *
 * Trois propriétés, et chacune a un cas qui la justifie :
 *
 *   1. TOUT OU RIEN. L'ancien cœur supprimait les pièces jointes, puis la ligne, et « remettait »
 *      les pièces si la ligne refusait de partir. Avec seize tables en jeu, une remise à la main
 *      finit par oublier quelque chose. Le lot s'écrit dans UNE transaction : une suppression qui
 *      échoue à mi-chemin ne laisse rien derrière elle.
 *
 *   2. CE QUI PART REVIENT. La corbeille ne rendait que la ligne PRINCIPALE : les postes d'un
 *      sponsoring, partis en cascade par la clé étrangère, ne revenaient pas — restaurer rendait
 *      une demande vide de son contenu, sous le mot « restaurable » (§118.141c, §104.16). Le lot
 *      instantane CHAQUE ligne qui disparaîtra, y compris celles que Postgres efface en cascade,
 *      et les recrée parents d'abord.
 *
 *   3. RIEN N'EST ÉCRIT À LA MAIN QUI PUISSE PRENDRE DU RETARD. Les enfants en cascade, les liens
 *      « mis à vide » depuis l'extérieur, l'ordre de suppression et de recréation : tout est lu
 *      dans le schéma (DMMF), au moment de supprimer. Un enfant ajouté demain au schéma entre dans
 *      le lot sans que personne y pense (§118.73). Seule la table des couples (type, identifiant)
 *      est une décision humaine, et un cliquet exige qu'elle soit complète (`branches.ts`).
 *
 * Et une limite OPÉRATIONNELLE, dite comme telle (§118.2) : au-delà de `MAX_LIGNES`, le lot est
 * refusé en nommant le nombre — une suppression de cette taille ne se fait pas d'un clic.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MAX_LIGNES = 5000;

interface Ligne { modele: string; id: string; donnees: Record<string, unknown> }
type Delegue = {
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  findUnique: (a: unknown) => Promise<Record<string, unknown> | null>;
  deleteMany: (a: unknown) => Promise<{ count: number }>;
  create: (a: unknown) => Promise<unknown>;
  updateMany: (a: unknown) => Promise<{ count: number }>;
};
type Client = Prisma.TransactionClient | typeof prisma;
const d = (c: Client, modele: string) => (c as unknown as Record<string, Delegue>)[delegueDe(modele)];

// ─── LE SCHÉMA, LU UNE FOIS ────────────────────────────────────────────────────────────────
const MODELES = Prisma.dmmf.datamodel.models;
const PAR_NOM = new Map(MODELES.map((m) => [m.name, m]));

type Action = "Cascade" | "SetNull" | "Restrict";
interface RelationFK { enfant: string; champ: string; parent: string; action: Action }

/**
 * Toutes les clés étrangères à UN champ qui visent l'identifiant de leur parent — avec l'action
 * EFFECTIVE à la suppression. Sans action déclarée, Prisma applique `SetNull` à une relation
 * facultative et `Restrict` à une relation obligatoire : lire « default » comme « rien » ferait
 * croire qu'une suppression passera là où Postgres la refusera.
 */
export const RELATIONS: readonly RelationFK[] = MODELES.flatMap((m) =>
  m.fields
    .filter((f) => f.kind === "object" && (f.relationFromFields?.length ?? 0) === 1 && (f.relationToFields?.[0] ?? "id") === "id")
    .map((f) => {
      const champ = f.relationFromFields![0]!;
      const scalaire = m.fields.find((x) => x.name === champ);
      const declaree = f.relationOnDelete as string | undefined;
      const action: Action = declaree === "Cascade" ? "Cascade"
        : declaree === "SetNull" ? "SetNull"
        : declaree ? "Restrict"
        : scalaire?.isRequired ? "Restrict" : "SetNull";
      return { enfant: m.name, champ, parent: f.type, action };
    }),
);

const EMPORTEES = REFERENTS.filter((r) => r.conduite === "EMPORTEE");

/**
 * LA CLÉ PRIMAIRE d'un modèle — `id` presque partout, mais pas toujours : une case de devis de
 * prise en charge (`CareQuoteCell`) se désigne par (devis, case). Le cas n'est pas théorique, il
 * est dans le lot d'un congrès, et il est dangereux : `deleteMany({ where: { id: undefined } })`
 * ne filtre RIEN — Prisma ignore une clé indéfinie — et effacerait la table entière. D'où
 * `ouIdentite`, qui refuse d'écrire une condition dont une valeur manque.
 */
function clePrimaire(modele: string): string[] {
  const m = PAR_NOM.get(modele);
  const id = m?.fields.find((f) => f.isId);
  if (id) return [id.name];
  return [...(m?.primaryKey?.fields ?? [])];
}

function identite(modele: string, row: Record<string, unknown>): string {
  return clePrimaire(modele).map((k) => String(row[k])).join("|");
}

/** La condition qui désigne CETTE ligne et elle seule — ou une exception, jamais « tout ». */
export function ouIdentite(modele: string, row: Record<string, unknown>): Record<string, unknown> {
  const champs = clePrimaire(modele);
  if (champs.length === 0) throw new Error(`[lot] ${modele} n'a pas de clé primaire lisible`);
  const where: Record<string, unknown> = {};
  for (const k of champs) {
    const v = row[k];
    if (v === undefined || v === null || v === "") throw new Error(`[lot] clé ${modele}.${k} absente — condition refusée`);
    where[k] = v;
  }
  return where;
}

/** Les octets d'un champ `Bytes` ne traversent pas le JSON tels quels : on les encode. */
function versJson(modele: string, row: Record<string, unknown>): Record<string, unknown> {
  const m = PAR_NOM.get(modele);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const f = m?.fields.find((x) => x.name === k);
    if (f?.type === "Bytes" && v) out[k] = { $bytes: Buffer.from(v as Uint8Array).toString("base64") };
    else if (typeof v === "bigint") out[k] = { $bigint: v.toString() };
    else out[k] = v;
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/**
 * L'inverse, pour recréer : les octets reviennent en Buffer, et un JSON vide n'est pas envoyé —
 * Prisma refuse `null` sur un champ `Json` (il exige `DbNull`), et l'omettre revient au même :
 * la colonne naît vide.
 */
function depuisJson(modele: string, row: Record<string, unknown>): Record<string, unknown> {
  const m = PAR_NOM.get(modele);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const f = m?.fields.find((x) => x.name === k);
    if (!f || f.kind === "object") continue;
    if (f.type === "Json" && v === null) continue;
    if (f.type === "Bytes" && v && typeof v === "object" && "$bytes" in (v as object)) {
      out[k] = Buffer.from(String((v as { $bytes: string }).$bytes), "base64");
      continue;
    }
    if (f.type === "BigInt" && v && typeof v === "object" && "$bigint" in (v as object)) {
      out[k] = BigInt(String((v as { $bigint: string }).$bigint));
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface Inventaire {
  /** La tête (la demande) puis ses branches, dans l'ordre PARENTS D'ABORD (celui de la recréation). */
  lignes: Ligne[];
  documents: Record<string, unknown>[];
  commentaires: Record<string, unknown>[];
  /**
   * Liens « mis à vide » depuis des lignes qui RESTENT : on les rétablit à la restauration.
   * `doux` : un lien DIRECT (un champ texte, pas une clé étrangère) — Postgres ne le viderait
   * pas, c'est le lot qui le vide, dans la même transaction.
   */
  liensExternes: { modele: string; cle: Record<string, unknown>; champ: string; valeur: string; doux?: boolean }[];
  /**
   * LES LIENS DE LA TÊTE VERS UNE DE SES BRANCHES (constat 20 de l'audit du 04/10). Un poste désigne la
   * demande au secrétariat qui travaille pour lui (`adminRequestId`), et cette demande part AVEC lui (le
   * couple `linkedEntityType` l'emporte) : la tête dépend d'une de ses branches. Recréée la première, elle
   * violerait sa clé étrangère. Quand la colonne est FACULTATIVE, le lien se DIFFÈRE : la tête renaît sans
   * lui, les branches renaissent, puis le lien est rétabli — dans la même transaction. Une colonne
   * OBLIGATOIRE ne se diffère pas, et le lot reste refusé en le disant.
   */
  liensTete: { champ: string; valeur: string }[];
  /** Ce qui interdit la suppression — vide : rien. */
  bloquants: string[];
  /**
   * LES FAITS QUI ONT QUITTÉ L'ERP (`faitIrreversible`), nommés. La corbeille les compte parmi les `bloquants` ; la
   * suppression DÉFINITIVE du Super Admin (`definitive.ts`), elle, passe outre — et les montre dans son aperçu.
   */
  faits: string[];
  /** « 2 postes », « 1 déclaration d'information médicale »… — hors la tête. */
  resume: string[];
}

const cle = (modele: string, id: string) => `${modele}:${id}`;

/**
 * CE QUE LA SUPPRESSION DÉFINITIVE AJOUTE au lot de la corbeille (`definitive.ts`) — vide pour la corbeille, qui ne
 * change pas. Trois réglages, et chacun répond à un cas que la corbeille refuse au lieu de le suivre :
 *   • `suites` : des liens directs de plus, suivis en aval (l'écriture de trésorerie qui a réglé l'ordre) ;
 *   • `retours` : des liens suivis À REBOURS (le dossier compagnon d'un ordre, la contre-passation d'une écriture) ;
 *   • `exclus` : des lignes qui n'entrent JAMAIS dans le lot (`Modele:id`) — une pièce Legal partagée avec autre chose.
 * Et `faitsBloquent` à faux : un fait qui a quitté l'ERP est nommé (`faits`), il n'arrête plus rien ; `recreer: false` :
 * rien ne sera recréé, l'ordre de recréation n'est plus une condition (seul compte l'ordre de suppression, enfants d'abord).
 */
export interface OptionsInventaire {
  suites?: readonly { modele: string; champ: string; cible: string }[];
  retours?: readonly { modele: string; champ: string; cible: string; ou?: Record<string, unknown> }[];
  exclus?: ReadonlySet<string>;
  faitsBloquent?: boolean;
  recreer?: boolean;
}

/** `Modele:id` — la clé d'une ligne du lot, celle que lit `OptionsInventaire.exclus`. */
export const cleDeLigne = cle;

/** La clé primaire lue sur une ligne — `id`, ou le couple d'une clé composée. */
export function identiteDe(modele: string, row: Record<string, unknown>): string {
  return identite(modele, row);
}

/**
 * TOUT ce qui partirait avec cette ligne — sans rien écrire. Sert l'aperçu (ce que la personne
 * lit AVANT de confirmer, §118.53) et la suppression elle-même : les deux lisent le même
 * inventaire, sinon l'aperçu annoncerait un périmètre que la suppression dépasserait.
 */
export async function inventorier(modeleTete: string, idTete: string, opts: OptionsInventaire = {}): Promise<Inventaire | null> {
  const tete = await d(prisma, modeleTete).findUnique({ where: { id: idTete } });
  if (!tete) return null;
  const suites = [...LIENS_DIRECTS, ...(opts.suites ?? [])];
  const faitsBloquent = opts.faitsBloquent ?? true;

  const vus = new Map<string, Ligne>();
  const ordre: Ligne[] = [];
  const ajouter = (modele: string, row: Record<string, unknown>): Ligne | null => {
    const id = identite(modele, row);
    const k = cle(modele, id);
    if (vus.has(k) || (ordre.length > 0 && opts.exclus?.has(k))) return null;
    const l = { modele, id, donnees: row };
    vus.set(k, l);
    ordre.push(l);
    return l;
  };
  ajouter(modeleTete, tete);

  // En LARGEUR, par niveau et par modèle : une requête par (relation, niveau), jamais une par ligne.
  let frontiere: Ligne[] = [ordre[0]!];
  while (frontiere.length > 0 && vus.size <= MAX_LIGNES) {
    const suivante: Ligne[] = [];
    const parModele = new Map<string, Ligne[]>();
    for (const l of frontiere) parModele.set(l.modele, [...(parModele.get(l.modele) ?? []), l]);

    for (const [modele, lignes] of parModele) {
      const ids = lignes.map((l) => l.id);
      // 1. Ce que Postgres effacerait en cascade — on l'instantane pour pouvoir le rendre.
      for (const r of RELATIONS) {
        if (r.parent !== modele || r.action !== "Cascade") continue;
        for (const row of await d(prisma, r.enfant).findMany({ where: { [r.champ]: { in: ids } } })) {
          const n = ajouter(r.enfant, row);
          if (n) suivante.push(n);
        }
      }
      // 2. Les couples (type, identifiant) qui désignent ces lignes — et qui partent avec elles.
      const entite = ENTITE_DU_MODELE[modele];
      if (entite) {
        for (const ref of EMPORTEES) {
          for (const row of await d(prisma, ref.modele).findMany({ where: { [ref.champType]: entite, [ref.champId]: { in: ids } } })) {
            const n = ajouter(ref.modele, row);
            if (n) suivante.push(n);
          }
        }
      }
      // 3. Les liens directs vers ce qu'une branche a créé en aval.
      for (const lien of suites) {
        if (lien.modele !== modele) continue;
        const cibles = lignes.map((l) => l.donnees[lien.champ]).filter((x): x is string => typeof x === "string" && x.length > 0);
        if (cibles.length === 0) continue;
        for (const row of await d(prisma, lien.cible).findMany({ where: { id: { in: cibles } } })) {
          const n = ajouter(lien.cible, row);
          if (n) suivante.push(n);
        }
      }
      // 4. Les liens suivis à rebours (suppression définitive seulement) : ce qui désigne une ligne du lot et n'existe que pour elle.
      for (const lien of opts.retours ?? []) {
        if (lien.cible !== modele) continue;
        for (const row of await d(prisma, lien.modele).findMany({ where: { ...(lien.ou ?? {}), [lien.champ]: { in: ids } } })) {
          const n = ajouter(lien.modele, row);
          if (n) suivante.push(n);
        }
      }
    }
    frontiere = suivante;
  }

  const bloquants: string[] = [];
  if (vus.size > MAX_LIGNES) {
    bloquants.push(`plus de ${MAX_LIGNES} éléments liés : une suppression de cette taille ne se fait pas d'un seul geste`);
    return { lignes: ordre, documents: [], commentaires: [], liensExternes: [], liensTete: [], bloquants, faits: [], resume: [] };
  }

  // ─── LES FAITS QUI ONT QUITTÉ L'ERP ─────────────────────────────────────────────────────
  const faits: string[] = [];
  for (const l of ordre) {
    const fait = faitIrreversible(l.modele, l.donnees);
    if (fait) faits.push(fait);
  }
  if (faitsBloquent) bloquants.push(...faits);

  // ─── PIÈCES JOINTES ET COMMENTAIRES, de chaque ligne qui a un type d'entité ────────────────
  const documents: Record<string, unknown>[] = [];
  const commentaires: Record<string, unknown>[] = [];
  const parEntite = new Map<string, string[]>();
  for (const l of ordre) {
    const e = ENTITE_DU_MODELE[l.modele];
    if (e) parEntite.set(e, [...(parEntite.get(e) ?? []), l.id]);
  }
  for (const [entite, ids] of parEntite) {
    documents.push(...(await prisma.document.findMany({ where: { entityType: entite as never, entityId: { in: ids } } })) as unknown as Record<string, unknown>[]);
    commentaires.push(...(await prisma.comment.findMany({ where: { entityType: entite as never, entityId: { in: ids } } })) as unknown as Record<string, unknown>[]);
  }

  // ─── CE QUI, DEHORS, DÉPEND DU LOT ──────────────────────────────────────────────────────
  // Une clé RESTRICT depuis une ligne qui reste bloquerait la suppression dans Postgres : on le
  // dit avant. Une clé SET NULL serait vidée en silence : on la note pour la rétablir.
  const liensExternes: Inventaire["liensExternes"] = [];
  const idsParModele = new Map<string, string[]>();
  for (const l of ordre) idsParModele.set(l.modele, [...(idsParModele.get(l.modele) ?? []), l.id]);
  // Les pièces jointes et commentaires partent aussi : ce qui les désigne du dehors (la pièce d'un
  // courrier qui cite un fichier, par exemple) se rétablit de la même façon.
  if (documents.length) idsParModele.set("Document", documents.map((x) => String(x.id)));
  if (commentaires.length) idsParModele.set("Comment", commentaires.map((x) => String(x.id)));
  const dedansPieces = new Set<string>([
    ...documents.map((x) => cle("Document", String(x.id))),
    ...commentaires.map((x) => cle("Comment", String(x.id))),
  ]);
  for (const [modele, ids] of idsParModele) {
    for (const r of RELATIONS) {
      if (r.parent !== modele || r.action === "Cascade") continue;
      const select: Record<string, true> = { [r.champ]: true };
      for (const k of clePrimaire(r.enfant)) select[k] = true;
      const rows = await d(prisma, r.enfant).findMany({ where: { [r.champ]: { in: ids } }, select });
      for (const row of rows) {
        const id = identite(r.enfant, row);
        if (vus.has(cle(r.enfant, id)) || dedansPieces.has(cle(r.enfant, id))) continue;
        if (r.action === "Restrict") bloquants.push(`${nomDe(r.enfant)} (${id}) dépend encore d'un élément de la demande`);
        else liensExternes.push({ modele: r.enfant, cle: ouIdentite(r.enfant, row), champ: r.champ, valeur: String(row[r.champ]) });
      }
    }
  }

  // Les LIENS DIRECTS vers une branche, depuis une ligne qui RESTE — une facture d'un autre
  // dossier qui désigne l'ordre de dépense de celui-ci. Ce sont des champs texte, pas des clés
  // étrangères : Postgres ne les viderait pas, et ils désigneraient une ligne disparue — la
  // facture se croirait « partie au circuit » sur un ordre qui n'existe plus. Le lot les vide, et
  // les rétablit à la restauration, comme un lien mis à vide par une clé étrangère. Les RÉFÉRENCES
  // TEXTE (§118.176) se traitent ici de la même façon — et ici SEULEMENT : elles ne font jamais
  // entrer leur ligne dans le lot.
  // Une SUITE qui est une clé étrangère (la pièce d'un poste vers sa pièce Legal) est déjà lue plus haut, par le schéma.
  const estCleEtrangere = (modele: string, champ: string) => RELATIONS.some((r) => r.enfant === modele && r.champ === champ);
  for (const lien of [...suites, ...REFERENCES_TEXTE]) {
    if (estCleEtrangere(lien.modele, lien.champ)) continue;
    const cibles = idsParModele.get(lien.cible);
    if (!cibles?.length) continue;
    const select: Record<string, true> = { [lien.champ]: true };
    for (const k of clePrimaire(lien.modele)) select[k] = true;
    const rows = await d(prisma, lien.modele).findMany({ where: { [lien.champ]: { in: cibles } }, select });
    for (const row of rows) {
      if (vus.has(cle(lien.modele, identite(lien.modele, row)))) continue;
      liensExternes.push({ modele: lien.modele, cle: ouIdentite(lien.modele, row), champ: lien.champ, valeur: String(row[lien.champ]), doux: true });
    }
  }

  // Les liens de la TÊTE vers une branche, sur une colonne FACULTATIVE : différés (voir `liensTete`).
  const teteLigne = ordre[0]!;
  const dansLeLot = new Set(ordre.map((l) => cle(l.modele, l.id)));
  const liensTete: Inventaire["liensTete"] = [];
  for (const r of RELATIONS) {
    if (r.enfant !== teteLigne.modele) continue;
    const v = teteLigne.donnees[r.champ];
    if (typeof v !== "string" || !dansLeLot.has(cle(r.parent, v)) || cle(r.parent, v) === cle(teteLigne.modele, teteLigne.id)) continue;
    const scalaire = PAR_NOM.get(teteLigne.modele)?.fields.find((f) => f.name === r.champ);
    if (scalaire && !scalaire.isRequired) liensTete.push({ champ: r.champ, valeur: v });
  }
  const differes = new Set(liensTete.map((l) => l.champ));
  const lignes = trierParentsDabord(ordre, differes);
  if (opts.recreer === false) { /* une destruction ne recrée rien : l'ordre de recréation n'est pas une condition */ }
  else if (!lignes) bloquants.push("des éléments liés se désignent en boucle — le lot ne saurait pas dans quel ordre les recréer");
  // La tête se recrée la PREMIÈRE (elle vit dans `payload`, hors du lot) : si elle dépendait
  // d'une de ses branches, cet ordre ne tiendrait pas — on le dit au lieu de le découvrir à la
  // restauration.
  else if (lignes[0] !== ordre[0]) bloquants.push("la demande dépend d'une de ses propres branches — ordre de recréation impossible");

  const compte = new Map<string, number>();
  for (const l of ordre.slice(1)) compte.set(l.modele, (compte.get(l.modele) ?? 0) + 1);
  const resume = [...compte].sort((a, b) => b[1] - a[1]).map(([m, n]) => libelleDe(m, n));
  if (documents.length) resume.push(`${documents.length} pièce${documents.length > 1 ? "s" : ""} jointe${documents.length > 1 ? "s" : ""}`);

  return { lignes: lignes ?? ordre, documents, commentaires, liensExternes, liensTete, bloquants: [...new Set(bloquants)], faits: [...new Set(faits)], resume };
}

/**
 * L'ORDRE DE RECRÉATION : un parent avant ses enfants, pour toute clé étrangère ENTRE lignes du
 * lot. Rend `null` sur une boucle — on ne devine pas un ordre qu'on ne sait pas tenir.
 */
function trierParentsDabord(lignes: Ligne[], differesTete: ReadonlySet<string> = new Set()): Ligne[] | null {
  const index = new Map(lignes.map((l) => [cle(l.modele, l.id), l]));
  const parents = new Map<string, Set<string>>();
  for (const [i, l] of lignes.entries()) {
    const ps = new Set<string>();
    for (const r of RELATIONS) {
      if (r.enfant !== l.modele) continue;
      // Un lien DIFFÉRÉ de la tête n'impose aucun ordre : il se rétablit après les branches.
      if (i === 0 && differesTete.has(r.champ)) continue;
      const v = l.donnees[r.champ];
      if (typeof v !== "string") continue;
      const k = cle(r.parent, v);
      if (index.has(k) && k !== cle(l.modele, l.id)) ps.add(k);
    }
    parents.set(cle(l.modele, l.id), ps);
  }
  const sortie: Ligne[] = [];
  const places = new Set<string>();
  let restantes = [...lignes];
  while (restantes.length > 0) {
    const pretes = restantes.filter((l) => [...(parents.get(cle(l.modele, l.id)) ?? [])].every((p) => places.has(p)));
    if (pretes.length === 0) return null;
    for (const l of pretes) { sortie.push(l); places.add(cle(l.modele, l.id)); }
    const faites = new Set(pretes.map((l) => cle(l.modele, l.id)));
    restantes = restantes.filter((l) => !faites.has(cle(l.modele, l.id)));
  }
  return sortie;
}

/** L'instantané de la TÊTE du lot — même encodage que ses branches (octets, grands entiers). */
export function instantaneTete(tete: Ligne): Record<string, unknown> {
  return versJson(tete.modele, tete.donnees);
}

/** Ce que la corbeille garde du lot — tout ce qu'il faut pour le recréer à l'identique. */
export interface InstantaneLot {
  version: 1;
  /** Branches, parents d'abord — la tête n'y est PAS (elle vit dans `payload`, comme avant). */
  lignes: { modele: string; donnees: Record<string, unknown> }[];
  liensExternes: Inventaire["liensExternes"];
  /** Les liens de la tête vers une branche, rétablis APRÈS les branches (absent d'un lot ancien : aucun). */
  liensTete?: Inventaire["liensTete"];
  resume: string[];
}

/**
 * SUPPRIME le lot — tout ou rien. L'appelant a déjà vérifié le droit et l'absence de bloquant.
 * Rend l'instantané à déposer dans la corbeille (écrit par le cœur, dans la même transaction).
 */
export async function supprimerLot(
  inv: Inventaire,
  deposer: (tx: Prisma.TransactionClient, lot: InstantaneLot, tete: Ligne) => Promise<void>,
): Promise<void> {
  if (inv.bloquants.length > 0) throw new Error("[lot] suppression d'un lot bloqué — l'appelant devait refuser");
  const tete = inv.lignes[0]!;
  const lot: InstantaneLot = {
    version: 1,
    lignes: inv.lignes.filter((l) => l !== tete).map((l) => ({ modele: l.modele, donnees: versJson(l.modele, l.donnees) })),
    liensExternes: inv.liensExternes,
    liensTete: inv.liensTete,
    resume: inv.resume,
  };
  const enfantsDabord = [...inv.lignes].reverse();
  const idsDocs = inv.documents.map((x) => String(x.id));
  const idsComs = inv.commentaires.map((x) => String(x.id));
  await prisma.$transaction(async (tx) => {
    // Les liens DIRECTS du dehors d'abord : seule la ligne qui porte encore CETTE valeur est
    // touchée — si quelqu'un l'a changée depuis l'inventaire, on ne la vide pas.
    for (const lien of inv.liensExternes) {
      if (lien.doux) await d(tx, lien.modele).updateMany({ where: { ...lien.cle, [lien.champ]: lien.valeur }, data: { [lien.champ]: null } });
    }
    if (idsDocs.length) await tx.document.deleteMany({ where: { id: { in: idsDocs } } });
    if (idsComs.length) await tx.comment.deleteMany({ where: { id: { in: idsComs } } });
    // deleteMany et non delete : une ligne déjà partie en cascade avec son parent compte 0,
    // ce qui est exactement ce qu'on veut. La condition vient de `ouIdentite`, qui refuse une
    // clé manquante — jamais une condition vide.
    for (const l of enfantsDabord) await d(tx, l.modele).deleteMany({ where: ouIdentite(l.modele, l.donnees) });
    await deposer(tx, lot, tete);
  }, { timeout: 60_000, maxWait: 10_000 });
}

/**
 * RECRÉE le lot — la tête, puis les branches parents d'abord, puis les pièces et commentaires,
 * puis les liens extérieurs. Tout ou rien : une restauration à moitié serait pire qu'aucune.
 */
export async function restaurerLot(
  modeleTete: string,
  tete: Record<string, unknown>,
  lot: InstantaneLot,
  documents: Record<string, unknown>[],
  commentaires: Record<string, unknown>[],
): Promise<void> {
  const differes = lot.liensTete ?? [];
  const donneesTete = depuisJson(modeleTete, tete);
  for (const l of differes) donneesTete[l.champ] = null;
  await prisma.$transaction(async (tx) => {
    await d(tx, modeleTete).create({ data: donneesTete });
    for (const l of lot.lignes) await d(tx, l.modele).create({ data: depuisJson(l.modele, l.donnees) });
    // Les liens de la tête vers ses branches, maintenant qu'elles existent.
    const idTete = String(tete.id ?? "");
    for (const l of differes) {
      await d(tx, modeleTete).updateMany({ where: { ...ouIdentite(modeleTete, { id: idTete }), [l.champ]: null }, data: { [l.champ]: l.valeur } });
    }
    // Les pièces AVANT les liens extérieurs : un lien peut viser une pièce (la pièce d'un courrier).
    if (documents.length) await tx.document.createMany({ data: documents as never[], skipDuplicates: true });
    if (commentaires.length) await tx.comment.createMany({ data: commentaires as never[], skipDuplicates: true });
    for (const lien of lot.liensExternes) {
      await d(tx, lien.modele).updateMany({ where: { ...lien.cle, [lien.champ]: null }, data: { [lien.champ]: lien.valeur } });
    }
  }, { timeout: 60_000, maxWait: 10_000 });
}

/** Les identifiants du lot déjà présents en base — une restauration qui écraserait refuse. */
export async function dejaPresents(modeleTete: string, idTete: string, lot: InstantaneLot): Promise<number> {
  let n = (await d(prisma, modeleTete).findUnique({ where: { id: idTete } })) ? 1 : 0;
  for (const l of lot.lignes) {
    if ((await d(prisma, l.modele).findMany({ where: ouIdentite(l.modele, l.donnees), take: 1 })).length > 0) n += 1;
  }
  return n;
}
