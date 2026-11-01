import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT K4 — LES VALEURS SENSIBLES EN CLAIR POUR QUI A LE DROIT, ET RIEN DE CONSERVÉ CHEZ OPENAI (décision 0034).
 *
 * Direction, 31/10/2026 : « Même pour les chiffres sensibles, l'assistant IA peut les lire à haute voix ; ils peuvent
 * être envoyés à l'IA, mais fais attention en disant à OpenAI de ne pas s'entraîner sur mes données. »
 *
 * Ce banc tient, contre la vraie base :
 *   • le mode « en clair » (défaut) : le modèle REÇOIT le salaire que le Super Admin a le droit de voir, l'écrit, la
 *     voix le PRONONCE ; chaque valeur transmise est au journal du coffre ;
 *   • les DROITS inchangés : une assistante de direction sans droit RH est toujours refusée ; une valeur que la
 *     personne n'a pas le droit de voir arrive au modèle « [confidentiel] » ;
 *   • le mode « masquées » : les repères de la décision 0012 (le banc `droits-metier.test.ts` le tient en entier) ;
 *   • le réglage : Super Admin seul, à l'audit ;
 *   • `store: false` dans la REQUÊTE envoyée à OpenAI — tour à outils compris (aucune `item_reference`, le
 *     raisonnement demandé chiffré) ; la recherche web (passerelle, rôle worker) ne conserve rien non plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { buildResponsesBody } from "@/lib/models/openai-responses";
import { remplacerModelesPourTests } from "./infra/generer";
import { remplacerReglagesPourTests } from "./infra/consommation";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { filtrerSaisie, jouerTour } from "./infra/fil/tour";
import { outilsV1 } from "./infra/outils-v1";
import { accesAssistantIa, GESTE_MODELE_EN_CLAIR, Revelateur } from "./infra/role-config";
import { optionsFournisseur } from "./infra/modele";
import { deleguerALaVoix, reponsePourVoix } from "./infra/voix/temps-reel";
import { enregistrerSessionVoix, suivreTravailVocal } from "./infra/voix/oral";
import { REGLE_CONFIDENTIALITE_EN_CLAIR, REGLES, reglesPour } from "./infra/contexte";
import { refusFamille } from "./domaine/acces-regles";
import { normaliserReglages, REGLAGES_PAR_DEFAUT } from "./domaine/consommation-regles";
import { consignesVoix, DIT_A_L_ECRAN, NON_OUVERTE } from "./domaine/terrain/voix";
import {
  BORNE_REVELEE, CoffretDuTour, CONSIGNE_EN_CLAIR, CONSIGNE_JETONS, horsEcranSansValeur, MASQUE_CONFIDENTIEL, retirerBornes,
} from "./domaine/filtre-confidentialite";
import { enregistrerValeursSensibles } from "@/modules/assistant-ia/actions-consommation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iak4_${Date.now().toString(36)}_`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
/** Les montants s'impriment avec des espaces insécables fines : on compare des chiffres. */
const chiffres = (s: string) => s.replace(/[\s  ]/g, "");

describe("le réglage et ses règles (pur)", () => {
  it("défaut : EN CLAIR (décision de la Direction) ; une valeur inconnue revient au défaut", () => {
    expect(REGLAGES_PAR_DEFAUT.valeursSensibles).toBe("EN_CLAIR");
    expect(normaliserReglages(null).valeursSensibles).toBe("EN_CLAIR");
    expect(normaliserReglages({ valeursSensibles: "MASQUEES" }).valeursSensibles).toBe("MASQUEES");
    expect(normaliserReglages({ valeursSensibles: "n'importe quoi" }).valeursSensibles).toBe("EN_CLAIR");
  });

  it("la règle 2 de la consigne est réécrite en clair ; les repères restent la règle du mode masqué", () => {
    expect(reglesPour(undefined, true)[1]).toBe(REGLE_CONFIDENTIALITE_EN_CLAIR);
    expect(reglesPour(undefined, true)[1]).not.toContain("⟦S1⟧");
    expect(reglesPour(undefined, false)[1]).toBe(REGLES[1]);
    expect(REGLES[1]).toContain("⟦S1⟧");
    expect(reglesPour(undefined, true)).toHaveLength(REGLES.length);
  });

  it("la voix : EN CLAIR elle prononce la valeur (bornes retirées) ; masquée, gardée dans la conversation écrite", () => {
    const contenu = `**Salaire de base** : ${BORNE_REVELEE}185 000 DZD${BORNE_REVELEE} ; IBAN ${MASQUE_CONFIDENTIEL}.`;
    const clair = reponsePourVoix(contenu, true);
    expect(clair).toContain("185 000 DZD");
    expect(clair).not.toContain(BORNE_REVELEE);
    expect(clair).toContain(NON_OUVERTE);
    expect(reponsePourVoix("Son net est de 152 340 DZD.", true)).toBe("Son net est de 152 340 DZD.");
    const masquee = reponsePourVoix(contenu, false);
    expect(masquee).not.toContain("185");
    expect(masquee).toContain(DIT_A_L_ECRAN);
    expect(consignesVoix(true)).toContain("DIS-LA");
    expect(consignesVoix(true)).not.toContain("JAMAIS prononcée");
    expect(consignesVoix(false)).toContain("JAMAIS prononcée");
    // Les deux modes gardent la règle des écritures — K9 (décision 0038) : une carte se conclut À L'ORAL, jugée par le serveur.
    for (const c of [consignesVoix(true), consignesVoix(false)]) expect(c).toContain("c'est le serveur qui juge et qui exécute");
  });

  it("l'historique EN CLAIR : la réponse de l'assistant repart telle qu'il l'a écrite ; une valeur bornée (temps des repères) reste masquée", () => {
    const h = [
      { role: "user" as const, content: "Le salaire d'Assia ?" },
      { role: "assistant" as const, content: "Le salaire de base d'Assia est de 185 000 DZD." },
      { role: "assistant" as const, content: `Son IBAN : ${BORNE_REVELEE}DZ5900400174401234567890${BORNE_REVELEE}.` },
    ];
    const clair = filtrerSaisie("Et son net ?", h, true, true);
    expect(clair.historique[1]!.content).toContain("185 000 DZD");
    expect(clair.historique[2]!.content).toBe(`Son IBAN : ${MASQUE_CONFIDENTIEL}.`);
    // Le mode masqué : rien ne repart (décision 0012, inchangé).
    expect(filtrerSaisie("Et son net ?", [{ role: "assistant", content: "Le salaire de base est de 185 000 DZD." }], true, false).historique[0]!.content).not.toContain("185");
  });

  it("hors de l'écran (notification) en clair : ni motif sensible ni montant", () => {
    const t = horsEcranSansValeur("Le salaire de base d'Assia est de 185 000 DZD ; IBAN DZ5900400174401234567890.");
    expect(t).not.toMatch(/185|DZ59/);
    expect(t).toContain(MASQUE_CONFIDENTIEL);
    expect(retirerBornes(`a ${BORNE_REVELEE}x${BORNE_REVELEE} ⟦S3⟧`)).toBe(`a x ${MASQUE_CONFIDENTIEL}`);
  });

  it("store: false sur les options de TOUS les appels de l'Assistant IA (conversation, rédaction, vision, résumé)", () => {
    expect(optionsFournisseur({ providerId: "openai", modelId: "gpt-6.1-terra", apiKey: "k", effort: "low" }, "assistant-ia:u")).toEqual({
      openai: { store: false, reasoningEffort: "low", promptCacheKey: "assistant-ia:u" },
    });
    expect(optionsFournisseur({ providerId: "openai", modelId: "gpt-6.1-terra", apiKey: "k" })?.openai.store).toBe(false);
  });

  it("la recherche web (passerelle d'Adam, rôle worker, sans chaînage) : la requête porte store: false ; le chaînage d'Adam garde store: true", () => {
    const binding = { role: "worker", model: "gpt-6.1-terra", reasoning: "low" } as never;
    const tours = [{ role: "user", content: "actualité" }] as never;
    expect(buildResponsesBody(binding, tours, { webSearch: true } as never).store).toBe(false);
    // Adam enchaîne ses tours (`previous_response_id`) : sa conservation reste ce qu'elle était.
    const chaine = buildResponsesBody(binding, tours, { previousResponseId: "resp_1" } as never);
    expect(chaine.store).toBe(true);
  });
});

suite("contre la base", () => {
  let superAdmin: CurrentUser;
  let kam: CurrentUser;
  let assia: CurrentUser;
  let assistante: CurrentUser;
  let employeAssia = "";
  const cleAvant = process.env.OPENAI_API_KEY;

  const session = async (role: string, nom: string, assistantIa = false): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
    if (assistantIa) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    // Le mode s'injecte (la ligne globale reste à ses voisins) : ici, le défaut de la Direction.
    remplacerReglagesPourTests({ valeursSensibles: "EN_CLAIR" });
    superAdmin = await session("SUPER_ADMIN", "Direction", true);
    kam = await session("MEDICAL_DELEGATE", "Kamel", true);
    assia = await session("MEDICAL_DELEGATE", "Assia");
    assistante = await session("DIRECTION_ASSISTANT", "Samia", true);
    employeAssia = (await prisma.employee.create({
      data: { fullName: `Assia ${TAG}Benali`, userId: assia.id, position: "Pharmacienne", baseSalary: 185000, netToPay: 152340, iban: "DZ5900400174401234567890" },
    })).id;
  });
  afterEach(() => { remplacerModelesPourTests(null); vi.unstubAllGlobals(); });
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    remplacerReglagesPourTests(null);
    const ids = [superAdmin, kam, assia, assistante].filter(Boolean).map((u) => u.id);
    await prisma.accesDonneeSensible.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await effacerJournalDe(ids);
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("EN CLAIR — « c'est quoi le salaire d'Assia ? » : le modèle REÇOIT la valeur, l'écrit ; la transmission est journalisée", async () => {
    const f = modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } },
      (prompt) => {
        // Le modèle lit le salaire dans la sortie de l'outil — en clair — et le recopie.
        const m = chiffres(prompt).match(/185000(?:,00)?DZD/);
        return reponse(m ? "Le salaire de base d'Assia est de 185 000 DZD." : "Je n'ai pas la valeur.");
      },
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(superAdmin, { texte: `C'est quoi le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("Le salaire de base d'Assia est de 185 000 DZD.");
    const recu = JSON.stringify(f.promptsRecus);
    expect(chiffres(recu)).toMatch(/185000/);
    expect(chiffres(recu)).toMatch(/152340/);
    expect(recu).not.toMatch(/⟦S\d+⟧/);
    // La consigne du mode : la règle 2 réécrite, la consigne des repères absente.
    expect(recu).toContain(REGLE_CONFIDENTIALITE_EN_CLAIR.slice(0, 80));
    expect(recu).toContain(CONSIGNE_EN_CLAIR.slice(0, 60));
    expect(recu).not.toContain("REPÈRES opaques");
    // Les colonnes de la fiche passent par le contrôle du coffre, qui journalise quand son interrupteur est ouvert
    // (`coffreLecture`) ; une valeur HORS colonne est journalisée toujours — le test suivant le tient.
  });

  it("EN CLAIR — les droits inchangés : l'assistante de direction sans droit RH est toujours refusée, le KAM aussi", async () => {
    for (const u of [assistante, kam]) {
      const o = outilsV1(u, [], [], [], new CoffretDuTour(), await accesAssistantIa(u), {
        revelerAuModele: async (s) => new Revelateur(new CoffretDuTour(), u, await accesAssistantIa(u), GESTE_MODELE_EN_CLAIR).enClair(s),
      }).find((t) => t.def.name === "lire_paie")!;
      const s = await o.run({ nom: `Assia ${TAG}Benali` }, u);
      expect(JSON.parse(s)).toEqual({ statut: "REFUS", raison: refusFamille("SALAIRES") });
      expect(s).not.toMatch(/185|152/);
    }
    // Le tour entier sous l'assistante : le modèle n'a rien reçu, l'écran montre le refus.
    const f = modeleFactice([{ appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } }, reponse("La famille « Salaires & paie » ne vous est pas ouverte.")]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(assistante, { texte: `Le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
    expect(r.ok && r.content).toContain("Salaires & paie");
    expect(chiffres(JSON.stringify(f.promptsRecus))).not.toMatch(/185000|152340/);
  });

  it("EN CLAIR — une valeur que la personne n'a pas le droit de voir arrive au modèle « [confidentiel] » (même juge que l'écran)", async () => {
    const c = new CoffretDuTour();
    const j = c.jeton({ valeur: "185 000 DZD", nature: "SALAIRE", titulaireUserId: assia.id, origine: { modele: "Employee", id: employeAssia, champ: "baseSalary", brut: "185000" } });
    const sortie = JSON.stringify({ salaireBase: j, poste: "Pharmacienne" });
    const pour = async (u: CurrentUser) => JSON.parse(await new Revelateur(c, u, await accesAssistantIa(u), GESTE_MODELE_EN_CLAIR).enClair(sortie));
    expect(await pour(kam)).toEqual({ salaireBase: MASQUE_CONFIDENTIEL, poste: "Pharmacienne" });
    expect(chiffres((await pour(superAdmin)).salaireBase)).toBe("185000DZD");
    // Assia voit le sien.
    expect(chiffres((await pour(assia)).salaireBase)).toBe("185000DZD");
    // Une valeur HORS colonne (masse salariale, ligne de paie) : chaque transmission au modèle est au journal, accord comme refus.
    const masse = c.jeton({ valeur: "2 400 000 DZD", nature: "SALAIRE", titulaireUserId: null, source: { modele: "PayrollEntry", id: `${TAG}p1` } });
    expect(chiffres(await new Revelateur(c, superAdmin, await accesAssistantIa(superAdmin), GESTE_MODELE_EN_CLAIR).enClair(`Masse : ${masse}`))).toBe("Masse:2400000DZD");
    expect(await new Revelateur(c, kam, await accesAssistantIa(kam), GESTE_MODELE_EN_CLAIR).enClair(`Masse : ${masse}`)).toBe(`Masse : ${MASQUE_CONFIDENTIEL}`);
    const journal = await prisma.accesDonneeSensible.findMany({ where: { origineId: `${TAG}p1`, geste: { startsWith: GESTE_MODELE_EN_CLAIR } }, select: { userId: true, autorise: true } });
    expect(journal).toEqual(expect.arrayContaining([{ userId: superAdmin.id, autorise: true }, { userId: kam.id, autorise: false }]));
  });

  it("MASQUÉES — le comportement de la décision 0012 : le modèle n'a que des repères, l'écran la valeur", async () => {
    remplacerReglagesPourTests({ valeursSensibles: "MASQUEES" });
    try {
      const f = modeleFactice([{ appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } }, reponse("Le salaire de base d'Assia est de ⟦S1⟧.")]);
      remplacerModelesPourTests([f.modele as never]);
      const r = await jouerTour(superAdmin, { texte: `C'est quoi le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
      expect(r.ok && chiffres(r.content)).toContain("185000DZD");
      const recu = JSON.stringify(f.promptsRecus);
      expect(chiffres(recu)).not.toMatch(/185000|152340/);
      expect(recu).toContain("⟦S1⟧");
      expect(recu).toContain("REPÈRES opaques");
      expect(CONSIGNE_JETONS).toContain("REPÈRES opaques");
    } finally { remplacerReglagesPourTests({ valeursSensibles: "EN_CLAIR" }); }
  });

  it("EN CLAIR — la délégation vocale : la voix entend le salaire et peut le prononcer", async () => {
    remplacerModelesPourTests([modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } },
      (prompt) => reponse(chiffres(prompt).includes("185000") ? "Le salaire de base d'Assia est de 185 000 DZD." : "Je ne l'ai pas."),
    ]).modele as never]);
    // K9 : la délégation rend un travail, suivi jusqu'au résultat que la voix dit.
    await enregistrerSessionVoix(superAdmin.id, `live_${TAG}`, null);
    const v = await deleguerALaVoix(superAdmin, `quel est le salaire d'Assia ${TAG}Benali ?`, { session: `live_${TAG}` });
    let s = await suivreTravailVocal(superAdmin, `live_${TAG}`, v.travail);
    for (let i = 0; i < 200 && s.etat === "en_cours"; i++) { await new Promise((r) => setTimeout(r, 50)); s = await suivreTravailVocal(superAdmin, `live_${TAG}`, v.travail); }
    expect(s).toMatchObject({ etat: "pret", pourVoix: "Le salaire de base d'Assia est de 185 000 DZD." });
  });

  it("le réglage : Super Admin seul, à l'audit (avant → après) ; une valeur inconnue refusée", async () => {
    const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { valeursSensibles: true } });
    ACTEUR = kam;
    const fd = new FormData();
    fd.set("valeursSensibles", "EN_CLAIR");
    expect((await enregistrerValeursSensibles(fd)).ok).toBe(false);
    ACTEUR = superAdmin;
    const faux = new FormData();
    faux.set("valeursSensibles", "TOUT");
    expect((await enregistrerValeursSensibles(faux)).ok).toBe(false);
    // On réécrit la valeur en place (la ligne est globale : la suite tourne en parallèle) — l'audit se trace quand même.
    const meme = new FormData();
    meme.set("valeursSensibles", avant?.valeursSensibles === "MASQUEES" ? "MASQUEES" : "EN_CLAIR");
    expect(await enregistrerValeursSensibles(meme)).toEqual({ ok: true });
    const a = await prisma.auditLog.findFirst({ where: { actorId: superAdmin.id, field: "Assistant IA — valeurs sensibles" }, select: { oldValue: true, newValue: true, summary: true } });
    expect(a?.summary).toContain("valeurs sensibles");
    expect(a?.newValue).toMatch(/En clair|Masquées/);
  });

  it("store: false DANS LA REQUÊTE envoyée à OpenAI — un tour à outils entier, sans référence conservée, raisonnement chiffré", async () => {
    const corps: Record<string, unknown>[] = [];
    const reponses = [
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lire_paie", arguments: JSON.stringify({ nom: `Assia ${TAG}Benali` }), status: "completed" },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Le salaire de base d'Assia est de 185 000 DZD.", annotations: [] }] },
    ];
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes("/responses")) return new Response("{}", { status: 404 });
      corps.push(JSON.parse(String(init?.body)));
      const sortie = reponses[Math.min(corps.length - 1, reponses.length - 1)]!;
      return Response.json({
        id: `resp_${corps.length}`, object: "response", created_at: 1, status: "completed", model: "gpt-6.1-terra", error: null, incomplete_details: null,
        output: [{ type: "reasoning", id: `rs_${corps.length}`, encrypted_content: "chiffre", summary: [] }, sortie],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } },
      });
    }) as typeof fetch);
    remplacerModelesPourTests([{ providerId: "openai", modelId: "gpt-6.1-terra", apiKey: "cle-de-banc", effort: "low" } as never]);
    const r = await jouerTour(superAdmin, { texte: `C'est quoi le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
    expect(corps.length).toBeGreaterThanOrEqual(2);
    for (const b of corps) {
      expect(b.store).toBe(false);
      expect(b.previous_response_id).toBeUndefined();
      expect(b.include).toContain("reasoning.encrypted_content");
    }
    // La 2e requête renvoie l'appel d'outil EN ENTIER (pas une référence à un élément conservé) — et, en clair, la valeur.
    const deuxieme = JSON.stringify(corps[1]!.input);
    expect(deuxieme).not.toContain("item_reference");
    expect(deuxieme).toContain("function_call_output");
    expect(chiffres(deuxieme)).toMatch(/185000/);
    expect(r.ok && r.content).toContain("185 000 DZD");
  });
});
