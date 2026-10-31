import { Prisma } from "@prisma/client";

/**
 * CE QUE LE SCHÉMA DIT D'UN MODÈLE (J7, décision 0029) — lu UNE fois dans le DMMF de Prisma, jamais déclaré à la main :
 * la clé, les champs scalaires (sans les octets), les types (pour restaurer une valeur), la table, les enfants supprimés
 * en cascade, la valeur « annulé » d'un statut. Une table ajoutée au schéma est couverte sans une ligne de plus.
 */

type ChampDmmf = (typeof Prisma.dmmf.datamodel.models)[number]["fields"][number];

export interface Cascade { modele: string; delegue: string; champ: string }

export interface InfoModele {
  nom: string;
  delegue: string;
  table: string;
  /** La clé simple — `null` pour une clé composée (la capture garde l'écriture, l'annulation la dit impossible). */
  cle: string | null;
  cleColonne: string | null;
  /** La clé est une chaîne tirée par défaut (`cuid()`, `uuid()`) : la capture peut la fixer elle-même avant l'écriture. */
  cleGeneree: boolean;
  /** Champs scalaires et énumérés, SANS les octets (`Bytes`) : ce que la capture lit et ce qui se restaure. */
  scalaires: string[];
  types: ReadonlyMap<string, { type: string; liste: boolean; enumere: boolean; obligatoire: boolean; defaut: boolean }>;
  octets: string[];
  /** Les champs `@updatedAt` : Prisma les pose à chaque écriture — ni comparés, ni restaurés. */
  auto: ReadonlySet<string>;
  /** Les relations qui POINTENT vers ce modèle (un enfant porte la clé étrangère) — pour dire « quelque chose s'y est rattaché ». */
  enfants: Cascade[];
  relations: ReadonlySet<string>;
  cascades: Cascade[];
  /** Le champ de statut et sa valeur d'annulation (`CANCELLED`, `ANNULE`…), quand l'énuméré en porte une. */
  annulation: { champ: string; valeur: string } | null;
}

const VALEURS_ANNULATION = /^(CANCELLED|CANCELED|ANNULE|ANNULEE|ANNULÉ|ANNULÉE|ABANDONNE|ABANDONED|RETIRE|WITHDRAWN)$/;
const CHAMPS_STATUT = /^(status|statut|etat|state)$/i;

let cache: Map<string, InfoModele> | null = null;

const delegueDe = (nom: string) => nom.charAt(0).toLowerCase() + nom.slice(1);

function construire(): Map<string, InfoModele> {
  const modeles = Prisma.dmmf.datamodel.models;
  const enums = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
  const out = new Map<string, InfoModele>();
  for (const m of modeles) {
    const champs = m.fields as readonly ChampDmmf[];
    const id = champs.find((f) => f.isId) ?? null;
    const scalaires = champs.filter((f) => (f.kind === "scalar" || f.kind === "enum") && f.type !== "Bytes").map((f) => f.name);
    const statut = champs.find((f) => f.kind === "enum" && CHAMPS_STATUT.test(f.name));
    const valeur = statut ? (enums.get(statut.type) ?? []).find((v) => VALEURS_ANNULATION.test(v)) : undefined;
    out.set(m.name, {
      nom: m.name, delegue: delegueDe(m.name), table: m.dbName ?? m.name,
      cle: id?.name ?? null,
      cleGeneree: !!id && id.type === "String" && /^(cuid|uuid)$/.test(String((id.default as { name?: string } | undefined)?.name ?? "")),
      cleColonne: id ? ((id as { dbName?: string | null }).dbName ?? id.name) : null,
      scalaires,
      types: new Map(champs.filter((f) => f.kind === "scalar" || f.kind === "enum").map((f) => [f.name, {
        type: f.type, liste: f.isList, enumere: f.kind === "enum", obligatoire: f.isRequired, defaut: f.hasDefaultValue,
      }])),
      octets: champs.filter((f) => f.kind === "scalar" && f.type === "Bytes").map((f) => f.name),
      relations: new Set(champs.filter((f) => f.kind === "object").map((f) => f.name)),
      auto: new Set(champs.filter((f) => f.isUpdatedAt).map((f) => f.name)),
      cascades: [], enfants: [],
      annulation: statut && valeur ? { champ: statut.name, valeur } : null,
    });
  }
  // LES ENFANTS EN CASCADE : le côté qui porte la clé étrangère dit `onDelete: Cascade`.
  for (const m of modeles) {
    for (const f of m.fields as readonly ChampDmmf[]) {
      if (f.kind !== "object" || !f.relationFromFields?.length) continue;
      const parent = out.get(f.type);
      if (!parent) continue;
      const lien = { modele: m.name, delegue: delegueDe(m.name), champ: f.relationFromFields[0] };
      parent.enfants.push(lien);
      if (f.relationOnDelete === "Cascade") parent.cascades.push(lien);
    }
  }
  return out;
}

export function infoModele(nom: string): InfoModele | null {
  cache ??= construire();
  return cache.get(nom) ?? null;
}

/**
 * LES MODÈLES DE TRACE — ils racontent le geste, ils n'en sont pas l'effet : la carte ne les montre pas, le journal ne
 * les garde pas, l'annulation n'y touche pas (on ne réécrit pas l'histoire : on écrit une ligne de plus).
 */
export const MODELES_TRACE: ReadonlySet<string> = new Set([
  "AuditLog", "ActivityLog", "AssistantIaTrace", "AiUsageLog", "ModelCallLog", "VoiceTurnLog", "AssistantActionIntent",
  "AssistantRoleConfigAudit", "RegulatoryAuditLog", "SessionEvent", "BusinessEvent", "MissionEvent",
  "AssistantGesteJournal", "AssistantEffet",
]);
