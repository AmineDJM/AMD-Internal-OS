import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { toNumber } from "@/lib/utils";
import { ENTITY_TYPE_LABELS, MEDICAL_INFO_STATUS, type BadgeTone } from "@/lib/labels";
import { estDecideurInfoMed, chezDecideur } from "@/lib/medical-info/decideur";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { circuitStatesOf } from "@/lib/medical-info/circuit-state";
import { declareStage } from "@/lib/medical-info/declare-decision";
import { parcoursDuDossier, nomCourt, tourDeLaDeclaration, type TourDeclaration } from "@/lib/medical-info/parcours";
import type { ActionItem } from "./action-center";

/**
 * « MON ESPACE » — L'INFORMATION MÉDICALE, AU BON TOUR (Direction, 23/11/2026). Sorti du centre d'actions.
 *
 * L'INSTRUCTION est le travail du PHARMACIEN RESPONSABLE (PRIM), et de lui seul : la Direction a le droit d'agir sur le
 * module, mais ces dossiers ne sont pas SA file. La validation finale (AWAITING_DIRECTION) est la file du DIRECTEUR DES
 * OPÉRATIONS (`medical-info/decideur.ts`), même garde que `validateDeclarationByDirection`. Le Super Admin voit tout.
 *
 * Le statut seul mentait : tout dossier « AWAITING_REVIEW » se lisait « À déclarer — Déclarer », même quand la lecture du
 * pharmacien attendait le Directeur des Opérations. La ligne suit désormais le TOUR (`tourDeLaDeclaration`, la règle de
 * l'écran « À faire ») : elle n'apparaît que quand c'est à lui, et dit SON geste.
 */

/** Ce qu'il fait, par tour — et la nature du lot de « Mon espace » (`aujourdhui.ts` la lit sur le statut). */
const PAR_TOUR: Partial<Record<TourDeclaration, { libelle: string; statut: "AWAITING_REVIEW" | "READY" | "DOCS_REQUESTED" }>> = {
  LECTURE: { libelle: "Soumettre ma lecture", statut: "AWAITING_REVIEW" },
  DEPOT: { libelle: "Déposer à l'ANPP", statut: "AWAITING_REVIEW" },
  BONS: { libelle: "Bons de versement", statut: "AWAITING_REVIEW" },
  VALIDER: { libelle: "Valider", statut: "READY" },
  PIECES: { libelle: "Relancer les pièces", statut: "DOCS_REQUESTED" },
};

export async function lignesInformationMedicale(user: SessionUser): Promise<ActionItem[]> {
  const prim = hasRole(user, "MEDICAL_INFO_PHARMACIST") || user.role === "SUPER_ADMIN";
  const direction = estDecideurInfoMed(user);
  const statuts = [
    ...(prim ? (["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"] as const) : []),
    ...(direction ? (["AWAITING_DIRECTION"] as const) : []),
  ];
  if (statuts.length === 0) return [];
  const decls = await prisma.medicalInfoDeclaration.findMany({
    where: { status: { in: [...statuts] } }, orderBy: { createdAt: "desc" }, take: 60,
    include: { pharmacist: { select: { name: true } }, requests: { select: { id: true, status: true, createdAt: true, fulfilledAt: true, targetUserId: true, targetUser: { select: { name: true } } } } },
  });
  const [etats, decideurs] = await Promise.all([circuitStatesOf(decls), decideursInfoMedActifs(null)]);
  const chez = chezDecideur(decideurs);
  const out: ActionItem[] = [];
  for (const d of decls) {
    const commun = {
      key: `mi-${d.id}`, objet: `MEDICAL_INFO_DECLARATION:${d.id}`, title: d.label, subtitle: d.reference,
      module: "Information médicale", href: `/information-medicale/${d.id}`, kind: "validation" as const, priority: null, deadline: null, owner: "",
      famille: ENTITY_TYPE_LABELS[d.sourceType] ?? null, montant: d.amount != null ? toNumber(d.amount) : null,
    };
    // Datée à la seule étape qu'un champ date à coup sûr : la validation du pharmacien, qui la fait passer à la Direction.
    if (d.status === "AWAITING_DIRECTION") {
      out.push({ ...commun, depuis: d.pharmacistValidatedAt?.toISOString() ?? null, ...resolveStatut(d.status), statut: d.status });
      continue;
    }
    const etat = etats.get(d.id);
    if (!etat) continue;
    const parcours = parcoursDuDossier(d, etat, chez);
    const tour = tourDeLaDeclaration({
      courante: parcours.courante, lecture: declareStage(etat.declare), lot: etat.lot,
      bonsChezPharmacien: parcours.chez === (nomCourt(d.pharmacist?.name) ?? "le pharmacien"),
    });
    const geste = tour ? PAR_TOUR[tour] : undefined;
    // CE N'EST PAS SON TOUR (sa lecture chez le Directeur des Opérations, des bons en paiement) : pas de ligne.
    if (!geste) continue;
    out.push({
      ...commun, depuis: parcours.depuis?.toISOString() ?? null,
      statusLabel: geste.libelle, statusTone: tour === "PIECES" ? "warning" : "info", statut: geste.statut,
    });
  }
  return out.slice(0, 40);
}

function resolveStatut(v: string): { statusLabel: string; statusTone: BadgeTone } {
  const l = (MEDICAL_INFO_STATUS as Record<string, { label: string; tone: BadgeTone }>)[v];
  return { statusLabel: l?.label ?? v, statusTone: l?.tone ?? "neutral" };
}
