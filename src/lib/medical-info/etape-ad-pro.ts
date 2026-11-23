import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { EVENT_SOURCES } from "@/lib/medical-info/circuits";
import { circuitStateOf, authoritiesOpen } from "@/lib/medical-info/circuit-state";
import { canRequestDecision, declareStage } from "@/lib/medical-info/declare-decision";
import { chezDecideur } from "@/lib/medical-info/decideur";
import {
  libellePastille, nomCourt, parcoursDuDossier, pharmacienPeutValider, tourDeLaDeclaration, TOURS_DU_PHARMACIEN,
} from "@/lib/medical-info/parcours";
import { canViewDeclaration } from "@/lib/queries/medical-info";
import { refusDepotAutorites } from "@/lib/actions/internes/medical-info/dossier";
import { tientLaDeclarationAdPro } from "@/lib/actions/internes/medical-info/ouverture-ad-pro";
import { declarationOuvrable } from "./declaration-postes";
import { ETAPE_DECLARATION_PARTAGEE, TITRE_ETAPE_DECLARATION, type EtapeDeclaration, type PieceDeDeclaration } from "./etape-ad-pro-partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DERNIÈRE ÉTAPE DU CIRCUIT AD & PRO — « Déclaration (information scientifique) » (Direction, 08/11/2026).
 *
 * « Après l'étape de la pré-validation, il faut ajouter une dernière étape de circuit : la déclaration des événements
 * scientifiques, en donnant la main au responsable de l'information médicale pour uploader les déclarations. »
 *
 * L'étape ne double rien : elle LIT le dossier d'information médicale (`DIM-…`) — ouvert quand TOUS les postes sont
 * validés (`declaration-postes.ts`, 19/11/2026) — : sa lecture « à déclarer / sans déclaration », la décision du Directeur
 * des Opérations, la référence ANPP, la validation ; et le montre sur la fiche de la demande, où personne ne le voyait. Le
 * pharmacien y agit (sa lecture, le dépôt des déclarations, la référence, sa validation) ; son écran « À faire —
 * Information médicale » range les mêmes gestes par tour. La déclaration S'ARRÊTE à la validation du Directeur des
 * Opérations : aucune étape ne la suit après le paiement.
 *
 * ELLE NE BLOQUE RIEN : postes, paiements et validation finale n'attendent pas l'ANPP.
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
 * circuit — la déclaration s'ouvre ensuite, quand le dernier poste est validé. `null` pour ce qui ne se déclare pas ici
 * (matériel promotionnel, « autres »).
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

  const base = {
    titre: TITRE_ETAPE_DECLARATION, depot: { ouvert: false, motif: null }, pieces: [] as PieceDeDeclaration[],
    decision: null, validation: { peut: false, piecesAttendues: false }, aVous: false,
  };
  if (!decl) {
    // LA DÉCLARATION ATTEND TOUS LES POSTES (Direction, 19/11/2026) : elle s'ouvre seule quand le dernier est validé, et les
    // déclare ensemble. Tant qu'il en reste, l'étape dit combien — et que la demande ne prendra plus de poste ensuite.
    const { ouvrable, postes } = await declarationOuvrable(sourceType, sourceId);
    const attendPostes = circuitConclu && !ouvrable;
    return {
      ...base,
      etat: circuitConclu && ouvrable ? "current" : "todo",
      detail: !circuitConclu ? "après les postes"
        : attendPostes ? (postes.total ? `${postes.valides}/${postes.total} postes validés` : "aucun poste encore") : "à ouvrir",
      phrase: !circuitConclu
        ? "Après la pré-validation puis la validation de tous les postes, le pharmacien déclare l'événement à l'ANPP."
        : attendPostes
          ? `La déclaration s'ouvrira quand tous les postes soumis seront validés (accordés, agence choisie pour un poste « agence ») — ${postes.valides} sur ${postes.total} le sont${postes.blocages.length ? ` (${postes.blocages.join(", ")})` : ""}. Ils seront déclarés ensemble : aucun poste ne s'ajoutera ensuite${postes.brouillons ? `, et ${postes.brouillons > 1 ? "les brouillons non soumis ne seront pas déclarés" : "le brouillon non soumis ne sera pas déclaré"}` : ""}.`
          : "Déclaration pas encore ouverte — chez le pharmacien responsable de l'information médicale",
      ton: circuitConclu && !attendPostes ? "attente" : "neutre",
      declaration: null, lienDossier: null, peutAgir: false, peutOuvrir: tient && circuitConclu && ouvrable,
      aVous: tient && circuitConclu && ouvrable,
    };
  }

  const etat = await circuitStateOf(decl);
  const valide = decl.status === "VALIDATED";
  const sansDeclaration = declareStage(etat.declare) === "ACCORDEE" && etat.declare.intent === "SKIP";
  const ref = decl.authorityRef?.trim() || null;
  const motifSans = decl.declareNote?.trim() ? ` (motif : ${decl.declareNote.trim()})` : "";

  const decideurs = valide ? null : await decideursInfoMedActifs(decl.pharmacistValidatedById ?? decl.pharmacistId);
  const parcours = decideurs ? parcoursDuDossier(decl, etat, chezDecideur(decideurs)) : null;
  // « À VOUS » DIT LE TOUR, PAS LE DROIT (23/11/2026) : la carte restait « À vous » pendant que la lecture du pharmacien, ou
  // sa validation, attendait le Directeur des Opérations. La règle de l'écran « À faire » (`tourDeLaDeclaration`).
  const tour = parcours ? tourDeLaDeclaration({
    courante: parcours.courante, lecture: declareStage(etat.declare), lot: etat.lot,
    bonsChezPharmacien: parcours.chez === (nomCourt(decl.pharmacist?.name) ?? "le pharmacien"),
  }) : null;

  let phrase: string;
  let detail: string | null;
  let ton: EtapeDeclaration["ton"];
  if (valide) {
    phrase = sansDeclaration ? `Validée — sans déclaration${motifSans}` : `Validée — déclarée à l'ANPP${ref ? ` (réf. ${ref})` : ""}`;
    detail = sansDeclaration ? "sans déclaration" : ref ? `réf. ${ref}` : "validée";
    ton = "succes";
  } else if (sansDeclaration || ref) {
    // LA SUITE, NOMMÉE : la validation du PHARMACIEN d'abord, puis la validation finale du Directeur des Opérations.
    // « Validation finale à venir » sur un dossier que le pharmacien n'avait pas encore validé faisait attendre le
    // Directeur, qui n'avait encore rien reçu (vu le 08/11/2026 sur SPO-2026-001).
    const suite = decl.status === "AWAITING_DIRECTION"
      ? "validation finale chez le Directeur des Opérations"
      : `à valider par ${decl.pharmacist?.name ?? "le pharmacien"}`;
    phrase = sansDeclaration ? `Sans déclaration${motifSans} — ${suite}` : `Déclarée à l'ANPP (réf. ${ref}) — ${suite}`;
    detail = sansDeclaration ? "sans déclaration" : `réf. ${ref}`;
    ton = "info";
  } else {
    phrase = parcours ? libellePastille(parcours) : "En cours";
    detail = parcours?.chez ? `chez ${parcours.chez}` : null;
    ton = "attente";
  }

  const voitLeDossier = tient || canViewDeclaration(user, decl);
  // LES DÉCLARATIONS SE TÉLÉCHARGENT PAR QUI OUVRE LA DEMANDE (09/11/2026) — le KAM, le marketing… Le reste du dossier
  // (pièces réclamées, documents internes) reste à qui voit le dossier d'information médicale.
  const pieces: PieceDeDeclaration[] = (await prisma.document.findMany({
    where: {
      entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id,
      ...(voitLeDossier ? {} : { stepKey: ETAPE_DECLARATION_PARTAGEE }),
    },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 30,
  })).map((d) => ({
    id: d.id, nom: d.name, le: d.createdAt.toISOString(), par: d.uploadedBy?.name ?? null,
    partagee: d.stepKey === ETAPE_DECLARATION_PARTAGEE,
  }));
  const depotOuvert = authoritiesOpen(etat);
  const agit = tient && !valide;
  // LES GESTES DU PHARMACIEN, ICI COMME DANS LE DOSSIER (08/11/2026) : la lecture tant qu'elle n'est pas accordée, puis
  // la validation qui transmet au Directeur des Opérations — les mêmes règles, les mêmes actions serveur.
  const lectureAccordee = declareStage(etat.declare) === "ACCORDEE";
  const decision = agit && etat.circuit === "EVENT" && !lectureAccordee
    ? {
        etat: etat.declare,
        peutDemander: canRequestDecision(etat.declare),
        validationHref: decl.declareValidationId ? `/validations/${decl.declareValidationId}` : null,
      }
    : null;
  const validation = {
    peut: agit && decl.status !== "AWAITING_DIRECTION"
      && pharmacienPeutValider({ ...etat, authorityRef: decl.authorityRef, declarationKind: decl.declarationKind }),
    piecesAttendues: decl.requests.some((r) => r.status === "PENDING"),
  };
  return {
    ...base,
    etat: valide ? "done" : "current",
    detail, phrase, ton,
    declaration: { id: decl.id, reference: decl.reference, authorityRef: decl.authorityRef, authorityNotes: decl.authorityNotes },
    lienDossier: voitLeDossier ? `/information-medicale/${decl.id}` : null,
    peutAgir: agit,
    aVous: agit && tour !== null && TOURS_DU_PHARMACIEN.includes(tour),
    decision,
    validation,
    peutOuvrir: false,
    // « Sans déclaration » accordée : il n'y a rien à déposer à l'ANPP. Le motif générique disait « la décision de
    // déclarer n'est pas encore accordée : décision accordée » — une phrase qui se contredit.
    depot: {
      ouvert: depotOuvert,
      motif: depotOuvert ? null : sansDeclaration
        ? "Sans déclaration : rien n'est déposé à l'ANPP, il n'y a donc pas de référence à enregistrer."
        : refusDepotAutorites(etat),
    },
    pieces,
  };
}
