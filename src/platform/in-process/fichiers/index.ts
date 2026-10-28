/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DRIVE, côté plateforme (mandat 5 §41) — la porte par laquelle Adam RANGE.
 *
 * `lib/fichiers/` et `lib/formats/` sont PURS : ils raisonnent sur des descriptions de fichiers
 * et des octets, jamais sur le Drive. C'est ici, et seulement ici, que le droit se vérifie —
 * `canViewDrive` pour recenser, `canEditDrive` pour bouger, NŒUD PAR NŒUD, la même règle que
 * l'écran et que le Live Office.
 *
 * Et une règle qui n'est pas négociable : ce pont ne SUPPRIME rien. Il déplace, il renomme, il
 * classe, il archive — tous gestes que le plan de retour défait. Une suppression passe par
 * l'écran, avec la corbeille et la personne qui la décide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { convertConfigured } from "@/lib/office-convert";
import type { CapacitesServeur } from "@/lib/formats/conversion";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { canEditDrive, canViewDrive, driveBreadcrumb, resolveDriveAccess } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import type { SessionUser } from "@/lib/rbac";
import { type Fichier } from "@/lib/fichiers/doublons";
import { type Geste, type Reçu } from "@/lib/fichiers/lot";
import { detecterEncodage } from "@/lib/formats/detection";
import { sansBloquer } from "@/lib/journal";

export { type Fichier, type GroupeDoublons, type RapportDoublons, distanceNoms, orphelins, radical, radicalSansVersion, trouverDoublons } from "@/lib/fichiers/doublons";
export { type Apercu, type Geste, type GesteType, type RapportLot, type Reçu, CONFIANCE_AUTOMATIQUE, GESTES_MAX, estPassager, estReversible, executerLot, inverser, preparerLot } from "@/lib/fichiers/lot";
export { type Categorie, type Proposition, extraireEntites, gestesDeClassement, proposerClassement } from "@/lib/fichiers/classement";
export { type Encodage, type Separateur, decouperLigne, detecterEncodage, detecterEntete, detecterLocale, detecterSeparateur, nomSeparateur, versDateIso, versNombre } from "@/lib/formats/detection";
export { type Colonne, type RapportLecture, type Tableur, ecrireCsv, ecrireJsonl, lireJson, lireTableur } from "@/lib/formats/tableur";
export { type CapacitesServeur, type Conversion, type Format, type Nature, avertissementConversion, conversion, conversionsDepuis, formatDe, FORMATS_ECRIVABLES, FORMATS_LISIBLES } from "@/lib/formats/conversion";

export const RECENSEMENT_MAX = 12_000;
/** Le contenu lu pour classer : assez pour reconnaître, pas assez pour peser. */
export const OCTETS_APERCU = 8_000;

export interface Recensement {
  fichiers: Fichier[];
  /** Ce que la personne ne voit pas — compté, jamais silencieux. */
  horsPerimetre: number;
  dossiers: number;
  octets: number;
  tronque: boolean;
}

/** Le chemin lisible d'un nœud (« Contrats / 2026 / Sofradis »), mis en cache par dossier. */
async function cheminsDe(parentIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  for (const id of new Set(parentIds.filter((x): x is string => Boolean(x)))) {
    const fil = await driveBreadcrumb(id).catch(sansBloquer("in-process-fichiers.cheminsDe.driveBreadcrumb", []));
    cache.set(id, fil.map((f) => f.name).join(" / ") || "(racine)");
  }
  return cache;
}

/**
 * RECENSE LES FICHIERS que la personne a le droit de VOIR — nœud par nœud.
 * Le nombre de fichiers écartés faute de droit est rendu : « je n'ai rien trouvé » et « je n'ai
 * pas eu le droit de regarder » ne sont pas la même réponse.
 */
export async function recenser(user: SessionUser, options: { dossier?: string | null; limite?: number; extensions?: readonly string[] } = {}): Promise<Recensement | { erreur: string }> {
  const take = Math.max(10, Math.min(options.limite ?? 3_000, RECENSEMENT_MAX));
  const where: Record<string, unknown> = { isTrashed: false, type: "FILE" };
  if (options.dossier) {
    const acces = await resolveDriveAccess(user, options.dossier);
    if (!canViewDrive(acces)) return { erreur: "Ce dossier ne vous est pas ouvert dans le Drive." };
    where.parentId = options.dossier;
  }
  const noeuds = await prisma.driveNode.findMany({
    where, take: take + 1, orderBy: { updatedAt: "desc" },
    select: {
      id: true, name: true, size: true, mimeType: true, parentId: true, ownerId: true, updatedAt: true, createdAt: true, category: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { blob: { select: { sha256: true } } } },
      _count: { select: { legalDocs: true, mailPieces: true, messageRefs: true, mailEntries: true } },
    },
  });
  const tronque = noeuds.length > take;
  const candidats = noeuds.slice(0, take);
  const extensions = options.extensions?.length ? new Set(options.extensions.map((e) => e.toLowerCase().replace(/^\./, ""))) : null;

  // LE DROIT — nœud par nœud, sauf quand le RÉSULTAT est connu d'avance.
  //
  // `resolveDriveAccess` commence par établir un socle : le Super Admin obtient EDIT, et le
  // module Drive au périmètre ALL donne VIEW sur tout. Quand ce socle suffit déjà à VOIR, marcher
  // l'arbre de chaque fichier ne peut plus changer la réponse — et cette marche coûte une requête
  // par ancêtre, soit des dizaines de milliers de requêtes sur douze mille fichiers.
  //
  // On ne saute donc pas le contrôle : on reconnaît le cas où il est déjà tranché. Pour tous les
  // autres profils, chaque nœud est vérifié, un par un, sans exception.
  const socleOuvert = user.role === "SUPER_ADMIN" || user.access.modules.get("DRIVE")?.scope === "ALL";
  const autorises: typeof candidats = [];
  let horsPerimetre = 0;
  for (const n of candidats) {
    if (extensions) {
      const ext = n.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
      if (!extensions.has(ext)) continue;
    }
    if (socleOuvert || canViewDrive(await resolveDriveAccess(user, n.id))) autorises.push(n);
    else horsPerimetre += 1;
  }
  const chemins = await cheminsDe(autorises.map((n) => n.parentId));
  const fichiers: Fichier[] = autorises.map((n) => ({
    id: n.id, nom: n.name, taille: n.size,
    chemin: n.parentId ? (chemins.get(n.parentId) ?? "(dossier)") : "(racine)",
    empreinte: n.versions[0]?.blob?.sha256 ?? null,
    modifieLe: n.updatedAt, creeLe: n.createdAt, mimeType: n.mimeType,
    references: n._count.legalDocs + n._count.mailPieces + n._count.messageRefs + n._count.mailEntries,
    proprietaire: n.ownerId,
  }));
  const dossiers = new Set(fichiers.map((f) => f.chemin)).size;
  return { fichiers, horsPerimetre, dossiers, octets: fichiers.reduce((s, f) => s + f.taille, 0), tronque };
}

/** Le DÉBUT du contenu d'un fichier texte, pour le classer par ce qu'il DIT. Rien pour un binaire. */
export async function apercuTexte(user: SessionUser, nodeId: string): Promise<string> {
  if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return "";
  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, mimeType: true } });
  if (!node) return "";
  const ext = node.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (!["txt", "csv", "tsv", "md", "json", "xml", "html", "log"].includes(ext)) return "";
  const version = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!version) return "";
  const octets = await getBlob(version.blobId).catch(sansBloquer("in-process-fichiers.apercuTexte.getBlob", null));
  if (!octets) return "";
  return detecterEncodage(octets.subarray(0, OCTETS_APERCU)).texte;
}

/**
 * APPLIQUE UN GESTE — sous `canEditDrive`, avec l'audit, et JAMAIS de suppression.
 * Le geste est idempotent : appliqué deux fois, il laisse le même état.
 */
export async function appliquerGeste(user: SessionUser, g: Geste): Promise<{ ok: true; detail?: string } | { ok: false; erreur: string }> {
  if (g.type === "supprimer") return { ok: false, erreur: "refus : ce pont ne supprime aucun fichier. Une suppression passe par l'écran du Drive, avec sa corbeille." };
  const acces = await resolveDriveAccess(user, g.cible).catch(sansBloquer("in-process-fichiers.appliquerGeste.resolveDriveAccess", "NONE" as const));
  if (!canEditDrive(acces)) return { ok: false, erreur: "droit d'écriture refusé sur ce fichier" };
  const node = await prisma.driveNode.findUnique({ where: { id: g.cible }, select: { id: true, name: true, parentId: true, category: true, isTrashed: true } });
  if (!node) return { ok: false, erreur: "fichier introuvable" };
  if (node.isTrashed) return { ok: false, erreur: "fichier à la corbeille : le sortir d'abord" };

  const data: Record<string, unknown> = {};
  if (g.type === "renommer" && typeof g.apres.nom === "string") data.name = g.apres.nom;
  if ((g.type === "deplacer" || g.type === "classer") && typeof g.apres.parentId === "string") data.parentId = g.apres.parentId;
  if ((g.type === "classer" || g.type === "archiver") && typeof g.apres.categorie === "string") data.category = g.apres.categorie;
  if (!Object.keys(data).length) return { ok: false, erreur: `geste « ${g.type} » sans changement applicable (attendu : nom, parentId ou categorie)` };

  // Le dossier d'arrivée doit être ouvert en écriture, lui aussi — sinon on rangerait chez autrui.
  if (typeof data.parentId === "string") {
    if (!canEditDrive(await resolveDriveAccess(user, data.parentId).catch(sansBloquer("in-process-fichiers.appliquerGeste.resolveDriveAccess", "NONE" as const)))) {
      return { ok: false, erreur: "le dossier de destination ne vous est pas ouvert en écriture" };
    }
  }
  // IDEMPOTENT : si l'état demandé est déjà là, c'est un succès, pas une erreur.
  const dejaLa = Object.entries(data).every(([k, v]) => (node as unknown as Record<string, unknown>)[k] === v);
  if (dejaLa) return { ok: true, detail: "déjà dans l'état demandé" };

  await prisma.driveNode.update({ where: { id: g.cible }, data });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "DRIVE",
    summary: `Lot fichiers · ${g.type} · « ${node.name} » → ${JSON.stringify(data)} · ${g.raison.slice(0, 120)}`,
  }).catch(sansBloquer("in-process-fichiers.appliquerGeste.recordAudit"));
  return { ok: true, detail: `${g.type} appliqué` };
}

/** Un geste est-il DÉJÀ fait ? C'est la reprise : refaire un lot ne refait pas ce qui porte son reçu. */
export async function gesteDejaFait(g: Geste): Promise<boolean> {
  const node = await prisma.driveNode.findUnique({ where: { id: g.cible }, select: { name: true, parentId: true, category: true } });
  if (!node) return false;
  const attendu: Record<string, unknown> = {};
  if (typeof g.apres.nom === "string") attendu.name = g.apres.nom;
  if (typeof g.apres.parentId === "string") attendu.parentId = g.apres.parentId;
  if (typeof g.apres.categorie === "string") attendu.category = g.apres.categorie;
  if (!Object.keys(attendu).length) return false;
  return Object.entries(attendu).every(([k, v]) => (node as unknown as Record<string, unknown>)[k] === v);
}

/** Le dossier de destination, créé s'il n'existe pas — un classement sans dossier n'a nulle part où aller. */
export async function dossierPour(user: SessionUser, chemin: string, racine: string | null = null): Promise<{ id: string } | { erreur: string }> {
  const parts = chemin.split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { erreur: "chemin de destination vide" };
  let parentId = racine;
  for (const part of parts) {
    const existant = await prisma.driveNode.findFirst({
      where: { name: part, type: "FOLDER", parentId, isTrashed: false },
      select: { id: true },
    });
    if (existant) { parentId = existant.id; continue; }
    if (parentId && !canEditDrive(await resolveDriveAccess(user, parentId).catch(sansBloquer("in-process-fichiers.dossierPour.resolveDriveAccess", "NONE" as const)))) {
      return { erreur: `le dossier « ${part} » n'existe pas et son parent ne vous est pas ouvert en écriture` };
    }
    const cree = await prisma.driveNode.create({
      data: { name: part, type: "FOLDER", parentId, ownerId: user.id, createdById: user.id },
      select: { id: true },
    });
    parentId = cree.id;
  }
  return parentId ? { id: parentId } : { erreur: "destination introuvable" };
}

export type { Reçu as ReçuLot };

/**
 * L'ÉTAT ACTUEL de plusieurs fichiers — la base du plan de retour.
 * Il est lu EN BASE, jamais reçu du modèle : un « avant » inventé produirait un « annuler » qui
 * range le fichier ailleurs qu'à sa place.
 */
export async function etatsActuels(ids: readonly string[]): Promise<{ id: string; name: string; parentId: string | null; category: string | null }[]> {
  if (!ids.length) return [];
  return prisma.driveNode.findMany({
    where: { id: { in: [...new Set(ids)].slice(0, GESTES_LECTURE_MAX) } },
    select: { id: true, name: true, parentId: true, category: true },
  });
}

/** Le plafond de lecture d'états — un lot plus large se découpe. */
export const GESTES_LECTURE_MAX = 20_000;

/**
 * CE QUE CE SERVEUR SAIT FAIRE EN PLUS DES MOTEURS LOCAUX — lu à l'exécution.
 *
 * `lib/formats/conversion.ts` est PUR : il ne peut pas regarder la configuration, donc il REÇOIT
 * le fait. C'est ici qu'il se lit, parce que c'est ici que la frontière autorise à consulter la
 * configuration du serveur. Sans ce passage, le module gardait son refus « docx→pdf impossible
 * (LibreOffice absent) » pendant que le Drive convertissait par l'éditeur Office — deux vérités
 * sur une question, et Adam lisait la pessimiste (§118.121).
 */
export function capacitesServeur(): CapacitesServeur {
  return { editeurOffice: convertConfigured() };
}
