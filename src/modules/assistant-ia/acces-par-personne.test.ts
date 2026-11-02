import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, peutUtiliserAssistantIA, peutVoirAdam } from "@/lib/rbac";
import { isDelegatable } from "@/lib/hr/stand-in";
import type { CurrentUser } from "@/lib/session";
import { outilsV1 } from "./infra/outils-v1";
import { adapterOutil, outilsPour } from "./infra/outils";

/**
 * L'ASSISTANT IA, OUVERT À UNE PERSONNE — sur la vraie base de test (Q17), sans Prisma simulé.
 *
 * Ce qu'on prouve : fermé par défaut à tout autre que le Super Admin ; ouvert à UNE personne par
 * son accès (Administration › Accès), il lui offre les outils de SON rôle et rien d'autre, refuse à
 * l'exécution un outil que son rôle n'ouvre pas, et n'ouvre pas Adam pour autant. L'assistante de
 * direction n'a pas l'annuaire du personnel (RH) : l'assistant ne le lui donne pas.
 */
const TAG = `__assistantia_${Date.now()}_`;
let superAdmin: CurrentUser;
let assistanteFermee: CurrentUser;
let assistanteOuverte: CurrentUser;

async function personne(nom: string, role: UserRole, ouvrir = false): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  if (ouvrir) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

beforeAll(async () => {
  superAdmin = await personne("sa", "SUPER_ADMIN");
  assistanteFermee = await personne("ad-fermee", "DIRECTION_ASSISTANT");
  assistanteOuverte = await personne("ad-ouverte", "DIRECTION_ASSISTANT", true);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
});

const nomsOfferts = (u: CurrentUser) => Object.keys(outilsPour(outilsV1(u, []), u)).sort();

describe("qui a l'Assistant IA", () => {
  it("le Super Admin d'office ; une autre personne seulement si on le lui ouvre", () => {
    expect(peutUtiliserAssistantIA(superAdmin)).toBe(true);
    expect(peutUtiliserAssistantIA(assistanteFermee)).toBe(false);
    expect(peutUtiliserAssistantIA(assistanteOuverte)).toBe(true);
  });

  it("ouvrir l'Assistant IA n'ouvre pas Adam", () => {
    expect(peutVoirAdam(assistanteOuverte)).toBe(false);
  });

  it("un intérim ne le prête jamais : l'assistant parle au nom de son utilisateur", () => {
    expect(isDelegatable("ASSISTANT_IA")).toBe(false);
  });
});

describe("ce que l'assistant offre à la personne — ses droits, pas ceux du Super Admin", () => {
  it("chaque outil offert est un outil que SON rôle ouvre", () => {
    const outils = outilsV1(assistanteOuverte, []);
    const offerts = new Set(nomsOfferts(assistanteOuverte));
    for (const o of outils) expect(offerts.has(o.def.name), o.def.name).toBe(o.allowed(assistanteOuverte));
  });

  it("l'assistante de direction n'a ni l'annuaire du personnel (RH) ni le portefeuille réglementaire", () => {
    const offerts = nomsOfferts(assistanteOuverte);
    for (const ferme of ["directory_list", "regulatory_portfolio", "regulatory_workload"]) expect(offerts, ferme).not.toContain(ferme);
    // …que le Super Admin, lui, a : la différence vient bien du rôle.
    expect(nomsOfferts(superAdmin)).toEqual(expect.arrayContaining(["directory_list", "regulatory_portfolio"]));
  });

  it("un outil que son rôle n'ouvre pas est REFUSÉ à l'exécution, même appelé de force", async () => {
    const annuaireRh = outilsV1(superAdmin, []).find((o) => o.def.name === "directory_list");
    expect(annuaireRh, "PRÉMISSE : l'outil existe").toBeTruthy();
    expect(annuaireRh!.allowed(assistanteOuverte)).toBe(false);
    const outil = adapterOutil(annuaireRh!, assistanteOuverte);
    const sortie = await (outil.execute as (e: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(String(sortie)).toMatch(/pas ouvert|refus/i);
  });
});
