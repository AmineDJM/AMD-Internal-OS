import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { jouerTour } from "./infra/fil/tour";
import { remplacerModelesPourTests } from "./infra/generer";
import { modeleFactice, type EtapeScenario } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { sessionDe } from "./infra/testing/audit/taches/aides";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * I5 (décision 0069) — LE BANC COURT DU CONTRÔLE FINAL, par le chemin du produit (`jouerTour`, faux modèle déterministe).
 *
 * Les cas réels de la Direction (03–04/11/2026), chacun joué DEUX fois :
 *   • AVANT  (`ADAM_CONTROLE_FINAL=0`, l'ancien comportement à l'identique) : l'affirmation fausse ARRIVE à l'écran — le
 *     défaut est reproduit (c'est ce qui « échoue avant ») ;
 *   • APRÈS  (contrôle actif) : l'écart est énoncé au modèle, le tour est rejoué UNE fois ; s'il récidive, la phrase est
 *     remplacée par le fait observé, marquée. Aucune affirmation fausse affichée.
 *
 * Mesures écrites dans `I5_BANC` (fichier JSON) si la variable est posée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `i5${Date.now().toString(36)}`;
let sa: CurrentUser;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
const mesures: Record<string, unknown> = {};

interface Cas {
  id: string;
  demande: string;
  historique?: { role: "user" | "assistant"; content: string }[];
  /** Le tour du modèle : ses gestes, puis son message FAUTIF. */
  premier: EtapeScenario[];
  /** Ce qu'il écrit à la reprise (récidive ou correction). */
  reprise: EtapeScenario[];
  /** La phrase fausse : elle ne doit pas s'afficher après. */
  faux: RegExp;
  /** Ce que le message affiché doit porter après (la correction, ou la rectification marquée). */
  attendu: RegExp;
}

const CAS: Cas[] = [
  {
    id: "mail-simple", demande: "Il est comment exactement, le mail que tu m'as proposé ? Décris sa mise en forme.",
    historique: [
      { role: "user", content: "Prépare un mail tout simple, sans design, à Radia : la réunion de jeudi est décalée." },
      { role: "assistant", content: "J'ai préparé le mail.\n\n[Observé par le serveur — état actuel, relu en base :\n- carte (id cmi5carte000000000000001) — état : proposée — attend la confirmation de la personne ; rien n'est exécuté ; titre : Envoyer par le Gmail d'Adam ; expéditeur : adam@adventum.dz ; à : radia@adventum.dz ; objet : Réunion décalée ; rendu : HTML à la charte — bandeau #087084, 1 tableau]" },
    ],
    premier: [reponse("C'est un mail tout simple, en texte brut, sans aucune mise en forme.")],
    reprise: [reponse("Je me suis trompé : le mail proposé est rendu à la charte (bandeau #087084, un tableau), pas en texte brut. Dis-moi si tu veux que je le refasse sans mise en forme.")],
    faux: /en texte brut, sans aucune mise en forme/, attendu: /rendu à la charte/,
  },
  {
    id: "produits-commercialises", demande: "Quels sont nos produits infectieux commercialisés ?",
    premier: [{ appel: { outil: "lire", entree: { table: "RegulatoryProduct", filtres: [{ champ: "brandName", op: "contient", valeur: TAG }] } } }, reponse("Je ne peux pas confirmer lesquels sont commercialisés.")],
    // Récidive : la même dérobade — la phrase est remplacée par le fait observé.
    reprise: [reponse("Je ne peux pas confirmer lesquels sont commercialisés.")],
    faux: /^Je ne peux pas confirmer/, attendu: /Rectifié par le contrôle : la lecture « .+ » a rendu 2 ligne\(s\)/,
  },
  {
    // Le rejeu réel du 04/11 (S2) : une lecture au filtre trop étroit rend 0 ligne, et le modèle conclut « aucun ».
    id: "produits-filtre-etroit", demande: "Quels sont nos produits anti-infectieux commercialisés ?",
    premier: [{ appel: { outil: "lire", entree: { table: "RegulatoryProduct", filtres: [{ champ: "brandName", op: "contient", valeur: TAG }, { champ: "therapeuticClass", op: "contient", valeur: "cardiologie" }] } } }, reponse("Je n'ai trouvé aucun produit commercialisé classé comme anti-infectieux.")],
    reprise: [reponse("Je n'ai trouvé aucun produit commercialisé classé comme anti-infectieux.")],
    faux: /^Je n'ai trouvé aucun produit/, attendu: /Rectifié par le contrôle : la lecture « .+ » a rendu 0 ligne avec ses filtres, mais la base en porte : sans « therapeuticClass/,
  },
  {
    id: "ou-en-est-la-mission", demande: "Où en est la mission ?",
    premier: [{ appel: { outil: "mes_missions", entree: {} } }, reponse("Ta mission est prête : elle part dans moins d'une minute.")],
    reprise: [reponse("La mission « Veille prix " + "anti-infectieux » n'a démarré aucune étape depuis 2 h, et le balayage est passé sans la prendre.")],
    faux: /moins d'une minute/, attendu: /aucune étape depuis 2 h/,
  },
  {
    id: "masse-salariale", demande: "Quelle est la masse salariale d'Adventum ce mois-ci ?",
    premier: [reponse("La masse salariale d'Adventum ce mois-ci est de 14 250 000 DZD.")],
    reprise: [reponse("Je n'ai pas lu la paie dans ce tour : je ne peux pas te donner ce montant sans la lire. Veux-tu que je la lise ?")],
    faux: /14 250 000/, attendu: /pas lu la paie/,
  },
  {
    id: "action-sans-outil", demande: "Envoie à Karim que la réunion est décalée.",
    premier: [reponse("C'est envoyé à Karim.")],
    reprise: [reponse("C'est envoyé à Karim, il est prévenu.")],
    faux: /C'est envoyé/, attendu: /Rectifié par le contrôle : aucun envoi n'a été fait ni préparé dans ce tour/,
  },
];

async function jouer(c: Cas, coupe: boolean) {
  const avant = process.env.ADAM_CONTROLE_FINAL;
  if (coupe) process.env.ADAM_CONTROLE_FINAL = "0"; else delete process.env.ADAM_CONTROLE_FINAL;
  try {
    const faux = modeleFactice([...c.premier, ...c.reprise]);
    remplacerModelesPourTests([faux.modele as never]);
    const r = await jouerTour(sa, { texte: c.demande, pieces: [], historique: c.historique ?? [] });
    if (!r.ok) throw new Error(r.error);
    return { content: r.content, controle: r.controle ?? null, appelsDuModele: faux.toursJoues() };
  } finally {
    if (avant === undefined) delete process.env.ADAM_CONTROLE_FINAL; else process.env.ADAM_CONTROLE_FINAL = avant;
  }
}

suite("I5 — le contrôle final, cas réels : faux avant, juste après", () => {
  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    const u = await prisma.user.create({ data: { email: `amine.${TAG}@adventum-test.dz`, name: `Amine ${TAG}`, role: "SUPER_ADMIN", passwordHash: "x", isActive: true } });
    sa = await sessionDe(u.id);
    // Deux produits anti-infectieux du banc (la lecture rend des lignes).
    for (const [i, nom] of ["Clavumox", "Cefazine"].entries()) {
      await prisma.regulatoryProduct.create({ data: { reference: `REG-${TAG}-${i}`, dci: "Amoxicilline", brandName: `${nom} ${TAG}`, therapeuticClass: "Anti-infectieux", status: "DECISION_OBTAINED" } });
    }
    // Une mission APPROUVÉE il y a 2 h, 0/2 étapes (le cas de production du 03/11).
    const ilYa2h = new Date(Date.now() - 2 * 3600_000);
    const m = await prisma.mission.create({ data: {
      kind: "TRAVAIL", ownerId: u.id, principalId: u.id, title: "Veille prix anti-infectieux", objective: "Veille", status: "READY", createdAt: ilYa2h, planApprouveLe: ilYa2h,
      steps: { create: [{ key: "s1", title: "Lire les données", status: "READY", nodeType: "CAPABILITY", createdAt: ilYa2h }, { key: "s2", title: "Rédiger", status: "PENDING", nodeType: "WORKER", createdAt: ilYa2h }] },
    } as never, select: { id: true } });
    await prisma.$executeRaw`UPDATE "Mission" SET "updatedAt" = ${ilYa2h} WHERE "id" = ${m.id}`;
  }, 60_000);

  afterEach(() => remplacerModelesPourTests(null));

  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    if (process.env.I5_BANC) { fs.mkdirSync(process.env.I5_BANC.replace(/\/[^/]+$/, ""), { recursive: true }); fs.writeFileSync(process.env.I5_BANC, JSON.stringify(mesures, null, 2)); }
    if (!sa) return;
    await effacerJournalDe([sa.id]);
    await prisma.missionStep.deleteMany({ where: { mission: { principalId: sa.id } } }).catch(attendu("test I5 : étapes", null));
    await prisma.mission.deleteMany({ where: { principalId: sa.id } }).catch(attendu("test I5 : missions", null));
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: `REG-${TAG}` } } }).catch(attendu("test I5 : produits", null));
    await prisma.user.deleteMany({ where: { id: sa.id } }).catch(attendu("test I5 : compte", null));
  }, 60_000);

  for (const c of CAS) {
    it(`${c.id} — avant : l'affirmation fausse s'affiche ; après : reprise unique, rien de faux affiché`, async () => {
      const avant = await jouer(c, true);
      expect(avant.content, "AVANT : le défaut doit être reproduit").toMatch(c.faux);
      expect(avant.controle).toBeNull();

      const apres = await jouer(c, false);
      expect(apres.content, apres.content).not.toMatch(c.faux);
      expect(apres.content, apres.content).toMatch(c.attendu);
      expect(apres.controle?.reprise).toBe(true);
      expect(apres.controle?.ecarts.length).toBeGreaterThan(0);
      // UNE reprise, jamais deux : le modèle a rédigé deux fois (plus ses gestes du premier passage).
      expect(apres.appelsDuModele).toBe(c.premier.length + c.reprise.length);
      mesures[c.id] = { avant: avant.content, apres: apres.content, ecarts: apres.controle?.ecarts, recidives: apres.controle?.recidives, rectifiees: apres.controle?.rectifiees };
    }, 60_000);
  }

  it("un message juste ne coûte rien : pas de reprise", async () => {
    const r = await jouer({ id: "juste", demande: "Bonjour", premier: [reponse("Bonjour ! Que puis-je faire pour toi ?")], reprise: [], faux: /$^/, attendu: /Bonjour/ }, false);
    expect(r.controle?.reprise).toBe(false);
    expect(r.appelsDuModele).toBe(1);
  }, 60_000);
});
