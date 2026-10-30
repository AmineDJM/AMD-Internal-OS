import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FORMULAIRE DE LA CARTE, CONTRE LA VRAIE BASE (lot J11, décision 0030).
 *
 *   • la carte d'une capacité porte son formulaire (proposition pré-remplie, référence NOMMÉE) ;
 *   • la personne CORRIGE puis signe : l'action s'exécute sur l'entrée corrigée, jamais sur la proposition ;
 *   • une correction hors schéma (type, obligatoire vidé) n'exécute rien, et le dit ;
 *   • une carte renforcée corrigée se ressaisit sur la valeur corrigée ;
 *   • le sélecteur d'une référence ne rend que ce que la personne voit, et seulement pour un champ de SA carte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { chercherReferenceCarteAssistantIA, confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { entreeDepuisSaisies, saisiesInitiales } from "@/platform/ia/capacites/formulaire";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaform_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let karim: CurrentUser;
let samia: CurrentUser;

async function compte(nom: string, role: "SUPER_ADMIN" | "VIEWER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const outil = (u: CurrentUser, nom: string, props: PropositionPreparee[]) => {
  const o = outilsV1(u, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === nom);
  if (!o) throw new Error(`capacité ${nom} absente pour ${u.role}`);
  return o;
};

suite("le formulaire de la carte (J11)", () => {
  beforeAll(async () => {
    sa = await compte("Admin", "SUPER_ADMIN");
    karim = await compte("Karim", "VIEWER");
    samia = await compte("Samia", "VIEWER");
  });
  afterAll(async () => {
    const ids = [sa?.id, karim?.id, samia?.id].filter(Boolean) as string[];
    await prisma.task.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la carte porte le formulaire du contrat ; corrigée (titre, responsable) puis signée, l'action crée la version CORRIGÉE", async () => {
    ACTEUR = sa;
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__createTask", props).run({ title: `Stand ${TAG}`, assignedToId: `Karim ${TAG}` }, sa);
    const f = props[0]!.proposition.formulaire!;
    expect(f.capacite).toBe("task-actions:createTask");
    const responsable = f.champs.find((c) => c.nom === "assignedToId")!;
    expect(responsable).toMatchObject({ widget: "reference", modele: "User", propose: karim.id });
    expect(responsable.etiquettes[karim.id]).toContain("Karim");
    expect(f.champs.find((c) => c.nom === "title")).toMatchObject({ widget: "texte", obligatoire: true, propose: `Stand ${TAG}` });

    // Le sélecteur : la personne cherche « Samia » — l'annuaire la rend.
    const s = await chercherReferenceCarteAssistantIA(props[0]!.intentId, "assignedToId", `Samia ${TAG}`);
    expect(s.ok && s.options.map((o) => o.id)).toEqual([samia.id]);

    const saisies = { ...saisiesInitiales(f), title: `Stand du congrès d'Oran ${TAG}`, assignedToId: samia.id };
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId, undefined, JSON.stringify(entreeDepuisSaisies(f, saisies)));
    expect(r.ok, r.error).toBe(true);
    const t = await prisma.task.findFirstOrThrow({ where: { title: { contains: TAG } }, select: { title: true, assignedToId: true } });
    expect(t).toEqual({ title: `Stand du congrès d'Oran ${TAG}`, assignedToId: samia.id });
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } });
    expect(JSON.stringify(intent.events)).toContain("CORRECTED");
    expect(intent.payload).toMatchObject({ entree: { assignedToId: samia.id } });
  });

  it("une correction hors schéma (obligatoire vidé, champ inconnu) n'exécute rien et le dit", async () => {
    ACTEUR = sa;
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__createTask", props).run({ title: `Vide ${TAG}` }, sa);
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId, undefined, JSON.stringify({ description: "plus de titre" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/titre/i);
    expect(await prisma.task.count({ where: { title: `Vide ${TAG}` } })).toBe(0);
    expect((await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } })).status).toBe("PROPOSED");
  });

  it("le sélecteur refuse un champ qui n'est pas une référence, et la carte d'un autre", async () => {
    ACTEUR = sa;
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__createTask", props).run({ title: `Autre ${TAG}` }, sa);
    expect((await chercherReferenceCarteAssistantIA(props[0]!.intentId, "title", "abc")).ok).toBe(false);
    ACTEUR = karim;
    expect((await chercherReferenceCarteAssistantIA(props[0]!.intentId, "assignedToId", "Samia")).ok).toBe(false);
  });

  it("une carte RENFORCÉE corrigée se ressaisit sur la valeur corrigée (le verbe, ici) ; la mauvaise ressaisie n'exécute rien", async () => {
    ACTEUR = sa;
    const tache = await prisma.task.create({ data: { title: `À supprimer ${TAG}`, createdById: sa.id }, select: { id: true } });
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__deleteTask", props).run({ id: tache.id }, sa);
    const f = props[0]!.proposition.formulaire!;
    expect(props[0]!.proposition.confirmText).toBe("SUPPRIMER");
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId, "non", JSON.stringify(entreeDepuisSaisies(f, saisiesInitiales(f))));
    expect(r.ok).toBe(false);
    expect(await prisma.task.count({ where: { id: tache.id } })).toBe(1);
    const ok = await confirmerIntentionAssistantIA(props[0]!.intentId, "supprimer", JSON.stringify(entreeDepuisSaisies(f, saisiesInitiales(f))));
    expect(ok.ok, ok.error).toBe(true);
    expect(await prisma.task.count({ where: { id: tache.id } })).toBe(0);
  });
});
