import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import { canAccessConversation } from "@/lib/messaging";
import { canViewMeeting } from "@/lib/meetings";
import { canReadFeedback } from "@/lib/feedback/access";
import { faitsKpi } from "@/lib/kpi/service";
import { peutVoirBilan } from "@/lib/kpi/droits";
import {
  peutOuvrirDocument, peutOuvrirDocumentRh, peutOuvrirPieceDeRapport, peutOuvrirPieceDeSujet,
} from "@/lib/entity-access/ouverture-pieces";
import { lireCle, type Famille } from "../domaine/familles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DROITS DANS L'INDEX — une clé d'accès s'ouvre-t-elle pour cette personne ? (J1)
 *
 * La règle de chaque famille est CELLE DE LA ROUTE QUI SERT LE FICHIER, appelée telle quelle — jamais
 * recopiée : `resolveDriveAccess` pour le Drive, `peutOuvrirDocument` pour `/api/documents/[id]`,
 * `canAccessConversation` pour la messagerie, etc. (`lib/entity-access/ouverture-pieces.ts` rassemble
 * celles qui vivaient dans leur route). Une personne ne voit dans la recherche QUE ce qu'elle pourrait
 * ouvrir ; un objet disparu (supprimé, à la corbeille) n'ouvre rien.
 *
 * Les clés se jugent PAR LOT et par famille (une requête par famille pour charger les lignes), puis la
 * règle s'applique ligne à ligne, en parallèle borné. Une famille inconnue n'ouvre rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Juge = (user: SessionUser, ids: string[]) => Promise<Set<string>>;

const PARALLELE = 8;

/** Applique une règle asynchrone à chaque identifiant, au plus `PARALLELE` à la fois. */
async function filtrer(ids: string[], regle: (id: string) => Promise<boolean>): Promise<Set<string>> {
  const ok = new Set<string>();
  let i = 0;
  const travailleur = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        if (await regle(id)) ok.add(id);
      } catch (err) {
        // Une règle qui lève n'ouvre rien : refuser est le seul repli sûr.
        console.error("[bibliotheque] règle d'accès en échec (refus)", err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLELE, ids.length) }, travailleur));
  return ok;
}

const JUGES: Record<Famille, Juge> = {
  async DRIVE_NODE(user, ids) {
    // La corbeille et les dossiers ne ressortent pas ; la règle est celle de `/api/drive/[id]/raw` (`resolveDriveAccess`).
    const vivants = await prisma.driveNode.findMany({ where: { id: { in: ids }, isTrashed: false, type: "FILE" }, select: { id: true, ownerId: true } });
    // Trois issues que `resolveDriveAccess` rend SANS dépendre du nœud, lues ici sans le parcourir : le Super Admin
    // (EDIT), la portée ALL du module Drive (VIEW sur tout nœud), le propriétaire du nœud (EDIT, au premier pas de
    // la remontée). Le reste — partages, espaces, ancêtres, messagerie — passe par la fonction elle-même.
    if (user.role === "SUPER_ADMIN" || user.access.modules.get("DRIVE")?.scope === "ALL") return new Set(vivants.map((n) => n.id));
    const ok = new Set(vivants.filter((n) => n.ownerId === user.id).map((n) => n.id));
    const reste = vivants.filter((n) => !ok.has(n.id)).map((n) => n.id);
    for (const id of await filtrer(reste, async (id) => canViewDrive(await resolveDriveAccess(user, id)))) ok.add(id);
    return ok;
  },
  async DOCUMENT(user, ids) {
    const docs = await prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, entityType: true, entityId: true, stepKey: true } });
    const parId = new Map(docs.map((d) => [d.id, d]));
    return filtrer([...parId.keys()], (id) => peutOuvrirDocument(user, parId.get(id)!));
  },
  async MESSAGE_PIECE(user, ids) {
    const pj = await prisma.messageAttachment.findMany({
      where: { id: { in: ids }, blobId: { not: null } },
      select: { id: true, message: { select: { conversationId: true, deletedAt: true } } },
    });
    const conversations = new Map<string, Promise<boolean>>();
    const membre = (c: string) => {
      if (!conversations.has(c)) conversations.set(c, canAccessConversation(user.id, c));
      return conversations.get(c)!;
    };
    const parId = new Map(pj.filter((a) => !a.message.deletedAt).map((a) => [a.id, a.message.conversationId]));
    return filtrer([...parId.keys()], (id) => membre(parId.get(id)!));
  },
  async SUJET_PIECE(user, ids) {
    const pj = await prisma.dossierMessageAttachment.findMany({
      where: { id: { in: ids } },
      select: { id: true, message: { select: { dossier: { select: { createdById: true, assignedToId: true, participantIds: true } } } } },
    });
    return new Set(pj.filter((a) => peutOuvrirPieceDeSujet(user, a.message.dossier)).map((a) => a.id));
  },
  async REUNION_PIECE(user, ids) {
    const pj = await prisma.meetingMessageAttachment.findMany({
      where: { id: { in: ids } },
      select: { id: true, message: { select: { meeting: { select: { organizerId: true, participants: { select: { userId: true } } } } } } },
    });
    return new Set(pj.filter((a) => canViewMeeting(user, a.message.meeting)).map((a) => a.id));
  },
  async REUNION_AUDIO(user, ids) {
    const m = await prisma.meeting.findMany({ where: { id: { in: ids } }, select: { id: true, organizerId: true, participants: { select: { userId: true } } } });
    return new Set(m.filter((x) => canViewMeeting(user, x)).map((x) => x.id));
  },
  async RH_DOCUMENT(user, ids) {
    const docs = await prisma.employeeDocument.findMany({
      where: { id: { in: ids } },
      select: { id: true, visibleToEmployee: true, employee: { select: { userId: true, companyId: true } } },
    });
    const parId = new Map(docs.map((d) => [d.id, d]));
    return filtrer([...parId.keys()], (id) => peutOuvrirDocumentRh(user, parId.get(id)!));
  },
  async TERRAIN_PIECE(user, ids) {
    const pj = await prisma.fieldReportAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, report: { select: { delegateId: true } } } });
    return new Set(pj.filter((a) => peutOuvrirPieceDeRapport(user, a.report)).map((a) => a.id));
  },
  async TERRAIN_AUDIO(user, ids) {
    const r = await prisma.fieldReport.findMany({ where: { id: { in: ids } }, select: { id: true, delegateId: true } });
    return new Set(r.filter((x) => peutOuvrirPieceDeRapport(user, x)).map((x) => x.id));
  },
  async RETOUR_PIECE(user, ids) {
    const pj = await prisma.feedbackAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, feedback: { select: { userId: true } } } });
    return new Set(pj.filter((a) => canReadFeedback(user, a.feedback)).map((a) => a.id));
  },
  async KPI_PIECE(user, ids) {
    const d = await prisma.kpiDeclaration.findMany({ where: { id: { in: ids }, pieceBlobId: { not: null } }, select: { id: true, userId: true } });
    if (!d.length) return new Set();
    const { faits } = await faitsKpi(user);
    return new Set(d.filter((x) => peutVoirBilan(faits, x.userId)).map((x) => x.id));
  },
};

/** Les clés, parmi celles données, que cette personne peut ouvrir (une clé d'une famille inconnue n'ouvre rien). */
export async function clesOuvrables(user: SessionUser, cles: readonly string[]): Promise<Set<string>> {
  const parFamille = new Map<Famille, Set<string>>();
  for (const cle of new Set(cles)) {
    const c = lireCle(cle);
    if (!c) continue;
    if (!parFamille.has(c.famille)) parFamille.set(c.famille, new Set());
    parFamille.get(c.famille)!.add(c.id);
  }
  const ouvrables = new Set<string>();
  await Promise.all([...parFamille].map(async ([famille, ids]) => {
    try {
      for (const id of await JUGES[famille](user, [...ids])) ouvrables.add(`${famille}:${id}`);
    } catch (err) {
      console.error(`[bibliotheque] droits de la famille ${famille} illisibles (refus)`, err);
    }
  }));
  return ouvrables;
}
