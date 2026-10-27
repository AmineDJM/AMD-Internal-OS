import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { compileContext } from "@/lib/agent/contexte";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import {
  ajouterMemoire, effacerMemoire, listerMemoire, modifierMemoire, toutEffacerMemoire,
} from "@/lib/agent/memoire";

/**
 * LA MÉMOIRE PERSONNELLE — sur la vraie base : à la personne seule, rien de sensible, effaçable.
 */
const TAG = `__memoire_${Date.now()}_`;
let moi = "";
let autre = "";

beforeAll(async () => {
  moi = (await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id;
  autre = (await prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "VIEWER" } })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
});

describe("mémoire personnelle", () => {
  it("retenir, relire, corriger, effacer — et le contexte du modèle la porte", async () => {
    const r = await ajouterMemoire(moi, "Ma société est Pharmagène", "ORGANIZATIONAL_CONTEXT");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await listerMemoire(moi)).map((e) => e.contenu)).toEqual(["Ma société est Pharmagène"]);

    const m = await modifierMemoire(moi, r.element.id, "Ma société est Adventum");
    expect(m.ok && m.element.contenu).toBe("Ma société est Adventum");

    const u = await prisma.user.findUniqueOrThrow({ where: { id: moi } });
    const access = await getAccess(u.id, u.role);
    const { systemPrompt } = await compileContext({ user: { ...u, access, mustChangePassword: false } as unknown as CurrentUser });
    expect(systemPrompt).toContain("Ma société est Adventum");

    expect(await effacerMemoire(moi, r.element.id)).toBe(true);
    expect(await listerMemoire(moi)).toEqual([]);
    expect(await prisma.assistantMemoryItem.count({ where: { id: r.element.id } })).toBe(0);
  });

  it("un doublon n'est pas créé deux fois", async () => {
    await ajouterMemoire(moi, "Je suis les produits de cardiologie", "USER_PREFERENCE");
    await ajouterMemoire(moi, "je suis les produits de CARDIOLOGIE", "USER_PREFERENCE");
    expect((await listerMemoire(moi)).length).toBe(1);
    await toutEffacerMemoire(moi);
  });

  it("rien de sensible n'y entre : salaire, IBAN, pièce d'identité", async () => {
    for (const s of ["Mon salaire de base est 180 000 DZD", "Mon IBAN est DZ5900010002000300040005", "Mon passeport : 123456789"]) {
      const r = await ajouterMemoire(moi, s, "USER_PREFERENCE");
      expect(r.ok, s).toBe(false);
    }
    expect(await listerMemoire(moi)).toEqual([]);
  });

  it("jamais partagée : l'élément d'un autre ne se lit, ne se corrige ni ne s'efface", async () => {
    const r = await ajouterMemoire(autre, "Préférence de l'autre", "USER_PREFERENCE");
    if (!r.ok) throw new Error("prémisse");
    expect(await listerMemoire(moi)).toEqual([]);
    expect((await modifierMemoire(moi, r.element.id, "piraté")).ok).toBe(false);
    expect(await effacerMemoire(moi, r.element.id)).toBe(false);
    expect((await listerMemoire(autre))[0]?.contenu).toBe("Préférence de l'autre");
  });
});
