import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getPendingValidations, getSupervisedValidations } from "@/lib/queries/validations";
import type { SessionUser } from "@/lib/rbac";

/**
 * Visibilité des demandes de validation (bug rapporté : « une demande n'est apparue ni chez
 * moi ni chez les validateurs concernés »). On garantit deux choses :
 *  1. TOUT validateur assigné voit la demande — y compris le 2ᵉ validateur d'un circuit
 *     SÉQUENTIEL, AVANT son tour (marquée `actionable: false`, non décidable pour l'instant).
 *  2. La SUPERVISION (Direction / Super Admin) voit les demandes en cours où elle n'est ni
 *     demandeur ni validateur ; un rôle ordinaire n'a AUCUNE vue de supervision.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__valvis__${Date.now()}`;
const ids: Record<string, string> = {};
let requestId = "";

const mkSession = (id: string, role: UserRole): SessionUser => ({
  id, role, access: { modules: new Map(), rowGrants: new Map(), secondaryRole: null },
});

async function mkUser(slug: string, role: UserRole): Promise<string> {
  const u = await prisma.user.create({ data: { name: `${TAG}${slug}`, email: `${TAG}${slug}@t.dz`, passwordHash: "x", role } });
  return u.id;
}

suite("Visibilité des demandes de validation", () => {
  beforeAll(async () => {
    ids.requester = await mkUser("req", "REGULATORY_ASSISTANT");
    ids.v1 = await mkUser("v1", "HEAD_OF_REGULATORY");
    ids.v2 = await mkUser("v2", "PRODUCT_MANAGER");
    ids.direction = await mkUser("dir", "DIRECTION");
    ids.stranger = await mkUser("str", "SALES_USER");

    // Circuit SÉQUENTIEL à 2 validateurs, en cours au tour 1.
    const req = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-seq`, module: "Demandes de validations", title: "Courrier à valider",
        requesterId: ids.requester, status: "PENDING", currentOrder: 1, mode: "SEQUENTIAL",
        steps: { create: [
          { order: 1, validatorId: ids.v1, status: "PENDING" },
          { order: 2, validatorId: ids.v2, status: "PENDING" },
        ] },
      },
    });
    requestId = req.id;
    // Une pièce jointe à la demande : TOUT validateur assigné doit la voir sur place.
    await prisma.document.create({
      data: { name: `${TAG}piece.pdf`, category: "OTHER", entityType: "VALIDATION_REQUEST", entityId: requestId, fileKey: `${TAG}/k`, confidentiality: "INTERNAL", uploadedById: ids.requester },
    });
  });

  afterAll(async () => {
    await retirerDocumentsEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le 1er validateur (son tour) voit la demande, DÉCIDABLE maintenant", async () => {
    const items = await getPendingValidations(ids.v1);
    const mine = items.find((i) => i.requestId === requestId);
    expect(mine).toBeDefined();
    expect(mine!.actionable).toBe(true);
  });

  it("le 2ᵉ validateur VOIT déjà la demande (avant son tour), marquée NON décidable", async () => {
    const items = await getPendingValidations(ids.v2);
    const mine = items.find((i) => i.requestId === requestId);
    // Cœur du correctif : auparavant cette étape était filtrée → invisible pour v2.
    expect(mine).toBeDefined();
    expect(mine!.actionable).toBe(false);
  });

  it("les DEUX validateurs voient la pièce jointe à la demande (aperçu sur place)", async () => {
    for (const id of [ids.v1, ids.v2]) {
      const mine = (await getPendingValidations(id)).find((i) => i.requestId === requestId);
      expect(mine!.documents.some((doc) => doc.name === `${TAG}piece.pdf`)).toBe(true);
    }
  });

  it("la Direction (vue globale) SUPERVISE la demande sans y être partie", async () => {
    const sup = await getSupervisedValidations(mkSession(ids.direction, "DIRECTION"));
    expect(sup.some((r) => r.id === requestId)).toBe(true);
  });

  it("un rôle ordinaire n'a AUCUNE vue de supervision", async () => {
    const sup = await getSupervisedValidations(mkSession(ids.stranger, "SALES_USER"));
    expect(sup).toEqual([]);
  });

  it("la supervision EXCLUT ses propres demandes et celles qu'on doit valider", async () => {
    // Le demandeur n'est pas « superviseur » (rôle non global) → liste vide de toute façon,
    // mais on vérifie surtout qu'un validateur global ne voit PAS en supervision une demande
    // qu'il doit lui-même valider (elle appartient à « À valider », pas à « Supervision »).
    const asV1Global = await getSupervisedValidations(mkSession(ids.v1, "DIRECTION"));
    expect(asV1Global.some((r) => r.id === requestId)).toBe(false);
  });
});
