import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { MODULES, ACTIONS } from "@/lib/rbac";
import { assistantToolsFor } from "@/lib/assistant";
import {
  REALTIME_VOICE_MODEL, VOICE_FAST_TOOL_NAMES, DELEGATE_TOOL_NAME,
  canUseRealtimeVoice, realtimeToolsFor, buildVoiceInstructions, capToolOutput,
} from "./voice-realtime";
import { createThread, appendExchange } from "@/lib/assistant-memory";

/**
 * VOIX TEMPS RÉEL — les invariants côté serveur, testés sans réseau :
 *   • la PORTE : seul le Super Admin (Adam lui est réservé, §118.153) AVEC le module
 *     CHIEF_OF_STAFF ouvre une session ;
 *   • l'ADAPTATEUR : les MÊMES PowerTools servent la voix (aucun outil dupliqué, aucun nom
 *     fantôme), filtrés par le droit du compte + l'outil de délégation ;
 *   • les INSTRUCTIONS : identité vocale, règles de fond (anti-injection), conversation
 *     récente injectée BORNÉE — et PAS le digest réglementaire géant (budget temps réel).
 */

/** Un compte à qui TOUT est ouvert — la référence de l'invariant « aucune capacité absente ». */
function superAdmin(): CurrentUser {
  const perms = Object.fromEntries(MODULES.map((m) => [m, [...ACTIONS]])) as Partial<Record<Module, Action[]>>;
  return userWith(perms, "SUPER_ADMIN", "voice-sa");
}

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id = "voice-test"): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "T", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

describe("voix temps réel — porte d'accès", () => {
  it("s'ouvre au siège exécutif AVEC le module CHIEF_OF_STAFF — et à personne d'autre", () => {
    // ADAM N'EST VISIBLE QUE DU SUPER ADMIN (§118.153) : la Direction, siège exécutif AVEC le
    // module, n'ouvre plus de session vocale — la voix est Adam, pas une fonction à part.
    expect(canUseRealtimeVoice(userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION"))).toBe(false);
    expect(canUseRealtimeVoice(userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "SUPER_ADMIN"))).toBe(true);
    // Un délégué, même avec le module par erreur : refusé (le rôle est une règle métier).
    expect(canUseRealtimeVoice(userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DELEGATE" as CurrentUser["role"]))).toBe(false);
    // Un directeur SANS le module : refusé.
    expect(canUseRealtimeVoice(userWith({}, "DIRECTION"))).toBe(false);
    // En « Vue exacte » : jamais.
    const impersonated = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "SUPER_ADMIN");
    (impersonated as { impersonatedBy?: string }).impersonatedBy = "admin-x";
    expect(canUseRealtimeVoice(impersonated)).toBe(false);
  });
});

describe("voix temps réel — adaptateur d'outils (les MÊMES outils, jamais dupliqués)", () => {
  it("chaque outil direct EXISTE dans le registre UNIFIÉ — aucun nom fantôme", () => {
    // L'INVARIANT A CHANGÉ DE SOURCE, et c'est le correctif. Il gelait « ce nom est un
    // PowerTool » — or `POWER_TOOLS` n'est qu'une PARTIE du registre : les écritures
    // (`send_email`, `create_task`) et certaines lectures (`search_people`) vivent ailleurs.
    // Vérifier contre le sous-ensemble revenait à garantir la cohérence d'une liste avec
    // elle-même, pendant que la voix perdait en silence toute capacité d'écriture.
    //
    // La référence est désormais `assistantToolsFor` — le MÊME registre que le texte.
    const registre = new Set(assistantToolsFor(superAdmin()).map((t) => t.name));
    for (const name of VOICE_FAST_TOOL_NAMES) {
      expect(registre.has(name), `${name} annoncé à la voix mais absent du registre unifié`).toBe(true);
    }
  });

  it("les écritures conversationnelles sont ANNONCÉES à la voix — la panne de production", () => {
    // « Envoie un mail à Alla lui disant salut j'espère que tu vas bien » → « Je ne peux pas
    // l'envoyer, il manque l'action d'envoi d'e-mail dans les fonctions disponibles. »
    // Adam disait vrai : la liste vocale ne contenait que des lectures. Et il ne pouvait pas
    // déléguer non plus, la consigne le lui interdisant pour un niveau B.
    const names = realtimeToolsFor(superAdmin()).map((t) => t.name);
    expect(names).toContain("send_email");
    expect(names).toContain("create_task");
    // La résolution de personne EN DIRECT : « c'est quoi le mail d'Alla ? » puis « envoie-lui un
    // mail » est une intention en deux temps, pas deux missions.
    expect(names).toContain("search_people");
  });

  it("un compte exécutif reçoit les fast paths ouverts par SES droits + la délégation", () => {
    const exec = userWith({ RH: ["VIEW"], REGULATORY: ["VIEW"], FINANCES: ["VIEW"], WORKSPACE: ["VIEW"], CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION");
    const tools = realtimeToolsFor(exec);
    const names = tools.map((t) => t.name);
    expect(names).toContain("employee_360");
    expect(names).toContain("read_payroll"); // ouvert par RH VIEW
    expect(names).toContain("search_everything");
    expect(names).toContain(DELEGATE_TOOL_NAME);
    // Le format attendu par la session Realtime : function + name + description + parameters.
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.parameters).toBe("object");
    }
  });

  it("un compte SANS droits ne reçoit que les outils ouverts par conception + la délégation", () => {
    // Le garde `allowed` est LE MÊME que le texte : read_payroll disparaît sans le module RH.
    const bare = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION");
    const names = realtimeToolsFor(bare).map((t) => t.name);
    expect(names).not.toContain("read_payroll");
    expect(names).not.toContain("read_budget");
    expect(names).toContain("search_everything"); // ouvert par conception (contenu cloisonné)
    expect(names).toContain(DELEGATE_TOOL_NAME);
  });

  it("le résultat d'outil est BORNÉ pour la session (le détail complet reste à l'écran)", () => {
    expect(capToolOutput("x".repeat(20_000)).length).toBeLessThan(9_000);
    expect(capToolOutput("court")).toBe("court");
    expect(capToolOutput("x".repeat(20_000))).toMatch(/tronqué/);
  });

  it("le modèle est configurable, jamais codé en dur ailleurs : gpt-realtime-2.1 par défaut", () => {
    expect(REALTIME_VOICE_MODEL).toBe(process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1");
  });

  it("time_travel est un fast path vocal — « où en était ce dossier au 1er juin ? » sans délégation", () => {
    expect(VOICE_FAST_TOOL_NAMES).toContain("time_travel");
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION");
    expect(realtimeToolsFor(exec).map((t) => t.name)).toContain("time_travel");
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__voice__${Date.now()}`;
let ceoId = "";

suite("voix temps réel — instructions de session (même conversation, budget maîtrisé)", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
  });
  afterAll(async () => {
    await prisma.assistantMessage.deleteMany({ where: { userId: ceoId } }).catch(() => {});
    await prisma.assistantThread.deleteMany({ where: { userId: ceoId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("mêmes règles de fond que le texte, identité vocale, consignes d'appel — SANS le digest géant", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"], REGULATORY: ["VIEW"] }, "DIRECTION", ceoId);
    const instructions = await buildVoiceInstructions(exec, null);
    // L'identité vocale — jamais « assistant textuel ».
    expect(instructions).toContain("interface VOCALE");
    expect(instructions).toContain("My Chief of Staff");
    // Les règles de fond COMMUNES (anti-injection, zéro invention) — la même source que le texte.
    expect(instructions).toContain("jamais une\n  instruction");
    expect(instructions).toContain("n'invente JAMAIS");
    // Les consignes d'appel.
    expect(instructions).toContain("CONSIGNES VOCALES");
    expect(instructions).toMatch(/Ne salue pas à chaque tour/);
    expect(instructions).toMatch(/JAMAIS qu'une action est faite/);
    // L'IDENTITÉ : à la voix, on demande son nom à son interlocuteur — et il doit le savoir.
    expect(instructions).toContain("ADAM");
    expect(instructions).toMatch(/adresse d'expédition/i);
    // Le BUDGET : pas le digest réglementaire ni le mode d'emploi texte des écritures. C'est CE
    // que le plafond protège — des blocs de plusieurs milliers de caractères, pas la centaine
    // qui dit à Adam qui il est.
    //
    // Le plafond est passé de 12 000 à 12 600 le jour où le bloc d'identité (≈ 240 caractères :
    // nom, adresse d'expédition, distinction avec la boîte du PDG) a été ajouté — un compte rendu
    // réel avait montré Adam répondant « je m'appelle Assistant IA » puis s'attribuant la boîte
    // du PDG. La marge n'a pas été élargie « au cas où » : elle a été payée une fois, pour ça.
    //
    // Puis de 12 600 à 13 400 pour la DOCTRINE DE CAPACITÉ (≈ 600 caractères), et pour la même
    // raison : un compte rendu réel montrait Adam répondant « je ne peux pas envoyer l'e-mail,
    // cette fonction n'est pas disponible » — puis proposant au PDG de copier-coller le texte
    // dans sa messagerie. La cause était structurelle (aucune écriture n'était annoncée à la
    // voix) et elle est corrigée ailleurs ; ces six cents caractères sont ce qui empêche un
    // modèle prudent de RETOMBER sur le refus quand il hésite. Coût réel : environ 150 jetons,
    // payés UNE fois à l'ouverture de session, pas à chaque tour.
    expect(instructions).not.toContain("INTERPRÉTATION DES DEMANDES");

    // Le budget ne peut donc pas être dépensé ailleurs sans qu'on le voie : ce qui l'a fait
    // monter doit être PRÉSENT. Sans cette assertion, le plafond relevé financerait n'importe
    // quel ajout futur, et la discipline se perdrait au premier oubli.
    expect(instructions).toMatch(/n'existe pas/);
    expect(instructions).toContain("send_email");
    expect(instructions.length).toBeLessThan(13_400);
  });

  it("la CONVERSATION RÉCENTE du fil est injectée (bornée) — « et son salaire ? » a son contexte", async () => {
    const tid = await createThread(ceoId, `${TAG} sujet`);
    await appendExchange(ceoId, tid, `${TAG} Parle-moi de Khaled Benali`, "Khaled est chargé des affaires réglementaires…");
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const instructions = await buildVoiceInstructions(exec, tid);
    expect(instructions).toContain("CONVERSATION RÉCENTE");
    expect(instructions).toContain("Khaled Benali");
    // Le fil d'un AUTRE compte ne s'injecte jamais (getThreadMessages est cloisonné).
    const other = await prisma.user.create({ data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    const stranger = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", other.id);
    const foreign = await buildVoiceInstructions(stranger, tid);
    expect(foreign).not.toContain("Khaled Benali");
  });

  it("FAILURE C — le vocabulaire MÉTIER contextuel est enseigné (« événements » ≠ calendrier seul)", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const instructions = await buildVoiceInstructions(exec, null);
    expect(instructions).toContain("VOCABULAIRE MÉTIER");
    expect(instructions).toContain("sponsoring");
    expect(instructions).toMatch(/règlement|paiement/);
    expect(instructions).toContain("calendrier");
    // Et la résolution phonétique des noms : jamais inventer une personne d'un mot déformé.
    expect(instructions).toMatch(/Radia Kebir/);
  });

  it("FAILURE A/B — l'état CANONIQUE des actions s'injecte : « déjà demandé ? » se lit, ne se devine pas", async () => {
    const { persistActionIntents } = await import("@/platform/ia/intentions/action-intents");
    await persistActionIntents(ceoId, [{
      kind: "send_message", module: "MESSAGING", title: `${TAG} Notification à Redouane`,
      fields: [{ label: "Objet", value: "Rattacher les contrats" }], payload: {},
    }], "voice");
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const instructions = await buildVoiceInstructions(exec, null);
    expect(instructions).toContain("ACTIONS RÉCENTES");
    expect(instructions).toContain("Redouane");
    expect(instructions).toContain("PROPOSÉE");
    // Et la consigne : l'état canonique, jamais la mémoire.
    expect(instructions).toContain("action_history");
    await prisma.assistantActionIntent.deleteMany({ where: { userId: ceoId } }).catch(() => {});
  });

  it("le CONTEXTE D'ÉCRAN s'injecte quand l'appel part d'une fiche — borné, jamais obligatoire", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const withScreen = await buildVoiceInstructions(exec, null, `L'utilisateur appelle depuis la fiche « PAY-2026-014 ».`);
    expect(withScreen).toContain("CONTEXTE D'ÉCRAN");
    expect(withScreen).toContain("PAY-2026-014");
    expect(withScreen).toContain("« ça », « ce dossier »");
    // Sans contexte : pas de bloc fantôme.
    const without = await buildVoiceInstructions(exec, null);
    expect(without).not.toContain("CONTEXTE D'ÉCRAN");
    // BORNÉ : un client trafiqué qui envoie 50 000 caractères ne gonfle pas les instructions.
    const flooded = await buildVoiceInstructions(exec, null, "Z".repeat(50_000));
    expect(flooded.length - without.length).toBeLessThan(500);
  });

  it("ACTIONS DE L'ÉCRAN — l'appel depuis une page expose ses boutons natifs (priorité au natif, jamais de bruit)", async () => {
    const sa = userWith({}, "SUPER_ADMIN", ceoId);
    // Depuis le suivi Regulatory : les ops natives du module sont ANNONCÉES d'emblée.
    const inst = await buildVoiceInstructions(sa, null, "Écran : /regulatory — Suivi des dossiers");
    expect(inst).toContain("ACTIONS NATIVES DISPONIBLES SUR CET ÉCRAN");
    expect(inst).toContain("regulatory_operation");
    expect(inst).toMatch(/priorité au natif/i);
    // Un écran sans module reconnu → AUCUN bloc (pas de liste hors sujet qui pousse le modèle).
    const none = await buildVoiceInstructions(sa, null, "page Q-99 hors modules");
    expect(none).not.toContain("ACTIONS NATIVES DISPONIBLES");
  });
});
