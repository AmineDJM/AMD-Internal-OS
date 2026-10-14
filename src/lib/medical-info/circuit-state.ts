import { prisma } from "@/lib/prisma";
import { circuitOfDeclaration, type MedicalCircuit } from "./circuits";
import { canFileWithAuthorities, type DeclareInput } from "./declare-decision";
import { slipsLotStage, slipsSummary, PRISE_DU_BON, type SlipLike, type SlipsLotStage, type SlipsSummary } from "./slips";

/**
 * OÙ EN EST UN DOSSIER D'INFORMATION MÉDICALE — la lecture, une fois, pour l'écran comme pour
 * les actions.
 *
 * L'état ne vit dans aucun champ : il se compose du circuit (déduit de la nature du dossier), de
 * la décision de déclarer, de la validation du dépôt des bons, et de la route de CHAQUE bon —
 * demande de paiement, passage au centre, règlement, remise. Le stocker en plus aurait créé une
 * seconde vérité, qui se désynchronise au premier refus du centre.
 *
 * `circuits.ts`, `declare-decision.ts` et `slips.ts` décident ensuite CE QUE cet état autorise —
 * sans base, donc testables.
 */

export interface DeclarationLike {
  id: string;
  sourceType: string;
  declarationKind: string | null;
  declareValidationId: string | null;
  declareIntent: string | null;
  declareGrantedAt: Date | null;
  authorityRef: string | null;
  bvValidationId: string | null;
  bvSkippedAt: Date | null;
}

/** Un bon de versement tel qu'il se lit à l'écran : sa route, plus ce qui le nomme. */
export interface SlipRow extends SlipLike {
  note: string | null;
  position: number;
  deliveredById: string | null;
  deliveryNote: string | null;
  /** Le dernier mouvement du bon — ce qui dit depuis quand le lot attend. */
  updatedAt: Date;
}

export interface MedicalCircuitState {
  circuit: MedicalCircuit;
  /** Circuit ÉVÉNEMENT : la décision « faut-il déclarer ? ». */
  declare: DeclareInput;
  /** Circuit MATÉRIEL : la validation du dépôt du lot de bons. */
  lot: SlipsLotStage;
  slips: SlipRow[];
  summary: SlipsSummary;
  /** Le dossier a-t-il été déclaré sans versement ? (porte de sortie du circuit matériel) */
  skipped: boolean;
}

export async function circuitStateOf(decl: DeclarationLike): Promise<MedicalCircuitState> {
  const etats = await circuitStatesOf([decl]);
  return etats.get(decl.id)!;
}

/**
 * LA MÊME LECTURE, POUR TOUTE UNE LISTE — un aller-retour par TABLE, pas par dossier.
 *
 * La liste du registre dit « où en est-il, chez qui » sur chaque ligne : appeler `circuitStateOf`
 * ligne à ligne multipliait cinq requêtes par le nombre de dossiers. Une seule fonction fait les
 * deux — la fiche lit un dossier, la liste en lit cent, et c'est la même vérité.
 */
export async function circuitStatesOf(decls: readonly DeclarationLike[]): Promise<Map<string, MedicalCircuitState>> {
  if (decls.length === 0) return new Map();
  const validationIds = decls
    .flatMap((d) => [d.declareValidationId, d.bvValidationId])
    .filter((x): x is string => Boolean(x));

  // LES LECTURES PARTENT ENSEMBLE : elles ne dépendent pas les unes des autres, et l'écran du
  // pharmacien attendrait trois allers-retours au lieu d'un.
  const [validations, slipRows] = await Promise.all([
    validationIds.length
      ? prisma.validationRequest.findMany({ where: { id: { in: validationIds } }, select: { id: true, status: true } })
      : Promise.resolve([] as { id: string; status: unknown }[]),
    prisma.medicalInfoSlip.findMany({
      where: { declarationId: { in: decls.map((d) => d.id) } },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const validationById = new Map(validations.map((v) => [v.id, v]));

  // La route de chaque bon se lit sur son ordre de dépense. Un seul aller-retour pour tous : un
  // par bon multiplierait les requêtes par le nombre de matériels.
  const requestIds = slipRows.map((s) => s.requestId).filter((x): x is string => Boolean(x));
  const requests = requestIds.length
    ? await prisma.paymentRequest.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, amount: true, expenseOrderId: true, status: true },
      })
    : [];
  const orderIds = requests.map((r) => r.expenseOrderId).filter((x): x is string => Boolean(x));
  const orders = orderIds.length
    ? await prisma.expenseOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, centralStatus: true, status: true },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const reqById = new Map(requests.map((r) => [r.id, r]));

  const slipsByDecl = new Map<string, SlipRow[]>();
  for (const s of slipRows) {
    const req = s.requestId ? reqById.get(s.requestId) : null;
    const order = req?.expenseOrderId ? orderById.get(req.expenseOrderId) : null;
    const row: SlipRow = {
      id: s.id,
      label: s.label,
      // LE MONTANT AFFICHÉ EST CELUI DE LA DEMANDE quand elle existe : la quittance réelle n'est
      // pas toujours celle annoncée, et montrer l'annonce après le règlement ferait douter du
      // chiffre payé.
      amount: req ? Number(req.amount) : (s.amount === null ? null : Number(s.amount)),
      note: s.note,
      position: s.position,
      requestId: s.requestId,
      centralStatus: order ? String(order.centralStatus) : null,
      orderStatus: order ? String(order.status) : null,
      // La demande elle-même : refusée, annulée — ou disparue (un bon qui désigne une demande absente).
      requestStatus: req ? String(req.status) : (s.requestId && !s.requestId.startsWith(PRISE_DU_BON) ? "INTROUVABLE" : null),
      deliveredAt: s.deliveredAt,
      deliveredById: s.deliveredById,
      deliveryNote: s.deliveryNote,
      updatedAt: s.updatedAt,
    };
    const liste = slipsByDecl.get(s.declarationId);
    if (liste) liste.push(row);
    else slipsByDecl.set(s.declarationId, [row]);
  }

  const out = new Map<string, MedicalCircuitState>();
  for (const decl of decls) {
    const declareValidation = decl.declareValidationId ? validationById.get(decl.declareValidationId) : null;
    const lotValidation = decl.bvValidationId ? validationById.get(decl.bvValidationId) : null;
    const slips = slipsByDecl.get(decl.id) ?? [];
    out.set(decl.id, {
      circuit: circuitOfDeclaration(decl),
      declare: {
        // Une validation SUPPRIMÉE (retirée par son demandeur) n'est plus une demande : son
        // identifiant resté sur le dossier le laissait « en validation » à vie (audit 360°, I9).
        validationId: declareValidation ? decl.declareValidationId : null,
        validationStatus: declareValidation ? String(declareValidation.status) : null,
        intent: decl.declareIntent,
        grantedAt: decl.declareGrantedAt,
      },
      lot: slipsLotStage({
        validationId: lotValidation ? decl.bvValidationId : null,
        validationStatus: lotValidation ? String(lotValidation.status) : null,
      }),
      slips,
      summary: slipsSummary(slips),
      skipped: Boolean(decl.bvSkippedAt),
    });
  }
  return out;
}

/**
 * LE DÉPÔT AUX AUTORITÉS EST-IL OUVERT ? — la règle des DEUX circuits, en un seul endroit.
 *
 * Circuit ÉVÉNEMENT : quand la lecture « à déclarer » a été accordée. Circuit MATÉRIEL : quand
 * toutes les quittances sont revenues au bureau du pharmacien — ou que le dossier a été déclaré
 * sans versement. Poser cette règle à deux endroits, c'est garantir qu'un jour ils divergeront.
 */
export function authoritiesOpen(state: MedicalCircuitState): boolean {
  if (state.circuit === "EVENT") return canFileWithAuthorities(state.declare);
  return state.summary.allDelivered || state.skipped;
}
