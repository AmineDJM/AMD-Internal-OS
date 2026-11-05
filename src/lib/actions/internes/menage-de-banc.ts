import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { deleteFileByKey } from "@/lib/storage";
import { releaseBlob } from "@/lib/drive-storage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÉNAGE DE BANC QUI RETIRE AUSSI LE CONTENU — tests seulement (F1, 03/11/2026).
 *
 * La base de tests grossissait sans fin (22 Go mesurés chez le parent, jusqu'au disque plein) : les bancs retiraient
 * leurs lignes `Document` et `DriveNode` par `deleteMany`, et le CONTENU restait. Un `deleteMany` ne passe par aucun des
 * chemins qui rendent le stockage :
 *
 *   • un `Document` tient son fichier par une clé de stockage (`StoredFile`), que seul `deleteFileByKey` retire ;
 *   • une version Drive (`FileVersion`) tient son blob par un compteur, que seul `releaseBlob` rend ;
 *   • l'un et l'autre ont inscrit une PIÈCE au registre (`Piece`, avec ses fiches et ses liens), qui tient le blob elle
 *     aussi, et que rien en production ne retire — le registre est dédoublonné par empreinte, une même pièce peut servir
 *     à plusieurs dossiers.
 *
 * Mesuré sur une base remise à zéro, UN passage complet laissait : 1 318 blobs, 380 clés de stockage, 1 041 pièces et
 * leurs 1 706 liens, 401 nœuds Drive, 163 documents. Ces deux portes remplacent le `deleteMany` des bancs : même
 * filtre, même compte rendu (`{ count }`), et le contenu part par les chemins de production. Une clé que garde encore
 * un autre document, un blob qu'une autre colonne tient, une pièce qu'une autre ligne désigne (toute colonne `pieceId`
 * du schéma) restent : seuls partent ceux que le banc était le dernier à tenir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Les modèles dont une colonne `pieceId` RETIENT une pièce — lus dans le schéma Prisma, pour qu'un modèle ajouté demain
 * soit compté sans y penser : tous, sauf ceux qui partent AVEC la pièce (`onDelete: Cascade` : ses fiches, ses liens,
 * ses extractions, les passages de ses fiches). Une colonne sans relation (`PaymentRequestEvent`, `AdProVoyageurDevis`…) retient.
 */
const MODELES_QUI_RETIENNENT: readonly string[] = Prisma.dmmf.datamodel.models
  .filter((m) => m.name !== "Piece" && m.fields.some((f) => f.name === "pieceId" && f.kind === "scalar"))
  // En cascade depuis la pièce, ou depuis ce qui part avec elle (`BibliothequePassage` suit sa fiche par `pieceId`).
  .filter((m) => !m.fields.some((f) => f.kind === "object" && f.relationFromFields?.includes("pieceId") && f.relationOnDelete === "Cascade"))
  .map((m) => m.name);

type DelegueAPiece = { findMany: (a: { where: { pieceId: { in: string[] } }; select: { pieceId: true } }) => Promise<{ pieceId: string | null }[]> };
const delegue = (modele: string): DelegueAPiece =>
  (prisma as unknown as Record<string, DelegueAPiece>)[modele.charAt(0).toLowerCase() + modele.slice(1)]!;

/** Les pièces du registre que plus rien ne désigne, retirées (fiches, liens et extractions en cascade) ; leurs blobs rendus. */
async function retirerPiecesSansAttache(pieceIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(pieceIds.filter((p): p is string => Boolean(p)))];
  if (ids.length === 0) return;
  const tenues = new Set<string>();
  for (const m of MODELES_QUI_RETIENNENT) {
    for (const r of await delegue(m).findMany({ where: { pieceId: { in: ids } }, select: { pieceId: true } })) if (r.pieceId) tenues.add(r.pieceId);
  }
  const libres = await prisma.piece.findMany({ where: { id: { in: ids.filter((id) => !tenues.has(id)) } }, select: { id: true, blobId: true } });
  if (libres.length === 0) return;
  await prisma.piece.deleteMany({ where: { id: { in: libres.map((p) => p.id) } } });
  for (const { blobId } of libres) if (blobId) await releaseBlob(blobId);
}

/** RETIRER DES DOCUMENTS (le `prisma.document.deleteMany` d'un banc) — et leur fichier, et leur pièce. */
export async function retirerDocumentsEtContenu(args: { where?: Prisma.DocumentWhereInput } = {}): Promise<{ count: number }> {
  const docs = await prisma.document.findMany({ where: args.where, select: { id: true, fileKey: true, pieceId: true } });
  if (docs.length === 0) return { count: 0 };
  const r = await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  const cles = [...new Set(docs.map((d) => d.fileKey).filter((k): k is string => Boolean(k)))];
  const encoreTenues = new Set((await prisma.document.findMany({ where: { fileKey: { in: cles } }, select: { fileKey: true } })).map((d) => d.fileKey));
  for (const cle of cles) if (!encoreTenues.has(cle)) await deleteFileByKey(cle).catch(sansBloquer("menage-de-banc.retirerDocumentsEtContenu.fichier"));
  // Une pièce inscrite depuis un document peut ne tenir à lui que par un LIEN (`inscrireDocumentExistant`) : le lien part
  // avec le document ; la pièce aussi, si plus aucun autre lien ni aucune colonne ne la désigne (mesuré : les CV de
  // `site-web/candidatures`, trois par passage).
  const auDocument = { sujetType: "ENTITE" as const, entityType: "DOCUMENT", sujetId: { in: docs.map((d) => d.id) } };
  const parLien = [...new Set((await prisma.pieceLien.findMany({ where: auDocument, select: { pieceId: true } })).map((l) => l.pieceId))];
  await prisma.pieceLien.deleteMany({ where: auDocument });
  const encoreLiees = new Set((await prisma.pieceLien.findMany({ where: { pieceId: { in: parLien } }, select: { pieceId: true } })).map((l) => l.pieceId));
  await retirerPiecesSansAttache([...docs.map((d) => d.pieceId), ...parLien.filter((id) => !encoreLiees.has(id))]);
  return r;
}

/**
 * RETIRER DES NŒUDS DRIVE (le `prisma.driveNode.deleteMany` d'un banc) — leur sous-arbre part en cascade, comme avant ;
 * les blobs de toutes leurs versions sont rendus, et leurs pièces retirées quand plus rien ne les désigne.
 */
export async function retirerNoeudsDriveEtContenu(args: { where?: Prisma.DriveNodeWhereInput } = {}): Promise<{ count: number }> {
  const racines = (await prisma.driveNode.findMany({ where: args.where, select: { id: true } })).map((n) => n.id);
  if (racines.length === 0) return { count: 0 };
  // Le sous-arbre, niveau par niveau (la cascade de `parentId` l'emportera avec ses racines).
  const arbre: { id: string; pieceId: string | null }[] = await prisma.driveNode.findMany({ where: { id: { in: racines } }, select: { id: true, pieceId: true } });
  for (let niveau = racines; niveau.length > 0;) {
    const enfants = await prisma.driveNode.findMany({ where: { parentId: { in: niveau } }, select: { id: true, pieceId: true } });
    arbre.push(...enfants);
    niveau = enfants.map((e) => e.id);
  }
  const versions = await prisma.fileVersion.findMany({ where: { nodeId: { in: arbre.map((n) => n.id) } }, select: { blobId: true } });
  const r = await prisma.driveNode.deleteMany({ where: { id: { in: racines } } });
  for (const { blobId } of versions) await releaseBlob(blobId);
  await retirerPiecesSansAttache(arbre.map((n) => n.pieceId));
  return r;
}

/**
 * LES PIÈCES DE COMPTES DISPARUS QUE PLUS RIEN NE DÉSIGNE — retirées au ménage de fin de suite (`vitest.global-setup.ts`).
 *
 * Le registre des pièces survit PAR CONCEPTION aux documents qui l'ont nourri (il est dédoublonné par empreinte) : un
 * banc qui retire ses documents, par quelque chemin que ce soit, laisse leurs pièces. Mesuré sur une base remise à zéro
 * (03/11) : un passage complet laissait ~1 000 pièces, chacune avec sa fiche et ses liens, réparties sur 95 fichiers de
 * test ; et TOUTES les pièces de la base (3 135) avaient un déposant qui n'existe plus et aucun document ni nœud qui les
 * désigne. Une telle pièce est injoignable : retirée, avec ses fiches, ses liens et ses extractions, son blob rendu.
 * Jamais une pièce dont le déposant existe (le monde du banc d'audit), ni une pièce sans déposant (dépôt système), ni
 * une pièce qu'une ligne désigne encore (toute colonne `pieceId` du schéma).
 */
export async function retirerPiecesDeComptesDisparus(): Promise<number> {
  const deposants = [...new Set((await prisma.piece.findMany({ where: { deposeeParId: { not: null } }, select: { deposeeParId: true } }))
    .map((p) => p.deposeeParId!))];
  const vivants = new Set((await prisma.user.findMany({ where: { id: { in: deposants } }, select: { id: true } })).map((u) => u.id));
  const disparus = deposants.filter((d) => !vivants.has(d));
  if (disparus.length === 0) return 0;
  const candidates = (await prisma.piece.findMany({ where: { deposeeParId: { in: disparus } }, select: { id: true } })).map((p) => p.id);
  const avant = await prisma.piece.count({ where: { id: { in: candidates } } });
  for (let i = 0; i < candidates.length; i += 500) await retirerPiecesSansAttache(candidates.slice(i, i + 500));
  return avant - (await prisma.piece.count({ where: { id: { in: candidates } } }));
}

// ── CE QUE LES COMPTES D'UN BANC ONT SEMÉ ─────────────────────────────────────────────────────

/**
 * CE QUE DES COMPTES DE BANC ONT SEMÉ, retiré avec eux : les documents qu'ils ont déposés (`uploadedById`), leurs nœuds
 * Drive (`createdById`, `ownerId`) — avec le contenu, par les deux portes ci-dessus.
 *
 * MESURÉ (03/11, attribution par fichier de test) : les nœuds Drive qu'un passage complet laissait étaient TOUS des
 * sous-arbres d'un seul auteur — « Mes … importés », « Dossier traité », « Terrain — vocaux et photos »… —, rangés par les
 * flux de production au nom du compte qui agit. Le banc retirait son compte ; le nœud, lui, restait (`ownerId` passe à
 * `null`, `createdById` n'est pas une clé étrangère), avec ses versions, ses blobs et ses pièces. Retirer le compte par
 * cette porte retire ce qui lui pend.
 *
 * Un nœud du banc qui contient le nœud d'un AUTRE auteur reste, avec ses ancêtres : jamais le rangement d'un voisin ne part
 * avec un dossier qu'un compte du banc a ouvert.
 */
async function retirerSemisDeComptes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await retirerDocumentsEtContenu({ where: { uploadedById: { in: ids } } });
  const semes = await prisma.driveNode.findMany({ where: { OR: [{ createdById: { in: ids } }, { ownerId: { in: ids } }] }, select: { id: true, parentId: true } });
  if (semes.length === 0) return;
  const parent = new Map(semes.map((n) => [n.id, n.parentId]));
  const gardes = new Set<string>();
  const etrangers = await prisma.driveNode.findMany({ where: { parentId: { in: [...parent.keys()] }, id: { notIn: [...parent.keys()] } }, select: { parentId: true } });
  for (const e of etrangers) for (let p = e.parentId; p && parent.has(p) && !gardes.has(p); p = parent.get(p) ?? null) gardes.add(p);
  const partants = new Set([...parent.keys()].filter((id) => !gardes.has(id)));
  const racines = [...partants].filter((id) => { const p = parent.get(id); return !p || !partants.has(p); });
  if (racines.length > 0) await retirerNoeudsDriveEtContenu({ where: { id: { in: racines } } });
}

/**
 * RETIRER DES COMPTES DE BANC (le `prisma.user.deleteMany` d'un banc) — et ce qu'ils ont semé : documents, nœuds Drive et
 * leur contenu, gestes au journal et envois différés à leur nom. Même filtre, même compte rendu (`{ count }`).
 */
export async function retirerComptesEtSemis(args: { where?: Prisma.UserWhereInput } = {}): Promise<{ count: number }> {
  const ids = (await prisma.user.findMany({ where: args.where, select: { id: true } })).map((u) => u.id);
  if (ids.length === 0) return { count: 0 };
  await retirerSemisDeComptes(ids);
  await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } });
  await prisma.effetSortantDiffere.deleteMany({ where: { principalId: { in: ids } } });
  await retirerCeQuIlsOntDepose(ids);
  try {
    return await prisma.user.deleteMany({ where: { id: { in: ids } } });
  } catch (e) {
    if (!estCleEtrangere(e)) throw e;
  }
  // UN COMPTE RETENU PAR LA LIGNE D'UN VOISIN : retiré un à un, et celui qui reste est DIFFÉRÉ (voir plus bas).
  let count = 0;
  for (const id of ids) {
    try {
      await prisma.user.delete({ where: { id } });
      count++;
    } catch (e) {
      if (!estCleEtrangere(e)) throw e;
      await differerLeRetrait(id);
    }
  }
  return { count };
}

/**
 * CE QUE LES COMPTES DU BANC ONT EUX-MÊMES DÉPOSÉ et qui les RETIENT (`onDelete: Restrict` vers leur compte) : leurs
 * demandes de validation (`requesterId` — étapes et participants partent en cascade), leurs retours (`Feedback`, ses
 * pièces jointes), les compléments qu'ils ont demandés sur un recrutement. MESURÉ (03/11) : `signature-renvoi-flow`
 * échouait à retirer ses comptes (« ValidationRequest_requesterId_fkey ») — ses demandes, nées des circuits qu'il joue,
 * n'étaient pas toutes liées à ses documents. Rien de ce qu'un AUTRE a déposé ne part ici (un valideur désigné par un
 * voisin : retrait différé, ci-dessous).
 */
async function retirerCeQuIlsOntDepose(ids: string[]): Promise<void> {
  await prisma.validationRequest.deleteMany({ where: { requesterId: { in: ids } } });
  await prisma.feedbackAttachment.deleteMany({ where: { uploadedById: { in: ids } } });
  await prisma.feedback.deleteMany({ where: { userId: { in: ids } } });
  await prisma.recruitmentInfoRequest.deleteMany({ where: { askedById: { in: ids } } });
  // 04/11 : la pièce déposée sur une demande de paiement s'inscrit au registre Legal au nom du déposant. Le compte retiré,
  // le document restait (`createdById` passe à null) — mesuré : ~200 « Facture — piece-0 — SARL Atlas » sans montant en
  // une soirée, qui poussaient la facture plantée du banc de qualité au-delà de sa limite de lecture (200).
  await prisma.legalDocument.deleteMany({ where: { createdById: { in: ids } } });
}

const estCleEtrangere = (e: unknown) => (e as { code?: string } | null)?.code === "P2003";

/**
 * LE RETRAIT DIFFÉRÉ D'UN COMPTE DE BANC — la marque que pose le banc lui-même, et que le ménage de fin de suite lit.
 *
 * MESURÉ (03/11, sous `npm test`) : un compte SUPER_ADMIN de banc, actif, est désigné VALIDEUR par les circuits des bancs
 * voisins (les étapes se résolvent par rôle) ; leur `ValidationStep` le retient (`onDelete: Restrict`) tant qu'ils ne
 * l'ont pas retirée. Son retrait échouait en silence — et le compte, resté actif, recevait les notifications de rôle de
 * toute la suite (967 en un passage ; le cliquet du résidu a refusé « Notification +610 »). Le banc ne peut pas retirer
 * la ligne d'un voisin : il DÉSACTIVE son compte (plus aucune désignation ni notification de rôle), retire ses
 * notifications, et le marque ; `retirerComptesDifferes` le retire après la suite, quand plus aucun banc ne tourne.
 */
export const MARQUE_RETRAIT_DIFFERE = "[retrait différé de banc] ";

async function differerLeRetrait(id: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true } });
  if (!u) return;
  await prisma.user.update({
    where: { id },
    data: { isActive: false, name: u.name.startsWith(MARQUE_RETRAIT_DIFFERE) ? u.name : `${MARQUE_RETRAIT_DIFFERE}${u.name}`.slice(0, 190) },
  });
  await prisma.notification.deleteMany({ where: { userId: id } });
}

/** Le ménage de fin de suite (`vitest.global-setup.ts`) : les comptes dont un banc a différé le retrait. Rend le nombre retiré. */
export async function retirerComptesDifferes(): Promise<number> {
  return (await retirerComptesEtSemis({ where: { name: { startsWith: MARQUE_RETRAIT_DIFFERE }, isActive: false } })).count;
}
