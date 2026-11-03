import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { recordAudit, recordFieldChanges } from "@/lib/audit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHAÎNE COMPLÈTE — une écriture ERP réelle finit-elle vraiment par clore la tâche ?
 *
 * `from-audit.test.ts` fige la DÉCISION (« ceci est-il un fait ? »), au cas près et sans base.
 * Ici on branche tout : `recordAudit` → classeur → registre → réconciliation → tâche.
 *
 * C'est le seul test qui puisse répondre à la question du départ — celle d'une tâche « Yacine
 * Habes : envoyer le contrat » restée TODO alors que le contrat AVAIT été déposé. Un test de
 * classeur seul ne l'aurait pas vue : le classeur était juste, c'est le branchement qui
 * manquait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `ZZAUD${Date.now()}`;
const taches: string[] = [];
/** La personne à qui la tâche est confiée est À CE BANC — jamais un compte emprunté, qu'un voisin retire en cours de route. */
const comptes = comptesDeBanc("__auditledger_");

suite("l'audit alimente le registre des faits", () => {
  afterAll(async () => {
    await prisma.businessEvent.deleteMany({ where: { entityId: { startsWith: TAG } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: { in: taches } } }).catch(() => {});
    await comptes.retirer();
  });

  it("un téléversement inscrit un fait — sans qu'aucun appelant ait à y penser", async () => {
    await recordAudit({
      action: "UPLOAD", module: "LEGAL",
      entityType: "LEGAL_DOCUMENT", entityId: `${TAG}doc1`,
      summary: "Contrat déposé",
    });

    const faits = await prisma.businessEvent.findMany({
      where: { entityId: `${TAG}doc1` },
      select: { type: true, sourceDomain: true, payload: true },
    });
    expect(faits.length).toBe(1);
    expect(faits[0].type).toBe("DOCUMENT_UPLOADED");
    expect(faits[0].sourceDomain).toBe("LEGAL");
  });

  it("UN CHANGEMENT DE STATUT passe par `recordFieldChanges` — le chemin qu'on aurait pu manquer", async () => {
    // `recordFieldChanges` n'appelle PAS `recordAudit` : il écrit en `createMany`. Brancher le
    // registre uniquement sur `recordAudit` aurait laissé invisibles TOUS les changements de
    // statut — c'est-à-dire l'essentiel de ce qu'une tâche attend.
    await recordFieldChanges(
      { module: "SALES", entityType: "SALE", entityId: `${TAG}sale1`, summary: "Règlement reçu" },
      { paymentStatus: "UNPAID", comment: "rien" },
      { paymentStatus: "PAID", comment: "vu" },
      ["paymentStatus", "comment"],
    );

    const faits = await prisma.businessEvent.findMany({
      where: { entityId: `${TAG}sale1` },
      select: { type: true, payload: true },
    });
    // UN seul fait : le règlement. Le commentaire modifié n'en est pas un — sans ce tri, le
    // registre deviendrait un miroir de l'audit.
    expect(faits.map((f) => f.type)).toEqual(["PAYMENT_RECEIVED"]);
    expect(faits[0].payload).toMatchObject({ de: "UNPAID", vers: "PAID" });
  });

  it("LE CAS D'ORIGINE : la tâche qui attendait le document se clôt toute seule", async () => {
    const user = await comptes.creer("assignee");

    const t = await prisma.task.create({
      data: {
        title: `${TAG} envoyer le contrat signé`,
        status: "TODO",
        assignedToId: user.id,
        // L'ATTENTE EST DÉCLARÉE à la création : c'est ce qui autorise la clôture automatique.
        // Une attente seulement DÉDUITE d'un titre inscrit la preuve et s'arrête là.
        expectedEvent: "DOCUMENT_UPLOADED",
        relatedEntityType: "CONSULTING_CONTRACT",
        relatedEntityId: `${TAG}contrat1`,
      },
      select: { id: true },
    });
    taches.push(t.id);

    await recordAudit({
      actorId: user.id, action: "UPLOAD", module: "ADPRO_CONSULTING",
      entityType: "CONSULTING_CONTRACT", entityId: `${TAG}contrat1`,
      summary: "Contrat signé déposé",
    });

    const apres = await prisma.task.findUnique({
      where: { id: t.id },
      select: { status: true, evidenceAt: true, evidenceEntityId: true, evidenceNote: true, completedAt: true },
    });
    // C'EST TOUTE LA MISSION : la tâche n'est plus en retard, parce que le fait a eu lieu.
    expect(apres!.status).toBe("DONE");
    expect(apres!.evidenceAt).not.toBeNull();
    expect(apres!.evidenceEntityId).toBe(`${TAG}contrat1`);
    expect(apres!.completedAt).not.toBeNull();
  });

  it("un fait qu'AUCUNE tâche ne peut attendre ne déclenche pas de recherche", async () => {
    // `TENDER_STATUS_CHANGED` n'est pas dans `EXPECTED_EVENTS`. Le fait est inscrit — il compte
    // pour la frise — mais la réconciliation est court-circuitée : sans ce pré-filtre, chaque
    // changement de statut de l'ERP lirait 400 tâches pour ne rien trouver.
    await recordAudit({
      action: "UPDATE", module: "PCH", entityType: "PCH_TENDER", entityId: `${TAG}ao1`,
      field: "status", oldValue: "NOT_STARTED", newValue: "IN_PROGRESS",
    });
    const faits = await prisma.businessEvent.findMany({ where: { entityId: `${TAG}ao1` }, select: { type: true } });
    expect(faits.map((f) => f.type)).toEqual(["TENDER_STATUS_CHANGED"]);
  });

  it("le bruit ordinaire n'écrit RIEN dans le registre", async () => {
    await recordAudit({ action: "UPDATE", module: "ADPRO", entityType: "AD_PRO_ITEM", entityId: `${TAG}noise1`, field: "position", oldValue: "1", newValue: "2" });
    await recordAudit({ action: "EXPORT", module: "REGULATORY", entityType: "REGULATORY_PRODUCT", entityId: `${TAG}noise2` });
    await recordAudit({ action: "LOGIN", module: "AUTH" });

    const faits = await prisma.businessEvent.count({ where: { entityId: { in: [`${TAG}noise1`, `${TAG}noise2`] } } });
    expect(faits).toBe(0);
  });

  it("l'échec du registre ne fait PAS échouer l'audit — la garde de non-régression", async () => {
    // Un `entityType` que la base refuse : l'inscription du fait échoue, et `recordAudit` doit
    // néanmoins rendre la main normalement. Un registre qui fait tomber une écriture métier
    // est une régression, pas une observabilité.
    await expect(recordAudit({
      action: "UPLOAD", module: "LEGAL",
      entityType: "CE_TYPE_N_EXISTE_PAS" as never, entityId: `${TAG}bad`,
    })).resolves.toBeUndefined();
  });
});
