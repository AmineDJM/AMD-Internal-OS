import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { EVENT_SOURCES } from "@/lib/medical-info/circuits";
import { circuitStateOf, authoritiesOpen } from "@/lib/medical-info/circuit-state";
import { declareStage } from "@/lib/medical-info/declare-decision";
import { chezDecideur } from "@/lib/medical-info/decideur";
import { libellePastille, parcoursOf } from "@/lib/medical-info/parcours";
import { canViewDeclaration } from "@/lib/queries/medical-info";
import { refusDepotAutorites } from "@/lib/actions/internes/medical-info/dossier";
import { tientLaDeclarationAdPro } from "@/lib/actions/internes/medical-info/ouverture-ad-pro";
import { TITRE_ETAPE_DECLARATION, type EtapeDeclaration, type PieceDeDeclaration } from "./etape-ad-pro-partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DERNIÈRE ÉTAPE DU CIRCUIT AD & PRO — « Déclaration (information scientifique) » (Direction, 08/11/2026).
 *
 * « Après l'étape de la pré-validation, il faut ajouter une dernière étape de circuit : la déclaration des événements
 * scientifiques, en donnant la main au responsable de l'information médicale pour uploader les déclarations. »
 *
 * L'étape ne double rien : elle LIT le dossier d'information médicale (`DIM-…`) qui naît à la pré-validation — sa
 * lecture « à déclarer / sans déclaration », la décision du Directeur des Opérations, la référence du ministère, la
 * validation — et le montre sur la fiche de la demande, où personne ne le voyait. Le pharmacien y agit (déposer les
 * déclarations, enregistrer la référence) ; le reste de son instruction reste dans Information médicale, inchangé.
 *
 * ELLE NE BLOQUE RIEN : postes, paiements et validation finale n'attendent pas le ministère.
 *
 * Seuls les ÉVÉNEMENTS se déclarent ainsi (sponsoring, prises en charge nationales et internationales, événements) :
 * le matériel promotionnel a son propre circuit, avec ses bons de versement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { TITRE_ETAPE_DECLARATION, type EtapeDeclaration, type PieceDeDeclaration } from "./etape-ad-pro-partage";

export function seDeclareEnInformationScientifique(type: EntityType | string): boolean {
  return EVENT_SOURCES.includes(type);
}

/**
 * L'ÉTAPE, pour la fiche d'une demande Ad & Pro. `circuitConclu` : la pré-validation (ou l'ancien accord) a conclu le
 * circuit — c'est là que la déclaration naît. `null` pour ce qui ne se déclare pas ici (matériel promotionnel, « autres »).
 */
export async function etapeDeclaration(
  user: SessionUser, sourceType: EntityType, sourceId: string, circuitConclu: boolean,
): Promise<EtapeDeclaration | null> {
  if (!seDeclareEnInformationScientifique(sourceType)) return null;
  const tient = tientLaDeclarationAdPro(user);
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } },
    include: {
      pharmacist: { select: { name: true } },
      requests: { include: { targetUser: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
      slips: { select: { requestId: true } },
    },
  });

  const base = { titre: TITRE_ETAPE_DECLARATION, depot: { ouvert: false, motif: null }, pieces: [] as PieceDeDeclaration[] };
  if (!decl) {
    return {
      ...base,
      etat: circuitConclu ? "current" : "todo",
      detail: circuitConclu ? "à ouvrir" : "après la pré-validation",
      phrase: circuitConclu
        ? "Déclaration pas encore ouverte — chez le pharmacien responsable de l'information médicale"
        : "Après la pré-validation, le pharmacien déclare l'événement au ministère.",
      ton: circuitConclu ? "attente" : "neutre",
      declaration: null, lienDossier: null, peutAgir: false, peutOuvrir: tient && circuitConclu,
    };
  }

  const etat = await circuitStateOf(decl);
  const valide = decl.status === "VALIDATED";
  const sansDeclaration = declareStage(etat.declare) === "ACCORDEE" && etat.declare.intent === "SKIP";
  const ref = decl.authorityRef?.trim() || null;
  const motifSans = decl.declareNote?.trim() ? ` (motif : ${decl.declareNote.trim()})` : "";

  let phrase: string;
  let detail: string | null;
  let ton: EtapeDeclaration["ton"];
  if (valide) {
    phrase = sansDeclaration ? `Validée — sans déclaration${motifSans}` : `Validée — déclarée au ministère${ref ? ` (réf. ${ref})` : ""}`;
    detail = sansDeclaration ? "sans déclaration" : ref ? `réf. ${ref}` : "validée";
    ton = "succes";
  } else if (sansDeclaration) {
    phrase = `Sans déclaration${motifSans} — validation finale à venir`;
    detail = "sans déclaration";
    ton = "info";
  } else if (ref) {
    phrase = `Déclarée au ministère (réf. ${ref}) — validation à venir`;
    detail = `réf. ${ref}`;
    ton = "info";
  } else {
    const decideurs = await decideursInfoMedActifs(decl.pharmacistValidatedById ?? decl.pharmacistId);
    const parcours = parcoursOf({
      circuit: etat.circuit, status: decl.status, createdAt: decl.createdAt, updatedAt: decl.updatedAt,
      declare: etat.declare, declareRequestedAt: decl.declareRequestedAt, authorityRef: decl.authorityRef,
      lot: etat.lot, slips: etat.slips, summary: etat.summary, skipped: etat.skipped, bvRequestedAt: decl.bvRequestedAt,
      requests: decl.requests.map((r) => ({
        id: r.id, status: r.status, createdAt: r.createdAt, fulfilledAt: r.fulfilledAt,
        targetUserId: r.targetUserId, targetName: r.targetUser?.name ?? null,
      })),
      pharmacistValidatedAt: decl.pharmacistValidatedAt, validatedAt: decl.validatedAt, pharmacistName: decl.pharmacist?.name ?? null,
      chezDecideur: chezDecideur(decideurs),
    });
    phrase = libellePastille(parcours);
    detail = parcours.chez ? `chez ${parcours.chez}` : null;
    ton = "attente";
  }

  const voitLeDossier = tient || canViewDeclaration(user, decl);
  const pieces = voitLeDossier
    ? (await prisma.document.findMany({
        where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id },
        include: { uploadedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 30,
      })).map((d) => ({ id: d.id, nom: d.name, le: d.createdAt.toISOString(), par: d.uploadedBy?.name ?? null }))
    : [];
  const depotOuvert = authoritiesOpen(etat);
  return {
    ...base,
    etat: valide ? "done" : "current",
    detail, phrase, ton,
    declaration: { id: decl.id, reference: decl.reference, authorityRef: decl.authorityRef, authorityNotes: decl.authorityNotes },
    lienDossier: voitLeDossier ? `/information-medicale/${decl.id}` : null,
    peutAgir: tient && !valide,
    peutOuvrir: false,
    depot: { ouvert: depotOuvert, motif: depotOuvert ? null : refusDepotAutorites(etat) },
    pieces,
  };
}
