import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { annuler, mettreEnPause, reprendre } from "@/lib/missions/runtime/control";
import { chargerEtat } from "@/lib/missions/runtime/store";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE CONDUITE, SUR UNE MISSION QUI A UN HORIZON.
 *
 * Ces tests partent de la BASE, avec les vraies fonctions de contrôle. Un test qui poserait le
 * statut à la main prouverait que la colonne accepte la valeur — ce qui n'a jamais été le
 * problème. Ce qui l'était : `PAUSED` existait depuis toujours et aucun code ne le lisait, et
 * l'arrêt d'une mission ignorait une table (les jalons) qu'il ne connaissait pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const siBase = dbOk ? describe : describe.skip;

const MARQUE = `horizon-controle-${Math.random().toString(36).slice(2, 10)}`;
const creees: string[] = [];

/**
 * Le propriétaire des missions est À CE BANC. Avant, `user.findFirst()` empruntait n'importe quel compte — souvent celui
 * d'un autre banc, qui le retire pendant la suite : `Mission.owner` est en `onDelete: Cascade`, la mission disparaissait
 * et `chargerEtat` rendait `null` (MESURÉ le 03/11 sous `npm test` : « horizonOuvert » indéfini ; 4/4 en isolé).
 */
let proprietaireDuBanc: string | null = null;
async function compteDuBanc(): Promise<string> {
  proprietaireDuBanc ??= (await prisma.user.create({
    data: { email: `${MARQUE}@banc.local`, name: "Propriétaire — banc horizon", passwordHash: "!", role: "VIEWER", isActive: true },
    select: { id: true },
  })).id;
  return proprietaireDuBanc;
}

async function missionAJalons(statut = "RUNNING"): Promise<string> {
  const u = { id: await compteDuBanc() };
  const m = await prisma.mission.create({
    data: {
      kind: "RUNTIME", title: MARQUE, objective: MARQUE, goalRaw: MARQUE,
      ownerId: u.id, status: statut as never, acceptance: [] as never,
      replanBloque: true, replanRefus: "CARDINALITY",
    },
    select: { id: true },
  });
  creees.push(m.id);
  for (const [i, s] of ["DONE", "ACTIVE", "PENDING"].entries()) {
    await prisma.missionMilestone.create({
      data: {
        missionId: m.id, ordre: i + 1, titre: `jalon ${i + 1}`,
        resultat: `le résultat ${i + 1} est constatable`, statut: s,
        planVersion: s === "PENDING" ? 0 : 1,
      },
    });
  }
  await prisma.missionStep.create({
    data: {
      missionId: m.id, key: "e1", title: "étape", nodeType: "CAPABILITY",
      capability: "directory_list", status: "PENDING",
    },
  });
  return m.id;
}

siBase("pause, reprise et arrêt d'une mission à horizon", () => {
  afterAll(async () => {
    if (creees.length > 0) await prisma.mission.deleteMany({ where: { id: { in: creees } } }).catch(() => {});
    if (proprietaireDuBanc) await prisma.user.delete({ where: { id: proprietaireDuBanc } }).catch(() => {});
  });

  it("un jalon vivant rend l'horizon OUVERT — c'est ce qui empêche `conclure` de juger trop tôt", async () => {
    const id = await missionAJalons();
    const etat = await chargerEtat(id);
    expect(etat?.horizonOuvert, "une mission avec un jalon ACTIVE devrait avoir l'horizon ouvert").toBe(true);
  });

  it("la PAUSE écrit sa date, son motif et l'état qu'elle a interrompu", async () => {
    const id = await missionAJalons("WAITING_INPUT");
    const r = await mettreEnPause(id, (await proprietaire(id)), "on attend l'avis du juriste");
    expect(r.ok).toBe(true);
    const m = await prisma.mission.findUnique({
      where: { id }, select: { status: true, pausedAt: true, pausedReason: true, pausedFrom: true },
    });
    expect(m?.status).toBe("PAUSED");
    expect(m?.pausedAt).not.toBeNull();
    expect(m?.pausedReason).toBe("on attend l'avis du juriste");
    // `pausedFrom` sert à DIRE ce qu'on a interrompu : une mission suspendue en pleine attente
    // et une mission suspendue en plein travail ne se reprennent pas avec la même phrase.
    expect(m?.pausedFrom).toBe("WAITING_INPUT");
    expect(r.message, "le message ne dit pas qu'elle attendait").toMatch(/attend/i);
  });

  it("la REPRISE efface la trace ET rouvre le droit de replanifier", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : `replanBloque` laissé à `true` par la reprise. Une mission
     * suspendue des jours a très bien pu voir son contexte changer — la personne a répondu, la
     * source a bougé, la contrainte a sauté. La garder bloquée la condamnerait à un refus décidé
     * dans un monde qui n'existe plus (§118.42).
     */
    const id = await missionAJalons();
    const owner = await proprietaire(id);
    await mettreEnPause(id, owner, "pause");
    const r = await reprendre(id, owner);
    expect(r.ok).toBe(true);
    const m = await prisma.mission.findUnique({
      where: { id },
      select: { status: true, pausedAt: true, pausedReason: true, pausedFrom: true, replanBloque: true, replanRefus: true },
    });
    expect(m?.status).toBe("RUNNING");
    expect(m?.pausedAt).toBeNull();
    expect(m?.pausedReason).toBeNull();
    expect(m?.pausedFrom).toBeNull();
    expect(m?.replanBloque, "une mission reprise reste condamnée par un refus périmé").toBe(false);
    expect(m?.replanRefus).toBeNull();
  });

  it("l'ARRÊT ferme les jalons VIVANTS et laisse l'acquis — sans quoi le pilote la reprendrait à jamais", async () => {
    const id = await missionAJalons();
    const r = await annuler(id, await proprietaire(id), "plus d'actualité");
    expect(r.ok).toBe(true);

    const jalons = await prisma.missionMilestone.findMany({
      where: { missionId: id }, orderBy: { ordre: "asc" }, select: { ordre: true, statut: true },
    });
    // Le jalon 1 était DONE : un acquis reste un acquis. Les 2 et 3 étaient vivants.
    expect(jalons).toEqual([
      { ordre: 1, statut: "DONE" },
      { ordre: 2, statut: "CANCELLED" },
      { ordre: 3, statut: "CANCELLED" },
    ]);

    const etat = await chargerEtat(id);
    expect(etat?.horizonOuvert, "l'horizon reste OUVERT sur une mission arrêtée : le pilote la reprendrait sans fin")
      .toBe(false);
  });
});

async function proprietaire(missionId: string): Promise<string> {
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { ownerId: true } });
  return m?.ownerId ?? "";
}
