import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { getDeclarations, dernieresRelancesPieces, sourceLink } from "@/lib/queries/medical-info";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { loadEntity } from "@/lib/workflow/engine/entites";
import { DECLARATION_KIND_LABEL, isDeclarationKind } from "@/lib/medical-info/circuits";
import { circuitStatesOf } from "@/lib/medical-info/circuit-state";
import { canRequestDecision, declareStage } from "@/lib/medical-info/declare-decision";
import { chezDecideur } from "@/lib/medical-info/decideur";
import {
  parcoursDuDossier, joursDepuis, nomCourt, peutRelancerPiece,
  ORDRE_TOURS, consigneDuTour, tourDeLaDeclaration, type LigneAVenir, type LigneDeclarationAFaire, type TourDeclaration,
} from "@/lib/medical-info/parcours";
import { declarationsAVenir } from "@/lib/medical-info/declaration-postes";
import { ETAPE_DECLARATION_PARTAGEE } from "@/lib/medical-info/etape-ad-pro-partage";

/**
 * « À FAIRE — INFORMATION MÉDICALE », LES DÉCLARATIONS (Direction, 23/11/2026) — chaque dossier ouvert, rangé par TOUR
 * (`medical-info/parcours.ts`), avec ce qu'il faut pour agir sur la ligne : la lecture et sa validation, la référence ANPP, les
 * pièces attendues et leur relance, les fichiers déposés. Puis « À venir » : les demandes accordées dont la déclaration
 * attend encore des postes. La même lecture que la fiche (`circuitStatesOf` → `parcoursOf`), un aller-retour par table.
 */

const MODULE_DE_LA_SOURCE: Record<string, "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENTS"> = {
  SPONSORING: "SPONSORING", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", EVENT: "EVENTS",
};

/** La fiche de la demande source — seulement pour qui ouvre son module. */
function lienSource(user: SessionUser, type: string, id: string): string | null {
  const module = MODULE_DE_LA_SOURCE[type];
  return module && (hasGlobalView(user.role) || userCan(user, module, "VIEW")) ? sourceLink(type, id) : null;
}

export interface AFaireDeclarations {
  tours: { tour: TourDeclaration; lignes: LigneDeclarationAFaire[] }[];
  aVenir: LigneAVenir[];
  /** Le pharmacien (ou la vue globale) : les gestes sont offerts ; sinon l'écran se lit. */
  gestionnaire: boolean;
}

export async function declarationsAFaire(user: SessionUser, now: Date = new Date()): Promise<AFaireDeclarations> {
  const gestionnaire = hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");
  const ouvertes = (await getDeclarations(user)).filter((d) => d.status !== "VALIDATED");
  const ids = ouvertes.map((d) => d.id);
  const [etats, decideurs, demandes, fichiers] = await Promise.all([
    circuitStatesOf(ouvertes),
    decideursInfoMedActifs(null),
    ids.length ? prisma.medicalInfoDocRequest.findMany({
      where: { declarationId: { in: ids }, status: "PENDING" }, orderBy: { createdAt: "asc" },
      select: { id: true, declarationId: true, label: true, status: true, createdAt: true, targetUserId: true, requestedById: true, targetUser: { select: { name: true } } },
    }) : [],
    ids.length ? prisma.document.findMany({
      where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } }, orderBy: { createdAt: "desc" },
      select: { id: true, name: true, entityId: true, createdAt: true, stepKey: true },
    }) : [],
  ]);
  const chez = chezDecideur(decideurs);

  const lignes: LigneDeclarationAFaire[] = [];
  for (const d of ouvertes) {
    const etat = etats.get(d.id);
    if (!etat) continue;
    const parcours = parcoursDuDossier(d, etat, chez);
    const lecture = declareStage(etat.declare);
    const pharmacien = nomCourt(d.pharmacist?.name) ?? "le pharmacien";
    const tour = tourDeLaDeclaration({ courante: parcours.courante, lecture, lot: etat.lot, bonsChezPharmacien: parcours.chez === pharmacien });
    if (!tour) continue;
    const attendues = demandes.filter((r) => r.declarationId === d.id);
    const relances = tour === "PIECES" && attendues.length ? await dernieresRelancesPieces(d.id) : new Map<string, Date>();
    lignes.push({
      id: d.id, reference: d.reference, label: d.label,
      nature: isDeclarationKind(d.declarationKind) ? DECLARATION_KIND_LABEL[d.declarationKind] : (ENTITY_TYPE_LABELS[d.sourceType] ?? d.sourceType),
      beneficiaire: d.beneficiary, montant: d.amount != null ? toNumber(d.amount) : null,
      tour, consigne: consigneDuTour(tour, { lecture, intentSkip: etat.declare.intent === "SKIP", circuit: etat.circuit, chez: parcours.chez }),
      jours: joursDepuis(parcours.depuis, now), circuit: etat.circuit, declare: etat.declare,
      validationHref: d.declareValidationId ? `/validations/${d.declareValidationId}` : null,
      peutDemander: gestionnaire && etat.circuit === "EVENT" && canRequestDecision(etat.declare),
      authorityRef: d.authorityRef, authorityNotes: d.authorityNotes,
      piecesEnAttente: attendues.length > 0,
      pieces: attendues.map((r) => {
        const relance = peutRelancerPiece(r, { userId: user.id, gestionnaire, derniereRelance: relances.get(r.id) ?? null, now: now.getTime() });
        return { id: r.id, label: r.label, chez: r.targetUser?.name ?? null, jours: joursDepuis(r.createdAt, now), refusRelance: relance.ok ? null : relance.raison };
      }),
      fichiers: fichiers.filter((f) => f.entityId === d.id).slice(0, 6)
        .map((f) => ({ id: f.id, nom: f.name, le: f.createdAt.toISOString(), partagee: f.stepKey === ETAPE_DECLARATION_PARTAGEE })),
      sourceHref: lienSource(user, d.sourceType, d.sourceId),
    });
  }

  // Le plus ancien d'abord : c'est lui qu'on relance, ou qui fait attendre.
  const tours = ORDRE_TOURS
    .map((tour) => ({ tour, lignes: lignes.filter((l) => l.tour === tour).sort((a, b) => (b.jours ?? 0) - (a.jours ?? 0)) }))
    .filter((t) => t.lignes.length > 0);

  const aVenir: LigneAVenir[] = [];
  for (const v of await declarationsAVenir()) {
    const resume = await loadEntity(v.type, v.id);
    aVenir.push({
      cle: `${v.type}:${v.id}`, type: v.type, id: v.id, nom: resume?.label ?? "—", nature: ENTITY_TYPE_LABELS[v.type] ?? v.type,
      valides: v.postes.valides, total: v.postes.total, blocages: v.postes.blocages, brouillons: v.postes.brouillons,
      ouvrable: v.ouvrable, href: lienSource(user, v.type, v.id),
    });
  }
  return { tours, aVenir, gestionnaire };
}
