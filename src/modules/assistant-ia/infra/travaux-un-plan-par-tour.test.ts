// EN PREMIER, comme le worker (`scripts/worker.ts`) : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { approuverTravail } from "@/lib/missions/travaux/service";
import { outilTravailPour, PERSONA_ASSISTANT_IA } from "./travaux";

/**
 * UN TOUR, UN PLAN (banc réel du 31/10/2026) — le modèle rappelait `lancer_un_travail` pour « corriger » un plan déjà
 * accepté : cinq plans attendaient l'approbation pour une seule demande. Le plan suivant du MÊME tour remplace le
 * précédent tant qu'il n'est pas approuvé ; un tour suivant (un nouvel outil) ne touche à rien ; un plan approuvé
 * n'est jamais annulé.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__upt__${Date.now()}`;
let moi: CurrentUser;
let lecture = "";

const plan = (titre: string) => ({
  titre, objectif: "Lire les demandes, puis rendre un rapport.",
  etapes: [
    { cle: "lire", titre: "Lire", type: "LECTURE", outil: lecture, entree: {} },
    { cle: "rapport", titre: "Rapport", type: "LIVRABLE", consigne: "Rédige le rapport.", apres: ["lire"], format: "md" },
  ],
});
const enAttente = () => prisma.mission.findMany({ where: { principalId: moi.id, kind: "TRAVAIL", status: "AWAITING_APPROVAL" }, select: { title: true } });

suite("un tour, un plan — le plan suivant du même tour remplace le précédent", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN" } as CurrentUser;
    lecture = (await PERSONA_ASSISTANT_IA.catalogue(moi.id)).lectures[0]?.nom ?? "";
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { principalId: moi.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("PRÉMISSE : la personne a une lecture à mettre au plan", () => {
    expect(lecture).not.toBe("");
  });

  it("deux propositions dans le même tour : une seule attend l'approbation, la dernière", async () => {
    const outil = outilTravailPour(moi);
    for (const t of ["Premier jet", "Plan corrigé"]) {
      expect(JSON.parse(await outil.run(plan(t), moi)).statut).toBe("EN_ATTENTE_D_APPROBATION");
    }
    expect((await enAttente()).map((m) => m.title)).toEqual(["Plan corrigé"]);
  });

  it("un tour suivant ne retire pas le plan du tour d'avant ; un plan approuvé n'est jamais annulé", async () => {
    const [avant] = await prisma.mission.findMany({ where: { principalId: moi.id, status: "AWAITING_APPROVAL" }, select: { id: true } });
    const outil = outilTravailPour(moi);
    await outil.run(plan("Tour suivant"), moi);
    expect((await enAttente()).map((m) => m.title).sort()).toEqual(["Plan corrigé", "Tour suivant"]);

    const tour3 = outilTravailPour(moi);
    const premier = JSON.parse(await tour3.run(plan("Approuvé"), moi)) as { travailId: string };
    expect((await approuverTravail(premier.travailId, moi.id, PERSONA_ASSISTANT_IA)).ok).toBe(true);
    await tour3.run(plan("Après l'approbation"), moi);
    const approuve = await prisma.mission.findUnique({ where: { id: premier.travailId }, select: { status: true } });
    expect(approuve?.status).not.toBe("CANCELLED");
    expect(avant).toBeTruthy();
  });
});
