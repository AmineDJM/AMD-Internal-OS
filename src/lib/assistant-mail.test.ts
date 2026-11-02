import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { buildProposal, performAction, executeReadTool } from "./assistant";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__mailasst__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Assistant IA — outils e-mail (Courrier)", () => {
  let user: CurrentUser;

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}user`, email: `${TAG}u@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } });
    user = await actorFor(u.id, "MEDICAL_DELEGATE"); // utilisateur SANS boîte mail connectée
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /**
   * CES DEUX CAS ONT CHANGÉ DE CONTRAT — volontairement, et il faut dire pourquoi.
   *
   * `send_email` fabriquait autrefois sa PROPRE carte et expédiait par le SMTP du module
   * Courrier, hors de l'intention canonique : ni empreinte de contenu approuvé, ni approbateur
   * enregistré, ni relecture de `MAIL_SEND_POLICY`. C'était la seconde route d'envoi dont le
   * système affirmait qu'elle n'existait pas — et c'est elle qui a fait afficher au PDG une carte
   * « De : sa propre adresse » alors qu'Adam a la sienne.
   *
   * Ce que ces cas PROTÉGEAIENT — « jamais d'envoi fantôme » — reste protégé, et plus fortement :
   * sans identité d'envoi autorisée, il n'y a plus de carte du tout, donc rien à confirmer par
   * mégarde. Seule l'affirmation sur le CHEMIN a changé.
   */
  it("send_email : SANS identité d'envoi autorisée, aucune carte n'est proposée", async () => {
    // Ce compte n'a aucune connexion Google : Adam n'a pas d'adresse pour lui.
    const p = await buildProposal("send_email", { to: "contact@pch.dz", subject: "Relance", body: "Bonjour, où en est notre commande ?" }, user);
    expect("error" in p).toBe(true);
    if (!("error" in p)) return;
    // Le message DIT quoi faire, au lieu de proposer une autre boîte.
    expect(p.error).toMatch(/Aucune adresse d'envoi/i);
    expect(p.error).toMatch(/Réglages/i);
  });

  it("send_email : refuse une adresse invalide ou un corps vide", async () => {
    expect("error" in (await buildProposal("send_email", { to: "pas-une-adresse", subject: "x", body: "y" }, user))).toBe(true);
    expect("error" in (await buildProposal("send_email", { to: "ok@x.dz", subject: "x", body: "" }, user))).toBe(true);
  });

  it("send_email : l'ANCIENNE carte SMTP n'expédie plus rien (jamais d'envoi fantôme)", async () => {
    const r = await performAction(user, { kind: "send_email", to: "contact@pch.dz", subject: "Test", body: "Corps" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/n'expédie plus rien/i);
  });

  it("list_emails / read_email : message clair quand aucune boîte n'est connectée", async () => {
    expect(await executeReadTool("list_emails", {}, user)).toMatch(/Aucune boîte mail connectée/i);
    expect(await executeReadTool("read_email", { uid: 1 }, user)).toMatch(/Aucune boîte mail connectée/i);
  });
});
