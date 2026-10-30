import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { APRES_LA_PREVALIDATION, circuitLisible, outilsV1, type PropositionPreparee } from "./outils-v1";
import { jetonnerSortie } from "../domaine/filtre-confidentialite";
import { OPERATIONS_IA } from "./operations";
import { capacitesOffertes } from "./capacites";

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
  it("offre au Super Admin les lectures et les écritures auxquelles il a droit (décision 0012), sans doublon", () => {
    const noms = outilsV1(auteur, []).map((o) => o.def.name).sort();
    // Les lectures propres au module (J6 : plus rien d'emprunté à Adam), les lectures RH (`lectures.ts`), la mémoire
    // proposée et les opérations de l'Assistant IA (le Super Admin a tout ; chacun revérifie à l'exécution).
    expect(noms).toEqual([
      "comparer_versions", "demandes_adpro", "directory_list", "directory_lookup", "documents_rh",
      "etat_dossier_reglementaire", "finance_totals", "lire_devis_facture", "lire_document", "lire_dossier_depose", "lire_fiche_rh", "lire_formulaire_pdf", "lire_paie", "list_my_requests", "list_my_tasks", "list_pending_decisions",
      "mes_brouillons", "mes_conversations", "mes_demandes_en_attente", "mes_routines", "my_overview",
      "proposer_memoire", "read_budget", "read_calendar", "read_hr_overview", "read_workflow",
      "regulatory_knowledge", "regulatory_portfolio", "regulatory_workload",
      "search_everything", "search_products", "web_research",
      // J4 : la connaissance de l'entreprise (Bibliothèque, faits confirmés — `platform/ia/lectures/connaissance.ts`).
      "chercher_documents", "ouvrir_documents", "faits_confirmes",
      // J9 : le graphe de l'entreprise et les faits datés (`platform/ia/lectures/graphe.ts`).
      "explorer_relations", "etat_a_une_date", "d_ou_vient", "recette_pour",
      // J3 — l'Atelier : ouvrir, modifier en place, convertir (l'enregistrement est une opération, `enregistrer_document`).
      "ouvrir_dans_l_atelier", "modifier_document", "convertir_document",
      // J8 — les demandes reçues du travail d'un collègue (la réponse est une opération, `preparer_reponse_demande`).
      "mes_demandes_recues",
      ...OPERATIONS_IA.map((o) => o.nom),
    ].sort());
    expect(new Set(noms).size).toBe(noms.length);
  });

  it("la conversation reçoit EN PLUS les capacités de l'ERP (J6) — toutes celles que la porte de l'écran ouvre, sans doublon", () => {
    const sans = outilsV1(auteur, []).map((o) => o.def.name);
    const avec = outilsV1(auteur, [], [], [], null, undefined, { capacites: true }).map((o) => o.def.name);
    const capacites = capacitesOffertes(auteur).map((c) => c.outil);
    expect(capacites.length).toBeGreaterThan(900);
    expect([...avec].sort()).toEqual([...sans, ...capacites].sort());
    expect(new Set(avec).size).toBe(avec.length);
    expect(avec).toEqual(expect.arrayContaining(["task__createTask", "regulatory__createRegulatoryProduct", "admin-request__createRequest", "hr__requestLeave"]));
  });

  it("send_message prépare une intention SANS envoyer, destinataire résolu par son nom", async () => {
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil("send_message", props).run({ recipientName: `${TAG}Destinataire`, body: "Bonjour, test." }, auteur));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(1);
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: props[0].intentId } });
    expect(intent?.status).toBe("PROPOSED");
    expect((intent?.payload as { args?: { userId?: string } }).args?.userId).toBe(destinataireId);
    expect(await prisma.message.count({ where: { senderId: auteur.id } })).toBe(0);
  });

  it("refuse un destinataire inconnu au lieu d'en choisir un autre", async () => {
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil("send_message", props).run({ recipientName: `${TAG}Personne-Inexistante`, body: "x" }, auteur));
    expect(["REFUS", "INCOMPLET"]).toContain(sortie.statut);
    expect(props).toHaveLength(0);
  });
});

describe("circuitLisible — un circuit expliqué se LIT, jamais de mémoire", () => {
  it("non personnalisé : les étapes viennent de la définition par défaut du moteur, rôles en clair", () => {
    const c = JSON.parse(circuitLisible(JSON.stringify({ categorie: "SPONSORING", libelle: "Sponsoring", actif: true, etapes: "Circuit PAR DÉFAUT …" })));
    expect(c.personnalise).toBe(false);
    expect(c.etapes.length).toBeGreaterThanOrEqual(3);
    expect(c.etapes[0].titre).toMatch(/National Sales/);
    expect(c.etapes.map((e: { titre: string }) => e.titre).join(" ")).toMatch(/Direction Marketing/);
    expect(c.etapes[0].qui.join(" ")).not.toMatch(/^[A-Z_]+$/);
  });

  it("personnalisé : les étapes enregistrées, sans les dictionnaires d'administration", () => {
    const c = JSON.parse(circuitLisible(JSON.stringify({ categorie: "EVENTS", libelle: "Événements", actif: true, etapes: [{ title: "Visa du chef", actorRoles: ["Direction"], optional: false }], dictionnaires: { x: 1 } })));
    expect(c).toMatchObject({ personnalise: true, etapes: [{ titre: "Visa du chef", qui: ["Direction"] }] });
    expect(JSON.stringify(c)).not.toMatch(/dictionnaires/);
  });

  it("le DG n'est pas récité comme une étape : il valide le TOTAL à la fin, au-dessus du seuil (27/10/2026)", () => {
    const parDefaut = JSON.parse(circuitLisible(JSON.stringify({ categorie: "SPONSORING", libelle: "Sponsoring", actif: true, etapes: "Circuit PAR DÉFAUT …" })));
    expect(parDefaut.etapes.map((e: { titre: string }) => e.titre).join(" ")).not.toMatch(/Directeur Général/);
    expect(parDefaut.ensuite).toBe(APRES_LA_PREVALIDATION);
    expect(parDefaut.ensuite).toMatch(/TOTAL.*seuil/);
    const enBase = JSON.parse(circuitLisible(JSON.stringify({
      categorie: "SPONSORING", libelle: "Sponsoring", actif: true,
      etapes: [{ slug: "preliminaire", title: "Approbation préliminaire (National Sales)", actorRoles: ["National Sales"] }, { slug: "dg", title: "Validation du Directeur Général", actorRoles: ["Directeur Général"] }],
    })));
    expect(enBase.etapes).toEqual([{ titre: "Approbation préliminaire (National Sales)", qui: ["National Sales"] }]);
  });

  it("une catégorie inconnue : le message du moteur passe tel quel", () => {
    expect(circuitLisible("Catégorie inconnue.")).toBe("Catégorie inconnue.");
  });
});

describe("jetonnerSortie sans coffret (routines) — ce qui part au modèle", () => {
  it("masque une rémunération dans un JSON et le garde JSON", () => {
    const s = JSON.parse(jetonnerSortie(JSON.stringify({ nom: "A", salaire: 180000, poste: "Pharmacien" }), null));
    expect(s).toEqual({ nom: "A", salaire: "[CONFIDENTIEL]", poste: "Pharmacien" });
  });

  it("masque un IBAN dans un texte libre", () => {
    expect(jetonnerSortie("Virement : IBAN DZ5900010002000300040005", null)).not.toMatch(/0001000200030004/);
  });
});
