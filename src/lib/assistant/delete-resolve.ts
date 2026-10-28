import { prisma } from "@/lib/prisma";
import {
  DELETE_REGISTRY,
  deleteDelegateOf,
  type DeletableKind,
} from "@/lib/admin-delete-registry";
import { sansBloquer } from "@/lib/journal";

/**
 * RÉSOLUTION d'une cible de suppression pour le Chief of Staff — le pouvoir EN PLUS de l'écran.
 *
 * L'écran connaît déjà l'id (le bouton rouge vit sur la fiche) ; le Chief, lui, reçoit une
 * RÉFÉRENCE HUMAINE (« REG-2026-041 », un nom d'événement, un titre) et doit la résoudre sans
 * jamais choisir en silence :
 *   • un seul candidat → résolu ;
 *   • plusieurs candidats mais UNE correspondance exacte (le nom affiché commence par la
 *     référence donnée) → résolu ;
 *   • plusieurs candidats sans exactitude → AMBIGU, les candidats sont listés (même philosophie
 *     que `resolveOrg` : jamais de fusion muette) ;
 *   • rien → introuvable.
 *
 * La recherche s'appuie sur les `searchFields` déclarés PAR LE REGISTRE PARTAGÉ (une seule
 * source de vérité) ; un id interne copié d'un lien (/regulatory/<id>) résout toujours, ce qui
 * couvre aussi les types sans référence humaine (ex. demande RH).
 */
export type DeleteTargetResolution =
  | { status: "resolved"; id: string; name: string }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
  | { status: "none" };

export async function resolveDeletableTarget(kind: DeletableKind, rawQuery: string): Promise<DeleteTargetResolution> {
  const spec = DELETE_REGISTRY[kind];
  const query = rawQuery.trim();
  if (!query) return { status: "none" };

  // 1) Un id interne exact (copié d'un lien) résout toujours — y compris les types sans
  //    champs de recherche. `describe` rend null si l'id n'existe pas : aucun coût d'erreur.
  const direct = await spec.describe(query).catch(sansBloquer("delete-resolve.resolveDeletableTarget.describe", null));
  if (direct) return { status: "resolved", id: query, name: direct };

  // 2) Référence humaine sur les champs déclarés par le registre.
  if (!spec.searchFields?.length) return { status: "none" };
  const rows = await deleteDelegateOf(spec).findMany({
    where: { OR: spec.searchFields.map((f) => ({ [f]: { contains: query, mode: "insensitive" } })) },
    select: { id: true },
    take: 8,
  });
  const candidates: { id: string; name: string }[] = [];
  for (const row of rows) {
    const name = await spec.describe(row.id);
    if (name) candidates.push({ id: row.id, name });
  }
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length === 1) return { status: "resolved", ...candidates[0] };

  // Plusieurs candidats : seule une correspondance EXACTE (nom entier, ou référence en tête
  // du nom affiché « REF — libellé ») tranche — sinon on liste, on ne devine pas.
  const q = query.toLowerCase();
  const exact = candidates.filter((c) => {
    const n = c.name.toLowerCase();
    return n === q || n.startsWith(`${q} — `);
  });
  if (exact.length === 1) return { status: "resolved", ...exact[0] };
  return { status: "ambiguous", candidates };
}

/** Une entrée de la corbeille, résolue pour restauration ou destruction. */
export type TrashResolution =
  | { status: "resolved"; recordId: string; name: string; label: string; kind: string; restored: boolean }
  | { status: "ambiguous"; candidates: { name: string; label: string }[] }
  | { status: "none" };

/**
 * Résout une entrée de la CORBEILLE (DeletedRecord) par le nom affiché dans l'écran
 * Administration → Corbeille — même politique que ci-dessus : exact/unique/ambigu, jamais un
 * choix silencieux. `forRestore` écarte les entrées déjà restaurées (on ne restaure pas deux
 * fois) ; la destruction, elle, reste possible sur une entrée restaurée (elle n'efface alors
 * que l'historique, les fichiers ayant repris du service).
 */
export async function resolveTrashEntry(
  rawQuery: string,
  kind: DeletableKind | null,
  opts: { forRestore: boolean },
): Promise<TrashResolution> {
  const query = rawQuery.trim();
  if (!query) return { status: "none" };

  const baseWhere = {
    purgedAt: null,
    ...(opts.forRestore ? { restoredAt: null } : {}),
    ...(kind ? { kind } : {}),
  };

  // 1) Id exact d'une entrée de corbeille (copié d'un lien ou d'une réponse précédente).
  const direct = await prisma.deletedRecord.findFirst({ where: { id: query, ...baseWhere } });
  if (direct) {
    return { status: "resolved", recordId: direct.id, name: direct.name, label: direct.label, kind: direct.kind, restored: Boolean(direct.restoredAt) };
  }

  // 2) Nom affiché dans la corbeille (le `describe` du moment de la suppression).
  const rows = await prisma.deletedRecord.findMany({
    where: { ...baseWhere, name: { contains: query, mode: "insensitive" } },
    orderBy: { deletedAt: "desc" },
    take: 8,
  });
  if (rows.length === 0) return { status: "none" };
  const toResolved = (r: (typeof rows)[number]): TrashResolution => (
    { status: "resolved", recordId: r.id, name: r.name, label: r.label, kind: r.kind, restored: Boolean(r.restoredAt) }
  );
  if (rows.length === 1) return toResolved(rows[0]);
  const q = query.toLowerCase();
  const exact = rows.filter((r) => {
    const n = r.name.toLowerCase();
    return n === q || n.startsWith(`${q} — `);
  });
  if (exact.length === 1) return toResolved(exact[0]);
  return { status: "ambiguous", candidates: rows.map((r) => ({ name: r.name, label: r.label })) };
}
