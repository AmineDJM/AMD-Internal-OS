import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { runAssistantReminders } from "./reminders";
import { POWER_TOOLS } from "./power-tools";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « ENVOIE-MOI UN MAIL DANS 2 MINUTES » — mesuré en conversation, refusé, et c'était faux.
 *
 * Adam répondait « je ne peux pas programmer un e-mail différé dans cette session ». Vrai du
 * mécanisme : un rappel n'avait pas de canal, il passait toujours par la notification interne.
 * Faux de l'architecture : l'ordonnanceur vise la minute, la boîte connectée sait envoyer, et
 * le dirigeant avait autorisé PAR ÉCRIT la nature RAPPEL sans confirmation (§118.39). Le
 * « je ne peux pas » le plus cher est celui où rien ne manquait (§63).
 *
 * Ce banc part du VRAI point d'entrée — l'outil que le modèle appelle, puis le battement qui
 * tire les rappels — et non d'un état injecté à la main (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__canal${Date.now().toString(36)}`;
let userId = "";

const pdg = (): CurrentUser => ({
  id: userId, name: `${TAG} PDG`, email: `${TAG}@amd.dz`, role: "SUPER_ADMIN",
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

const outil = POWER_TOOLS.find((t) => t.def.name === "plan_reminder")!;

suite("le canal d'un rappel — l'e-mail différé cesse d'être « impossible »", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.assistantReminder.deleteMany({ where: { title: { startsWith: "__canal" } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: "__canal" } } }).catch(() => {});
  });

  it("« dans 2 minutes, par e-mail » se planifie — l'outil ne refuse rien", async () => {
    const out = JSON.parse(await outil.run(
      { title: `${TAG} réveil`, quand: "dans 2 minutes", canal: "email" }, pdg(),
    ));
    expect(out.cree, "le rappel n'a pas été créé").toBeTruthy();
    expect(out.canal).toBe("e-mail");
    const lu = await prisma.assistantReminder.findUnique({ where: { id: out.cree }, select: { channel: true, dueAt: true } });
    expect(lu!.channel).toBe("EMAIL");
    // À la minute près : c'est ce que « dans 2 minutes » exige, et ce que l'ordonnanceur sait faire.
    const dansCombien = lu!.dueAt.getTime() - Date.now();
    expect(dansCombien).toBeGreaterThan(30_000);
    expect(dansCombien).toBeLessThan(4 * 60_000);
  });

  it("un canal non reconnu retombe sur la NOTIFICATION — on ne devine jamais un envoi", async () => {
    const out = JSON.parse(await outil.run(
      { title: `${TAG} douteux`, quand: "dans 10 minutes", canal: "pigeon voyageur" }, pdg(),
    ));
    const lu = await prisma.assistantReminder.findUnique({ where: { id: out.cree }, select: { channel: true } });
    expect(lu!.channel, "un e-mail parti par mauvaise lecture ne se rattrape pas").toBe("NOTIFICATION");
  });

  it("au TIR : sans adresse déclarée, l'e-mail ne part pas — et la notification le DIT", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : avaler l'échec. Un e-mail promis, jamais reçu, sans un
     * mot, est exactement ce que la personne a reproché (« je t'avais dit de me rappeler […]
     * mais tu l'as pas fait »). Le compte de ce banc n'a ni règle `canalPrefere` ni boîte
     * connectée : l'envoi ne peut pas aboutir, et c'est ce cas-là qui doit parler.
     */
    const t0 = new Date(Date.now() - 60_000);
    await prisma.assistantReminder.create({
      data: { userId, title: `${TAG} par mail`, dueAt: t0, recurrence: "NONE", channel: "EMAIL" },
    });
    await runAssistantReminders(new Date());
    const notif = await prisma.notification.findFirst({
      where: { userId, title: { contains: "par mail" } },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    });
    expect(notif, "le rappel a disparu en silence").toBeTruthy();
    expect(notif!.body ?? "").toMatch(/E-mail non envoyé/);
  });

  it("un rappel NOTIFICATION reste exactement ce qu'il était — rien n'a bougé sous les pieds", async () => {
    await prisma.assistantReminder.create({
      data: { userId, title: `${TAG} classique`, dueAt: new Date(Date.now() - 60_000), recurrence: "NONE", note: "debout" },
    });
    await runAssistantReminders(new Date());
    const notif = await prisma.notification.findFirst({
      where: { userId, title: { contains: "classique" } },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    });
    expect(notif!.body).toBe("debout");
  });
});
