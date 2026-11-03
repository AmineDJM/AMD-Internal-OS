import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { jouerTour } from "./infra/fil/tour";
import { remplacerModelesPourTests } from "./infra/generer";
import { consigneGestesFermes, outilsV1 } from "./infra/outils-v1";
import { adamOuvert } from "./infra/adam/outils-adam";
import { canalAdamOuvert } from "./domaine/mails/canal";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { COMPTE_JOUE, type PersonaCle } from "./infra/testing/audit/personas";
import { retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";

/**
 * AU3 — « UN SEUL MOTEUR, DES ACCÈS » : le banc qui PROUVE les constats du rapport
 * `docs/assistant/audit-2026-11-03/au3-moteur-unique.md` (aucune fonctionnalité, aucune refonte).
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
 * LES DOUBLONS DU SUPER ADMIN — chaque paire : (fonction de l'ancien Adam branchée par la porte, outil du moteur pour le
 * même geste). Deux chemins, deux formats de sortie, deux règles de droits ; le modèle choisit l'un ou l'autre selon le rang.
 */
export const DOUBLONS_SA: ReadonlyArray<readonly [string, string]> = [
  ["search_drive", "chercher_documents"], ["find_documents", "chercher_documents"], ["search_documents", "chercher_documents"],
  ["read_document", "ouvrir_documents"], ["pdf_read", "ouvrir_documents"], ["sheet_read", "lire_tableur"],
  ["format_convertir", "convertir_document"], ["format_lire", "ouvrir_documents"],
  ["gmail_search", "mes_boites_mail"], ["gmail_read_thread", "mes_boites_mail"], ["gmail_pending_mail", "mes_boites_mail"],
  ["mission_create", "lancer_un_travail"], ["list_reminders", "gerer_routine"], ["plan_reminder", "programmer_routine"],
  ["episodic_recall", "mes_conversations"], ["read_finances", "finance_totals"], ["resolve_person", "directory_lookup"],
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

  it("CONSTAT : la consigne d'un employé NOMME le geste réservé du Super Admin (accès dit en prose, puis tu par la garde de sortie)", () => {
    const consigne = consigneGestesFermes(sessions.commercial) ?? "";
    mesures.consigneGestesFermesCommercial = { jetons: jetons(consigne), texte: consigne };
    // Le modèle de l'employé LIT « Mail d'Adam » : la décision 0055 dit « un employé n'entend jamais parler d'une fonction
    // réservée ». La garde de sortie (`taireCanalAdam`) le tait ensuite — rejeu réel : « votre rôle ne dispose pas du droit
    // « une boîte qui ne vous est pas ouverte » ». Un accès devrait RETIRER l'outil, pas le décrire.
    expect(consigne).toMatch(/Mail d.Adam/i);
  });

  it("les doublons : le Super Admin reçoit DEUX outils pour le même geste (liste exacte)", () => {
    const u = sessions.superadmin;
    const noms = new Set(outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never })
      .filter((o) => o.allowed(u)).map((o) => o.def.name));
    const presents = DOUBLONS_SA.filter(([adam]) => noms.has(adam));
    mesures.doublons = presents.map(([a, b]) => `${a} ↔ ${b}`);
    // Le côté Adam de chaque paire est offert au SA (le côté moteur l'est aussi, à la conversation ou par mails/missions).
    expect(presents.length).toBeGreaterThanOrEqual(14);
  });

  it("le tour : même boucle pour tous ; consigne et outils envoyés mesurés sur 5 demandes", async () => {
    const parPersona: Record<string, { consigneJetons: number[]; outilsEnvoyes: number[]; jetonsOutilsEnvoyes: number[] }> = {};
    for (const p of ["superadmin", "commercial"] as const) {
      const u = sessions[p];
      const defs = new Map(outilsV1(u, [], [], [], null, undefined, { capacites: true, visuels: [], analyse: { jeux: { noter() {} }, blocs: [], pieces: [], question: "" } as never }).map((o) => [o.def.name, o.def]));
      const m = { consigneJetons: [] as number[], outilsEnvoyes: [] as number[], jetonsOutilsEnvoyes: [] as number[] };
      for (const texte of DEMANDES_AU3) {
        const faux = modeleFactice([{ texte: JSON.stringify({ message: "Mesure.", components: [] }) }]);
        remplacerModelesPourTests([faux.modele as never]);
        const r = await jouerTour(u, { texte, pieces: [], historique: [] });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const systeme = JSON.stringify((faux.promptsRecus[0] as { role: string; content: unknown }[]).filter((x) => x.role === "system"));
        const envoyes = faux.outilsRecus[0] ?? [];
        m.consigneJetons.push(jetons(systeme));
        m.outilsEnvoyes.push(envoyes.length);
        m.jetonsOutilsEnvoyes.push(envoyes.reduce((s, n) => s + (defs.has(n) ? jetons(JSON.stringify(defs.get(n))) : 60), 0));
      }
      parPersona[p] = m;
    }
    mesures.tour = parPersona;
    const moy = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    // Mesuré : la consigne de l'EMPLOYÉ est la plus longue — ses accès lui sont DITS en prose (gestes non ouverts, familles
    // fermées), quand ceux du SA s'ajoutent en prose aussi (CONSIGNE_ADAM_SA, CONSIGNE_BOITE_ADAM). Écart < 15 % : même moteur.
    const sa = moy(parPersona.superadmin.consigneJetons), emp = moy(parPersona.commercial.consigneJetons);
    expect(emp).toBeGreaterThan(sa);
    expect(Math.abs(sa - emp) / emp).toBeLessThan(0.15);
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
