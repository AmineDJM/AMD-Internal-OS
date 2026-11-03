import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import {
  ADAM_EMAIL, SANS_MOT_DE_PASSE, assurerCompteAgent, estCompteSysteme, idCompteAgent, peutSeConnecter,
} from "@/lib/missions/agent/account";
import { agentPour, humainPour, verifierAvantAgir } from "@/lib/missions/agent/principal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ESPACE D'ADAM — présent, complet, et sans porte d'entrée.
 *
 * Ce fichier vérifie les DEUX moitiés de la demande en même temps, parce qu'elles se tiennent :
 * un compte réel avec les pleins accès d'exécution, ET l'impossibilité structurelle de s'en
 * servir autrement que par le Mission Runtime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

let cree = false;

const comptes = comptesDeBanc("__agentcompte_");

suite("l'espace d'Adam dans l'ERP", () => {
  beforeAll(async () => {
    const avant = await idCompteAgent();
    cree = avant === null;
  }, 60_000);

  afterAll(async () => {
    await comptes.retirer();
    // On ne supprime le compte QUE si ce banc l'a créé : sur une base où Adam travaille déjà,
    // l'effacer emporterait ses missions en cascade.
    if (cree) {
      await prisma.user.deleteMany({ where: { email: ADAM_EMAIL, isSystem: true } }).catch(() => {});
    }
  }, 60_000);

  it("le compte EXISTE avec les pleins accès d'exécution", async () => {
    const c = await assurerCompteAgent();
    expect(c, "l'espace d'Adam n'a pas pu être garanti").not.toBeNull();

    const u = await prisma.user.findUnique({
      where: { id: c!.id },
      select: { role: true, isActive: true, isSystem: true, name: true, title: true },
    });
    expect(u!.role, "sans SUPER_ADMIN, Adam ne pourrait exécuter que la moitié des missions").toBe("SUPER_ADMIN");
    expect(u!.isActive).toBe(true);
    expect(u!.isSystem).toBe(true);
    expect(u!.name).toBe("Adam");
  }, 60_000);

  it("AUCUN mot de passe ne l'ouvre — et le condensat n'en est pas un", async () => {
    const c = await assurerCompteAgent();
    const u = await prisma.user.findUnique({ where: { id: c!.id }, select: { passwordHash: true } });
    expect(u!.passwordHash).toBe(SANS_MOT_DE_PASSE);

    // La VÉRIFICATION qui compte : `bcrypt.compare` doit rendre faux, pas lever. Un condensat
    // mal formé qui ferait lever produirait une erreur 500 au lieu d'un refus propre.
    for (const essai of ["", "adam", "SANS_MOT_DE_PASSE", SANS_MOT_DE_PASSE, "Adventum2026!"]) {
      await expect(bcrypt.compare(essai, u!.passwordHash), essai).resolves.toBe(false);
    }
  }, 60_000);

  it("LA RÉPARATION remet en place ce qu'on aurait défait — et le DIT", async () => {
    const c = await assurerCompteAgent();
    // On simule trois dérives : un rôle abaissé, un compte désactivé, un mot de passe posé.
    await prisma.user.update({
      where: { id: c!.id },
      data: { role: "VIEWER", isActive: false, passwordHash: await bcrypt.hash("intrus", 4) },
    });

    const repare = await assurerCompteAgent();
    expect(repare!.corrections.length).toBe(3);
    expect(repare!.corrections.join(" ")).toMatch(/rôle rétabli/);
    expect(repare!.corrections.join(" ")).toMatch(/réactivé/);
    expect(repare!.corrections.join(" ")).toMatch(/mot de passe retiré/);

    const u = await prisma.user.findUnique({
      where: { id: c!.id },
      select: { role: true, isActive: true, passwordHash: true },
    });
    expect(u!.role).toBe("SUPER_ADMIN");
    expect(u!.isActive).toBe(true);
    expect(u!.passwordHash).toBe(SANS_MOT_DE_PASSE);
  }, 60_000);

  it("le compte est RECONNU comme système — ce que les écrans consultent pour refuser", async () => {
    const c = await assurerCompteAgent();
    expect(await estCompteSysteme(c!.id)).toBe(true);

    // Une personne À CE BANC : empruntée, elle pouvait disparaître avant d'être lue — et le test le prendrait pour un refus.
    const humain = await comptes.creer("humain");
    expect(await estCompteSysteme(humain.id)).toBe(false);
  }, 60_000);

  it("MALGRÉ SUPER_ADMIN, Adam ne peut PAS toucher aux droits — et la personne, si", async () => {
    const c = await assurerCompteAgent();
    const adam = agentPour({ initiatedBy: c!.id, executedBy: c!.id, label: "le PDG" });
    const pdg = humainPour(c!.id, "le PDG");

    // C'est le cœur de la réconciliation : le rôle donne les pleins pouvoirs d'EXÉCUTION, le
    // drapeau d'agent RETIRE la sécurité. Le même compte, sans le drapeau, y aurait droit.
    for (const interdit of ["grant_permission", "update_role", "create_user", "set_api_key", "disable_guard"]) {
      expect(verifierAvantAgir(interdit, "SECURITY_ADMIN", adam).ok, interdit).toBe(false);
    }
    expect(verifierAvantAgir("grant_permission", "SECURITY_ADMIN", pdg).ok).toBe(true);

    // Et les capacités MÉTIER, elles, restent ouvertes : l'interdit est ciblé, pas général.
    for (const permis of ["send_message", "create_task", "directory_list", "send_email"]) {
      expect(verifierAvantAgir(permis, "EXTERNAL_COMMUNICATION", adam).ok, permis).toBe(true);
    }
  }, 60_000);

  it("LA DÉCISION DE CONNEXION refuse le compte système — la garde qu'`auth.ts` appelle", async () => {
    const c = await assurerCompteAgent();
    const adam = await prisma.user.findUnique({
      where: { id: c!.id }, select: { isActive: true, isSystem: true },
    });

    expect(peutSeConnecter(adam), "un compte système ne se connecte JAMAIS").toBe(false);
    expect(peutSeConnecter({ isActive: true, isSystem: false })).toBe(true);
    expect(peutSeConnecter({ isActive: false, isSystem: false })).toBe(false);
    expect(peutSeConnecter(null)).toBe(false);
    // Le compte système reste refusé MÊME actif : ce n'est pas une désactivation déguisée.
    expect(peutSeConnecter({ isActive: true, isSystem: true })).toBe(false);
  }, 60_000);

  it("appeler `assurerCompteAgent` deux fois ne crée pas deux Adam", async () => {
    const a = await assurerCompteAgent();
    const b = await assurerCompteAgent();
    expect(b!.id).toBe(a!.id);
    expect(await prisma.user.count({ where: { email: ADAM_EMAIL } })).toBe(1);
  }, 60_000);
});
