import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { couvertParUnePrimitive } from "./infra/primitives";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { jouerTour } from "./infra/fil/tour";
import { remplacerModelesPourTests } from "./infra/generer";
import { consigneGestesFermes, outilsV1 } from "./infra/outils-v1";
import { selectionDuTour } from "./infra/selection";
import { gestesFermesPour } from "./infra/refus-nomme";
import { profilDAcces } from "./domaine/profil-acces";
import { adamOuvert } from "./infra/adam/outils-adam";
import { canalAdamOuvert, MOTS_DU_CANAL_ADAM } from "./domaine/mails/canal";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { COMPTE_JOUE, type PersonaCle } from "./infra/testing/audit/personas";
import { retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";

/**
 * AU3 — « UN SEUL MOTEUR, DES ACCÈS » : le banc qui PROUVE les constats du rapport
 * `docs/assistant/audit-2026-11-03/au3-moteur-unique.md` — REPRIS par le lot I2 (décision 0064) et INVERSÉ là où il
 * constatait un défaut corrigé : la prose d'accès (étape 2) et les doublons du Super Admin (étape 3).
 *
 *   1. Super Admin et employé passent par la MÊME boucle (`jouerTour`) : on le prouve en jouant le même tour, faux modèle.
 *   2. Ce qui diffère est mesuré : catalogue offert, poids du catalogue, outils envoyés au tour, taille de la consigne.
 *   3. Les doublons fonctionnels que le Super Admin reçoit (deux outils pour le même geste) sont listés EXACTEMENT : le test
 *      échoue quand la liste change — le plan de retrait se lit contre ce chiffre.
 *
 * Mesures écrites dans `AU3_MESURES` (fichier JSON) si la variable est posée ; sinon seulement vérifiées.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ETIQUETTE = `-au3${Date.now().toString(36)}`;
const PERSONAS: PersonaCle[] = ["superadmin", "commercial", "rh", "finance", "delegue"];
const sessions = {} as Record<PersonaCle, CurrentUser>;
let S: SemisAudit;

/** Les 5 demandes du rejeu (les cas réels de la Direction, 03/11, plus deux demandes ordinaires). */
export const DEMANDES_AU3 = [
  "Envoie un mail simple, sans design, à Karim pour lui dire que la réunion est décalée à jeudi.",
  "Donne-moi nos 3 missions en cours, avec leur état.",
  "Quels sont nos produits infectieux commercialisés ?",
  "Quelle est la masse salariale d'Adventum ce mois-ci ?",
  "Cherche le dernier contrat signé avec Pharmagène dans le Drive.",
] as const;

/**
 * LES DOUBLONS DU SUPER ADMIN (AU3 : 17 paires) — lot I2, étape 3 : chaque paire MESURÉE contre l'outil du moteur.
 *   • RETIRÉS (9) : le moteur couvre le même besoin — une seule lecture, une seule règle de droits (les familles).
 *   • GARDÉS (8) : l'outil du moteur NE couvre PAS le besoin (raisons dans `COUVERTS`, `porte-assistant-ia.ts`) — les
 *     retirer fermerait un accès du Super Admin (son Gmail, ses rappels, sa mémoire d'actions, sa trésorerie).
 */
export const DOUBLONS_RETIRES_I2: ReadonlyArray<readonly [string, string]> = [
  ["search_drive", "chercher_documents"], ["find_documents", "chercher_documents"], ["search_documents", "chercher_documents"],
  ["read_document", "ouvrir_documents"], ["pdf_read", "ouvrir_documents"], ["sheet_read", "lire_tableur"],
  ["format_convertir", "convertir_document"], ["format_lire", "ouvrir_documents"], ["mission_create", "lancer_un_travail"],
];
export const NON_DOUBLONS_GARDES_I2: readonly string[] = [
  "gmail_search", "gmail_read_thread", "gmail_pending_mail", "list_reminders", "plan_reminder", "episodic_recall", "read_finances", "resolve_person",
];

const jetons = (s: string) => Math.ceil(s.length / 3.2);
const mesures: Record<string, unknown> = {};

suite("AU3 — un seul moteur : ce qui diffère entre le Super Admin et un employé", () => {
  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    S = await semerAudit(ETIQUETTE, { putBlob, enregistrerFichierDrive }, { societe: `Adventum Pharma ${ETIQUETTE}` });
    for (const p of PERSONAS) sessions[p] = await sessionDe(S.users[COMPTE_JOUE[p]]);
  }, 120_000);

  afterAll(async () => {
    remplacerModelesPourTests(null);
    remplacerLecteurInterrupteurIaPourTests(null);
    if (process.env.AU3_MESURES) fs.writeFileSync(process.env.AU3_MESURES, JSON.stringify(mesures, null, 2));
    if (S) { await effacerJournalDe(Object.values(S.users)); await retirerAudit(ETIQUETTE); }
  }, 60_000);

  it("le catalogue : même fabrique (`outilsV1`), contenu différent — mesuré", () => {
    const parPersona: Record<string, { offerts: number; jetonsCatalogue: number }> = {};
    for (const p of PERSONAS) {
      const u = sessions[p];
      const cat = outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never })
        .filter((o) => o.allowed(u));
      parPersona[p] = { offerts: cat.length, jetonsCatalogue: cat.reduce((s, o) => s + jetons(JSON.stringify(o.def)), 0) };
    }
    mesures.catalogue = parPersona;
    // Le SA reçoit nettement plus — c'est l'accès qui diffère, pas le moteur.
    expect(parPersona.superadmin.offerts).toBeGreaterThan(parPersona.commercial.offerts + 90);
    // Trois prédicats différents décident « c'est le Super Admin » : ils coïncident ici, mais vivent à trois endroits.
    expect(adamOuvert(sessions.superadmin) && canalAdamOuvert(sessions.superadmin)).toBe(true);
    expect(adamOuvert(sessions.commercial) || canalAdamOuvert(sessions.commercial)).toBe(false);
  });

  it("CORRIGÉ (I2, étape 2) : l'accès n'est plus dit en prose — même en repli, un employé n'entend jamais « Mail d'Adam »", () => {
    // AU3 constatait : la consigne du commercial NOMMAIT le geste réservé (« Mail d'Adam »). En repli
    // (`ASSISTANT_IA_ACCES_EN_PROSE=1`), la liste des gestes non ouverts ne cite plus un geste que le profil réserve.
    const consigne = consigneGestesFermes(sessions.commercial) ?? "";
    mesures.consigneGestesFermesCommercialRepli = { jetons: jetons(consigne) };
    expect(consigne).not.toMatch(MOTS_DU_CANAL_ADAM);
    expect(consigne).not.toMatch(/Mail d.Adam/i);
    // Aucun geste fermé d'un employé, nommé en refus par `trouver_outil`, n'appartient au canal d'Adam.
    for (const p of PERSONAS.filter((x) => x !== "superadmin")) {
      const fermes = gestesFermesPour(sessions[p], profilDAcces(sessions[p]));
      expect(fermes.map((f) => f.nom), p).not.toContain("envoyer_gmail");
      expect(fermes.filter((f) => MOTS_DU_CANAL_ADAM.test(`${f.libelle} ${f.description}`)).map((f) => f.nom), p).toEqual([]);
    }
  });

  it("le refus NOMMÉ passe par `trouver_outil` depuis la table : geste, droit, qui l'ouvre — jamais un jeu vide muet", async () => {
    const u = sessions.commercial;
    const profil = profilDAcces(u);
    const fermes = gestesFermesPour(u, profil);
    mesures.gestesFermesCommercial = fermes.length;
    expect(fermes.length).toBeGreaterThan(0);
    const cat = outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never });
    const sel = selectionDuTour(cat, u, "bonjour", null, "", [], () => fermes);
    // Un geste fermé de l'assistant (opération) — demandé par son libellé : le refus le nomme.
    const vise = fermes.find((f) => !f.nom.includes("__")) ?? fermes[0]!;
    const sortie = JSON.parse(await sel.outil.run({ intention: `${vise.libelle} ${vise.description.slice(0, 80)}` }, u)) as { fermes?: { geste: string; droit: string; quiOuvre: string }[]; consigne: string };
    expect(sortie.fermes?.length, JSON.stringify(sortie)).toBeGreaterThan(0);
    expect(sortie.fermes![0]!.droit).toMatch(/n'est (pas )?ouvert/);
    expect(sortie.fermes![0]!.quiOuvre).toMatch(/Administration › Accès/);
    expect(sortie.consigne).not.toMatch(/Adam/);
    // « Envoie-le depuis le Gmail d'Adam » par un employé : aucun refus ne nomme le canal (il n'existe pas pour lui).
    const adam = await sel.outil.run({ intention: "envoyer un mail depuis le gmail d'Adam" }, u);
    expect(adam).not.toMatch(MOTS_DU_CANAL_ADAM);
  });

  it("CORRIGÉ (I2, étape 3) : les doublons du Super Admin quittent l'offre ; les non-doublons mesurés restent", () => {
    const u = sessions.superadmin;
    const noms = new Set(outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never })
      .filter((o) => o.allowed(u)).map((o) => o.def.name));
    const restants = DOUBLONS_RETIRES_I2.filter(([adam]) => noms.has(adam));
    mesures.doublons = { retires: DOUBLONS_RETIRES_I2.map(([a, b]) => `${a} → ${b}`), restants: restants.map(([a]) => a), gardes: NON_DOUBLONS_GARDES_I2 };
    expect(restants.map(([a]) => a)).toEqual([]);
    // Le côté moteur de chaque paire retirée EST offert — ou couvert par une primitive d'I3 (0065) : aucun besoin ne perd son outil.
    expect(DOUBLONS_RETIRES_I2.filter(([, moteur]) => !noms.has(moteur) && !couvertParUnePrimitive(moteur, noms) && moteur !== "lancer_un_travail").map(([, m]) => m)).toEqual([]);
    expect(NON_DOUBLONS_GARDES_I2.filter((n) => !noms.has(n))).toEqual([]);
  });

  it("le tour : même boucle pour tous ; consigne et outils envoyés mesurés sur 5 demandes", async () => {
    const parPersona: Record<string, { consigneJetons: number[]; outilsEnvoyes: number[]; jetonsOutilsEnvoyes: number[] }> = {};
    const avant = process.env.ASSISTANT_IA_ACCES_EN_PROSE;
    // I2 : la même mesure, avec la prose d'accès (repli) puis sans (défaut) — la différence est ce que l'étape 2 retire.
    for (const [p, prose] of [["superadmin", "1"], ["commercial", "1"], ["superadmin", ""], ["commercial", ""]] as const) {
      if (prose) process.env.ASSISTANT_IA_ACCES_EN_PROSE = prose; else delete process.env.ASSISTANT_IA_ACCES_EN_PROSE;
      const u = sessions[p];
      const defs = new Map(outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never }).map((o) => [o.def.name, o.def]));
      const m = { consigneJetons: [] as number[], outilsEnvoyes: [] as number[], jetonsOutilsEnvoyes: [] as number[] };
      const faux0: string[] = [];
      for (const texte of DEMANDES_AU3) {
        const faux = modeleFactice([{ texte: JSON.stringify({ message: "Mesure.", components: [] }) }]);
        remplacerModelesPourTests([faux.modele as never]);
        const r = await jouerTour(u, { texte, pieces: [], historique: [] });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const systeme = JSON.stringify((faux.promptsRecus[0] as { role: string; content: unknown }[]).filter((x) => x.role === "system"));
        faux0.push(systeme);
        const envoyes = faux.outilsRecus[0] ?? [];
        m.consigneJetons.push(jetons(systeme));
        m.outilsEnvoyes.push(envoyes.length);
        m.jetonsOutilsEnvoyes.push(envoyes.reduce((s, n) => s + (defs.has(n) ? jetons(JSON.stringify(defs.get(n))) : 60), 0));
      }
      parPersona[prose ? `${p}_prose` : p] = m;
      const systemes = faux0.join("\n");
      if (!prose) {
        // Le défaut : aucune prose d'accès — ni la consigne du Super Admin, ni les gestes non ouverts de l'employé.
        expect(systemes).not.toMatch(/TU ES ADAM, LE CHIEF OF STAFF|GESTES NON OUVERTS|Ta boîte d'envoi, c'est le Gmail d'ADAM/);
        if (p !== "superadmin") expect(systemes).not.toMatch(MOTS_DU_CANAL_ADAM);
      }
      faux0.length = 0;
    }
    if (avant === undefined) delete process.env.ASSISTANT_IA_ACCES_EN_PROSE; else process.env.ASSISTANT_IA_ACCES_EN_PROSE = avant;
    mesures.tour = parPersona;
    const moy = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    // AU3 mesurait : la consigne de l'EMPLOYÉ était la plus longue — ses accès lui étaient DITS en prose. I2 : la prose
    // retirée, chaque consigne raccourcit (SA : CONSIGNE_ADAM_SA + CONSIGNE_BOITE_ADAM ; employé : les gestes non ouverts).
    const sa = moy(parPersona.superadmin.consigneJetons), emp = moy(parPersona.commercial.consigneJetons);
    const saProse = moy(parPersona.superadmin_prose.consigneJetons), empProse = moy(parPersona.commercial_prose.consigneJetons);
    mesures.consigneMoyenne = { superadmin: { avant: saProse, apres: sa }, commercial: { avant: empProse, apres: emp } };
    expect(sa).toBeLessThan(saProse);
    expect(emp).toBeLessThan(empProse);
    // Écart < 15 % : même moteur.
    expect(Math.abs(sa - emp) / Math.max(sa, emp)).toBeLessThan(0.15);
    // La sélection borne ce qui part au modèle : ≤ 20 outils par tour, quel que soit le catalogue (1 259 pour le SA).
    expect(Math.max(...parPersona.superadmin.outilsEnvoyes, ...parPersona.commercial.outilsEnvoyes)).toBeLessThanOrEqual(20);
  }, 120_000);

  /**
   * LE REJEU RÉEL (budget ≤ 3 $) : les 5 demandes, au vrai modèle, pour le Super Admin et pour un employé — latence, jetons,
   * coût par tour lus au journal de consommation (`ModelCallLog`). Joué seulement avec `AU3_REEL=1` (et le mandataire en banc).
   */
  it.runIf(process.env.AU3_REEL === "1")("rejeu réel : latence, jetons et coût par tour, SA et employé", async () => {
    remplacerModelesPourTests(null);
    const rejeu: Record<string, unknown[]> = {};
    let total = 0;
    for (const p of ["superadmin", "commercial"] as const) {
      const u = sessions[p];
      rejeu[p] = [];
      for (const texte of DEMANDES_AU3) {
        const depuis = new Date();
        const t0 = Date.now();
        const r = await jouerTour(u, { texte, pieces: [], historique: [] });
        const ms = Date.now() - t0;
        const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id, at: { gte: depuis } }, select: { inputTokens: true, cachedInputTokens: true, outputTokens: true, reasoningTokens: true, costUsd: true, ms: true, feature: true } });
        const cout = appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0);
        total += cout;
        rejeu[p].push({
          texte, ms, appels: appels.length, entree: appels.reduce((s, a) => s + a.inputTokens, 0), cache: appels.reduce((s, a) => s + a.cachedInputTokens, 0),
          sortie: appels.reduce((s, a) => s + a.outputTokens, 0), coutUsd: Number(cout.toFixed(4)),
          ok: r.ok, outils: r.ok ? r.outilsAppeles : [], carte: r.ok ? r.intent?.title ?? null : null,
          reponse: r.ok ? r.content.slice(0, 600) : r.error,
        });
        expect(total, "budget du rejeu").toBeLessThan(3);
      }
    }
    mesures.rejeu = rejeu;
    mesures.rejeuCoutTotalUsd = Number(total.toFixed(4));
  }, 900_000);
});
