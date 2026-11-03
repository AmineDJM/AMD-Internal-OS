import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerTache, ignoree, type TachePlanifiee } from "./executer";
import { TACHES_PLANIFIEES } from "@/lib/scheduled";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * P1 ter (décision 0066) — LES MISSIONS À 0 % EN PRODUCTION (03/11) : web ET worker en `TACHES_DE_FOND=les-deux`, le
 * worker vivant. Le web atteint `travaux.balayage` en quelques secondes (ses autres tâches sont « occupées »), PREND LE
 * BAIL, s'abstient (le worker bat) — et son départ marqué ouvre l'intervalle minimal de 45 s. Le worker, qui fait le
 * vrai travail des 60 tâches d'avant, atteint la tâche plus tard : « occupée ». Personne ne conduit : étapes « En file »,
 * coût 0, des heures durant. Le correctif : l'abstention se décide AVANT le bail (`sAbstenir`).
 * Ce banc joue la séquence exacte, web puis worker, sur la VRAIE entrée de la table (seul le travail est remplacé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const CLE_VIVANT = `__banc_worker_vivant_${Date.now().toString(36)}`;
const MODE_AVANT = process.env.TACHES_DE_FOND;
let ligneAvant: Awaited<ReturnType<typeof prisma.tacheDeFond.findUnique>> = null;

suite("P1 ter — le web s'abstient AVANT le bail : le worker conduit les travaux", () => {
  beforeAll(async () => {
    process.env.TACHES_DE_FOND = "les-deux";
    ligneAvant = await prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" } });
    await prisma.tacheDeFond.deleteMany({ where: { cle: "travaux.balayage" } });
    // Le worker BAT : il vient de prendre une tâche.
    await prisma.tacheDeFond.create({ data: { cle: CLE_VIVANT, executeur: "worker", dernierDebutA: new Date(), dernierStatut: "OK" } });
  });
  afterAll(async () => {
    if (MODE_AVANT === undefined) delete process.env.TACHES_DE_FOND; else process.env.TACHES_DE_FOND = MODE_AVANT;
    await prisma.tacheDeFond.deleteMany({ where: { cle: { in: [CLE_VIVANT, "travaux.balayage"] } } });
    if (ligneAvant) await prisma.tacheDeFond.create({ data: ligneAvant });
  });

  it("la vraie entrée « travaux.balayage » : le web passe d'abord (abstenu, sans bail), le worker juste après CONDUIT", async () => {
    const vraie = TACHES_PLANIFIEES.find((t) => t.cle === "travaux.balayage")!;
    let conduits = 0;
    const tache: TachePlanifiee = { ...vraie, executer: async () => { conduits += 1; } };
    const web = await executerTache(tache, { executeur: "web", detenteur: "web@banc", journal: () => {} });
    expect(web.issue).toBe("abstenue");
    expect((await prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" } }))?.dernierDebutA ?? null).toBeNull();
    const worker = await executerTache(tache, { executeur: "worker", detenteur: "worker@banc", journal: () => {} });
    expect(worker.issue, "le worker doit trouver la tâche LIBRE — sinon aucune mission n'avance").toBe("ok");
    expect(conduits).toBe(1);
    expect(await prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" } })).toMatchObject({ executeur: "worker", dernierStatut: "OK" });
  });

  it("LE DÉFAUT, rejoué : une abstention DANS le travail (bail pris) affame le worker — ce que le correctif interdit", async () => {
    await prisma.tacheDeFond.deleteMany({ where: { cle: "travaux.balayage" } });
    const ancienne: TachePlanifiee = { cle: "travaux.balayage", bailMs: 180_000, executer: async () => ignoree("le worker conduit les travaux") };
    expect((await executerTache(ancienne, { executeur: "web", detenteur: "web@banc", journal: () => {} })).issue).toBe("ignoree");
    expect((await executerTache(ancienne, { executeur: "worker", detenteur: "worker@banc", journal: () => {} })).issue).toBe("occupee");
  });

  it("même règle pour les conversions de l'Atelier", () => {
    expect(TACHES_PLANIFIEES.find((t) => t.cle === "atelier.conversions")?.sAbstenir).toBeTypeOf("function");
  });
});
