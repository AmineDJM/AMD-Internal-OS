import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module } from "@/lib/rbac";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { AssistantRoleConfig } from "@prisma/client";
import { compileContext } from "@/lib/agent/contexte";
import { creerAgent, repondre } from "@/lib/agent/agent";
import { outilsPour } from "@/lib/agent/outils";
import { outilCreerTache, outilEnvoyerMessage, executerActionConfirmee } from "@/lib/agent/ecritures";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";

// Mock hoisté des dépendances Prisma et actions
const { mockPrisma, mockCreateTaskRecord, mockFindDirectConversation } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    regulatoryDossier: {
      findUnique: vi.fn(),
    },
    assistantRoleConfig: {
      findUnique: vi.fn(),
    },
    assistantActionIntent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      create: vi.fn(),
    },
    message: {
      create: vi.fn(),
    },
    assistantMemoryItem: {
      findMany: vi.fn(),
    },
    assistantMessage: {
      findMany: vi.fn(),
    },
  },
  mockCreateTaskRecord: vi.fn(),
  mockFindDirectConversation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tasks/create-core", () => ({
  createTaskRecord: (...args: unknown[]) => mockCreateTaskRecord(...args),
}));

vi.mock("@/lib/messaging", () => ({
  findDirectConversation: (...args: unknown[]) => mockFindDirectConversation(...args),
}));

function creerUtilisateur(role: string, modules: Module[] = []): CurrentUser {
  const mapModules = new Map();
  for (const m of modules) {
    mapModules.set(m, {
      actions: new Set(["VIEW", "CREATE", "UPDATE"]),
      scope: "ALL",
    });
  }

  const access: EffectiveAccess = {
    modules: mapModules,
    rowGrants: new Map(),
    role: role as never,
  };

  return {
    id: `u-${role.toLowerCase()}`,
    name: `Dr. ${role}`,
    email: `${role.toLowerCase()}@adventum.dz`,
    role: role as never,
    access,
    mustChangePassword: false,
  };
}

describe("Intégration Complète de l'Agent IA — Pré-Jalon 6", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.assistantMemoryItem.findMany.mockResolvedValue([]);
    mockPrisma.assistantMessage.findMany.mockResolvedValue([]);
    mockPrisma.assistantActionIntent.findMany.mockResolvedValue([]);
  });

  describe("1. Cycle de Consultation (Lecture avec Contexte Déterministe)", () => {
    it("compile le contexte d'écran, respecte le rôle et exécute un outil de lecture", async () => {
      const user = creerUtilisateur("HEAD_OF_REGULATORY", ["REGULATORY", "REGULATORY_PIPELINE"]);
      mockPrisma.regulatoryDossier.findUnique.mockResolvedValue({
        reference: "DOS-2026-001",
        title: "Enregistrement Biocare 500mg",
        procedureType: "NATIONAL",
        status: "EN_INSTRUCTION",
      });

      const roleConfig: AssistantRoleConfig = {
        role: "HEAD_OF_REGULATORY",
        assistantName: "Atlas Réglementaire",
        tone: "Précis, scientifique et formel",
        customInstructions: "Toujours vérifier le calendrier de renouvellement des AMM.",
        allowedTools: ["regulatory_summary"],
        confirmationLevel: "CRITIQUE",
        enforcedModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const contexte = await compileContext({
        user,
        page: {
          pathname: "/dossiers/dos-1",
          objetType: "DOSSIER",
          objetId: "dos-1",
        },
        consignesRole: roleConfig.customInstructions ?? undefined,
      });

      expect(contexte.systemPrompt).toContain("fuseau Africa/Algiers");
      expect(contexte.systemPrompt).toContain("Dr. HEAD_OF_REGULATORY");
      expect(contexte.systemPrompt).toContain("DOS-2026-001");
      expect(contexte.systemPrompt).toContain("Enregistrement Biocare 500mg");
      expect(contexte.systemPrompt).toContain("Toujours vérifier le calendrier de renouvellement des AMM.");

      const outilLecture: PowerTool = {
        def: {
          name: "regulatory_summary",
          description: "Donne l'état d'avancement du dossier.",
          input_schema: { type: "object", properties: { dossierId: { type: "string" } } },
        } as PowerTool["def"],
        allowed: (u) => u.role === "HEAD_OF_REGULATORY",
        run: async () => JSON.stringify({ phase: "Évaluation technique", echeance: "2026-12-01" }),
      };

      const { modele } = modeleFactice([
        { appel: { outil: "regulatory_summary", entree: { dossierId: "dos-1" } } },
        { texte: "Le dossier Biocare 500mg est en évaluation technique jusqu'au 1er décembre 2026." },
      ]);

      const agent = creerAgent({
        user,
        modele: modele as never,
        outils: [outilLecture],
        instructions: contexte.systemPrompt,
        config: roleConfig,
      });

      const reponse = await repondre(agent, "Quel est l'état du dossier ?");

      expect(reponse.outilsAppeles).toEqual(["regulatory_summary"]);
      expect(reponse.texte).toBe("Le dossier Biocare 500mg est en évaluation technique jusqu'au 1er décembre 2026.");
    });
  });

  describe("2. Cycle d'Écriture Protégée (Tâche) : Proposition IA puis Confirmation Humaine", () => {
    it("prépare une proposition de tâche sans écriture directe, puis l'exécute de façon idempotente après validation", async () => {
      const user = creerUtilisateur("DIRECTION", ["WORKSPACE"]);
      const intentCree = {
        id: "intent-tache-123",
        userId: user.id,
        kind: "create_task",
        module: "WORKSPACE",
        title: 'Créer la tâche : "Soumettre variation module 3"',
        status: "PROPOSED",
        payload: {
          title: "Soumettre variation module 3",
          assignedToId: user.id,
          priority: "HIGH",
          dueDate: "2026-11-15",
          description: "Dépôt des pièces complémentaires auprès du LNCPP",
        },
        events: [],
      };

      let statutCourant = "PROPOSED";
      mockPrisma.assistantActionIntent.create.mockResolvedValue({ id: intentCree.id });
      mockPrisma.assistantActionIntent.findFirst.mockImplementation(async () => ({
        ...intentCree,
        status: statutCourant,
        resultMessage: statutCourant === "EXECUTED" ? "Tâche « Soumettre variation module 3 » créée avec succès." : undefined,
        resultLink: statutCourant === "EXECUTED" ? "/mon-espace/taches?id=task-real-1" : undefined,
      }));

      mockPrisma.assistantActionIntent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.assistantActionIntent.update.mockImplementation(async () => {
        statutCourant = "EXECUTED";
        return {};
      });
      mockCreateTaskRecord.mockResolvedValue({ id: "task-real-1", mode: "SELF" });

      const { modele } = modeleFactice([
        {
          appel: {
            outil: "create_task",
            entree: {
              title: "Soumettre variation module 3",
              priority: "HIGH",
              dueDate: "2026-11-15",
              description: "Dépôt des pièces complémentaires auprès du LNCPP",
            },
          },
        },
        {
          texte: "J'ai préparé la proposition de tâche. Veuillez confirmer son enregistrement ci-dessous.",
        },
      ]);

      const agent = creerAgent({
        user,
        modele: modele as never,
        outils: [outilCreerTache],
      });

      // Étape A : L'agent propose l'action
      const reponseAgent = await repondre(agent, "Crée une tâche urgente pour soumettre la variation.");

      expect(reponseAgent.outilsAppeles).toEqual(["create_task"]);
      expect(mockPrisma.assistantActionIntent.create).toHaveBeenCalledTimes(1);
      // La tâche réelle N'A PAS encore été créée !
      expect(mockCreateTaskRecord).not.toHaveBeenCalled();

      // Étape B : L'humain clique sur « Confirmer »
      const resultatExec = await executerActionConfirmee(intentCree.id, user);

      expect(resultatExec.ok).toBe(true);
      expect(resultatExec.message).toContain("créée avec succès");
      expect(mockCreateTaskRecord).toHaveBeenCalledTimes(1);
      expect(mockCreateTaskRecord).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({
          title: "Soumettre variation module 3",
          priority: "HIGH",
        }),
        expect.anything()
      );

      // Étape C : Replay / Double-clic de confirmation (Idempotence)
      const resultatReplay = await executerActionConfirmee(intentCree.id, user);

      expect(resultatReplay.ok).toBe(true);
      expect(resultatReplay.alreadyExecuted).toBe(true);
      // La tâche n'a pas été dupliquée !
      expect(mockCreateTaskRecord).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Cycle d'Écriture Protégée (Message Interne) : Proposition IA puis Confirmation Humaine", () => {
    it("prépare l'envoi d'un message direct, vérifie l'existence du destinataire et ne l'envoie qu'après confirmation", async () => {
      const expediteur = creerUtilisateur("DIRECTION", ["MESSAGING"]);
      const destinataire = { id: "u-amine", name: "Amine Djouamai", isActive: true };

      mockPrisma.user.findUnique.mockResolvedValue(destinataire);
      const intentMsg = {
        id: "intent-msg-456",
        userId: expediteur.id,
        kind: "send_message",
        module: "MESSAGING",
        title: "Message pour Amine Djouamai",
        status: "PROPOSED",
        payload: {
          destinataireId: "u-amine",
          body: "Dossier validé par le comité d'enregistrement.",
        },
        events: [],
      };

      mockPrisma.assistantActionIntent.create.mockResolvedValue({ id: intentMsg.id });
      mockPrisma.assistantActionIntent.findFirst.mockResolvedValue(intentMsg);
      mockPrisma.assistantActionIntent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.assistantActionIntent.update.mockResolvedValue({});
      mockFindDirectConversation.mockResolvedValue("conv-directe-1");
      mockPrisma.message.create.mockResolvedValue({ id: "msg-real-1" });

      const { modele } = modeleFactice([
        {
          appel: {
            outil: "send_message",
            entree: {
              destinataireId: "u-amine",
              body: "Dossier validé par le comité d'enregistrement.",
            },
          },
        },
        {
          texte: "La proposition d'envoi de message à Amine Djouamai est prête à être confirmée.",
        },
      ]);

      const agent = creerAgent({
        user: expediteur,
        modele: modele as never,
        outils: [outilEnvoyerMessage],
      });

      // Étape A : Proposition
      const tour = await repondre(agent, "Envoie un mot à Amine");
      expect(tour.outilsAppeles).toEqual(["send_message"]);
      expect(mockPrisma.message.create).not.toHaveBeenCalled();

      // Étape B : Confirmation humaine
      const resultat = await executerActionConfirmee(intentMsg.id, expediteur);
      expect(resultat.ok).toBe(true);
      expect(resultat.message).toContain("Message envoyé avec succès");
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: "conv-directe-1",
          senderId: expediteur.id,
          body: "Dossier validé par le comité d'enregistrement.",
          kind: "TEXT",
        },
        select: { id: true },
      });
    });
  });

  describe("4. Plafond RBAC et Sécurité de Rôle", () => {
    it("ne permet jamais à une configuration de rôle d'élargir l'accès au-delà du RBAC", () => {
      // Utilisateur sans droit finances
      const user = creerUtilisateur("STAGIAIRE", ["WORKSPACE"]);

      const outilWorkspace: PowerTool = {
        def: { name: "create_task", description: "...", input_schema: { type: "object" } } as PowerTool["def"],
        allowed: (u) => u.access.modules.has("WORKSPACE" as Module),
        run: async () => "ok",
      };

      const outilFinance: PowerTool = {
        def: { name: "voir_tresorerie", description: "...", input_schema: { type: "object" } } as PowerTool["def"],
        allowed: (u) => u.access.modules.has("FINANCE" as Module),
        run: async () => "1 000 000 DZD",
      };

      // La config de rôle prétend ouvrir les deux outils
      const roleConfig: AssistantRoleConfig = {
        role: "STAGIAIRE" as never,
        assistantName: "Assistant Stagiaire",
        tone: "Pédagogique",
        customInstructions: null,
        allowedTools: ["create_task", "voir_tresorerie"],
        confirmationLevel: "CRITIQUE",
        enforcedModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Les outils offerts à CET utilisateur ne contiennent QUE create_task, voir_tresorerie est banni par RBAC
      const outilsOfferts = outilsPour([outilWorkspace, outilFinance], user, roleConfig);
      expect(Object.keys(outilsOfferts)).toEqual(["create_task"]);
      expect(outilsOfferts["voir_tresorerie"]).toBeUndefined();
    });

    it("censure impérativement les données sensibles lors de la compilation de contexte", async () => {
      const user = creerUtilisateur("SUPER_ADMIN", ["EMPLOYEES"]);

      const contexte = await compileContext({
        user,
        page: {
          pathname: "/rh/employe/1",
          donneesObjet: {
            nom: "Salim Benali",
            salaire: "180 000 DZD net mensuel",
            rib: "002 00123 4567890123 45",
            cni: "123456789012345678",
          },
        },
      });

      expect(contexte.systemPrompt).not.toContain("180 000 DZD");
      expect(contexte.systemPrompt).not.toContain("002 00123 4567890123 45");
      expect(contexte.systemPrompt).not.toContain("123456789012345678");
      expect(contexte.systemPrompt).toContain("[CONFIDENTIEL]");
      expect(contexte.provenance.censureAppliquee).toBe(true);
    });
  });
});
