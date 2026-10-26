import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { censurerSortie, outilsV1, type PropositionPreparee } from "@/lib/agent/outils-v1";

/**
 * LES OUTILS V1 SUR LA VRAIE BASE DE TEST (Q17) — sans Prisma simulé.
 *
 * Ce qu'on prouve : une écriture n'écrit RIEN avant confirmation (elle crée une intention en attente),
 * le destinataire est résolu PAR SON NOM, et un nom inconnu est refusé au lieu d'être remplacé.
 */
const TAG = `__agentv1_${Date.now()}_`;
let auteur: CurrentUser;
let destinataireId = "";

beforeAll(async () => {
  const a = await prisma.user.create({ data: { name: `${TAG}Auteur`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const d = await prisma.user.create({ data: { name: `Zéphyrine ${TAG}Destinataire`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "VIEWER" } });
  destinataireId = d.id;
  const access = await getAccess(a.id, a.role);
  auteur = { id: a.id, name: a.name, email: a.email, role: access.role ?? a.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
});

afterAll(async () => {
  await prisma.assistantActionIntent.deleteMany({ where: { userId: auteur?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
});

const outil = (nom: string, props: PropositionPreparee[]) => {
  const o = outilsV1(auteur, props).find((t) => t.def.name === nom);
  if (!o) throw new Error(`outil ${nom} absent`);
  return o;
};

describe("outils V1", () => {
  it("offre au Super Admin les lectures et les deux écritures de la V1, rien d'autre", () => {
    const noms = outilsV1(auteur, []).map((o) => o.def.name).sort();
    expect(noms).toEqual([
      "create_task", "directory_list", "directory_lookup", "list_my_tasks",
      "regulatory_knowledge", "regulatory_portfolio", "regulatory_workload", "search_products", "send_message",
    ]);
  });

  it("send_message prépare une intention SANS envoyer, destinataire résolu par son nom", async () => {
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil("send_message", props).run({ recipientName: `${TAG}Destinataire`, body: "Bonjour, test." }, auteur));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(1);
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: props[0].intentId } });
    expect(intent?.status).toBe("PROPOSED");
    expect((intent?.payload as { recipientId?: string }).recipientId).toBe(destinataireId);
    expect(await prisma.message.count({ where: { senderId: auteur.id } })).toBe(0);
  });

  it("refuse un destinataire inconnu au lieu d'en choisir un autre", async () => {
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil("send_message", props).run({ recipientName: `${TAG}Personne-Inexistante`, body: "x" }, auteur));
    expect(sortie.statut).toBe("REFUS");
    expect(props).toHaveLength(0);
  });
});

describe("censurerSortie — ce qui part au modèle", () => {
  it("masque une rémunération dans un JSON et le garde JSON", () => {
    const s = JSON.parse(censurerSortie(JSON.stringify({ nom: "A", salaire: 180000, poste: "Pharmacien" })));
    expect(s).toEqual({ nom: "A", salaire: "[CONFIDENTIEL]", poste: "Pharmacien" });
  });

  it("masque un IBAN dans un texte libre", () => {
    expect(censurerSortie("Virement : IBAN DZ5900010002000300040005")).not.toMatch(/0001000200030004/);
  });
});
