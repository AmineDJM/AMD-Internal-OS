/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I6 — LE REJEU RÉEL DES ENTRÉES REBRANCHÉES (décision 0070). Vrai modèle (gpt-6.1-terra), base de banc LOCALE
 * (`amd_bench`, semis du banc d'audit), ADAM_SORTIE_INTERDITE=1.
 *
 *   BENCH_SEED_ALLOW=1 npm run audit:assistant -- --semer        # une fois (le semis du banc d'audit)
 *   npm run banc:i6                                               # avant (ADAM_ANCIEN_MOTEUR=1) puis après (moteur unique)
 *   I6_PHASES=apres I6_BUDGET_USD=1 npm run banc:i6
 *
 * Chaque entrée est jouée PAR SON VRAI POINT D'ENTRÉE, sous la session du Super Admin du semis (hors requête HTTP,
 * `executerHorsRequete` : `requireUser` y rend la personne) :
 *   • bureau-flux : la route `/api/assistant/stream` (POST, flux SSE lu jusqu'au bout) ;
 *   • bureau-chat : l'action `assistantChat` (chat du Bureau, sans flux) ;
 *   • brain       : l'action `askBrain` (« Demander » d'Adventum Brain) ;
 *   • relance     : avant `assistantNudge`, après `relanceMoteurUnique` (un message interne non lu est semé pour elle) ;
 *   • voix        : `deleguerALaVoix` dans une session vocale ouverte (l'appel vocal du moteur unique) ;
 *   • ecrit       : `jouerTour` (la conversation écrite, référence).
 * Après, le Bureau (flux, chat) ne joue plus de tour : il rend « un seul moteur » et l'adresse de la conversation (0 appel) —
 * la conversation écrite EST son tour. AVANT = les quatre sous ADAM_ANCIEN_MOTEUR=1 (l'ancien moteur) ; APRÈS = toutes, deux passages (le second
 * mesure le cache chaud d'une entrée à l'autre). Jetons, cache et coût sont relus dans `ModelCallLog` (les deux moteurs
 * y écrivent), par personne et par fenêtre de temps. Sortie : `bench-out/i6-entrees.json` + un tableau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { executerHorsRequete } from "@/platform/ia/hors-requete";
import type { CurrentUser } from "@/lib/session";
import { COMPTE_JOUE, sessionDe } from "@/modules/assistant-ia/api-banc";
import * as svc from "@/modules/assistant-ia/api";
import { garde, lireSemis } from "../audit-assistant/semer";

const BUDGET = Number(process.env.I6_BUDGET_USD ?? "2.5");
const PHASES = (process.env.I6_PHASES ?? "avant,apres").split(",").map((s) => s.trim());
const SORTIE = process.env.I6_SORTIE ?? path.join(process.cwd(), "bench-out", "i6-entrees.json");

type Entree = "ecrit" | "bureau-flux" | "bureau-chat" | "brain" | "relance" | "voix";
interface Mesure {
  phase: string; entree: Entree; moteur: "ancien" | "unique"; ok: boolean; ms: number; reponse: string; cartes: number;
  appels: number; entree_jetons: number; cache_jetons: number; sortie_jetons: number; coutUsd: number; tauxCache: number; erreur?: string;
}

const DEMANDES: Record<Entree, string> = {
  "ecrit": "Cherche le dernier contrat signé avec Pharmagène dans le Drive.",
  "bureau-flux": "Donne-moi nos 3 missions en cours, avec leur état.",
  "bureau-chat": "Quelle est la masse salariale d'Adventum ce mois-ci ?",
  "brain": "Quels sont nos produits infectieux commercialisés ?",
  "relance": "(messages non lus)",
  "voix": "Combien de demandes de congé attendent ma validation ?",
};

let depense = 0;

async function semerMessageNonLu(sa: CurrentUser, autreId: string): Promise<void> {
  const conv = await prisma.conversation.create({ data: { type: "DIRECT", createdById: autreId } });
  await prisma.conversationMember.createMany({ data: [{ conversationId: conv.id, userId: sa.id }, { conversationId: conv.id, userId: autreId, lastReadAt: new Date() }] });
  await prisma.message.create({ data: { conversationId: conv.id, senderId: autreId, kind: "TEXT", body: `Bonjour, peux-tu me rappeler demain matin pour le devis de la clinique ? (${randomUUID().slice(0, 6)})` } });
}

async function lireFlux(rep: Response): Promise<{ ok: boolean; reply: string; error?: string }> {
  const texte = await rep.text();
  const evts = texte.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)) as { type: string; result?: { ok: boolean; reply: string; error?: string } });
  const done = evts.find((e) => e.type === "done")?.result;
  return done ? { ok: done.ok, reply: done.reply, error: done.error } : { ok: false, reply: "", error: `flux sans fin (${rep.status})` };
}

async function tourVoix(user: CurrentUser, texte: string): Promise<{ ok: boolean; reponse: string; cartes: number }> {
  const session = `banc-i6-${randomUUID()}`;
  await prisma.assistantIaVoixSession.create({ data: { id: session, userId: user.id } });
  const debut = Date.now();
  try {
    const r = await svc.deleguerALaVoix(user, texte, { session });
    let dit = r.pourVoix;
    const w = r.travail ? await prisma.assistantIaVoixTravail.findFirst({ where: { id: r.travail, userId: user.id }, select: { tourId: true } }) : null;
    while (w) {
      const rep = await prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant" }, orderBy: { createdAt: "desc" } });
      if (rep && (rep.etat === svc.ETAT.TERMINE || rep.etat === svc.ETAT.ECHEC)) { dit = `${dit}\n[annoncé ensuite] ${rep.contenu}`; break; }
      if (Date.now() - debut > 240_000) { dit += "\n[délai dépassé]"; break; }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    return { ok: true, reponse: dit, cartes: r.carte ? 1 : 0 };
  } finally {
    await prisma.assistantIaVoixSession.updateMany({ where: { id: session }, data: { fermeeLe: new Date() } });
  }
}

async function jouer(sa: CurrentUser, entree: Entree): Promise<{ ok: boolean; reponse: string; cartes: number; erreur?: string }> {
  const texte = DEMANDES[entree];
  switch (entree) {
    case "ecrit": {
      const r = await svc.jouerTour(sa, { texte, pieces: [], historique: [] });
      return r.ok ? { ok: true, reponse: r.content, cartes: r.intents.length } : { ok: false, reponse: "", cartes: 0, erreur: r.error };
    }
    case "bureau-flux": {
      const { POST } = await import("@/app/api/assistant/stream/route");
      const rep = await POST(new Request("http://banc.local/api/assistant/stream", { method: "POST", body: JSON.stringify({ history: [{ role: "user", content: texte }] }) }));
      const r = await lireFlux(rep);
      return { ok: r.ok, reponse: r.reply, cartes: 0, ...(r.error ? { erreur: r.error } : {}) };
    }
    case "bureau-chat": {
      const { assistantChat } = await import("@/lib/actions/assistant-actions");
      const r = await assistantChat([{ role: "user", content: texte }]);
      return { ok: r.ok, reponse: r.reply, cartes: r.proposals?.length ?? (r.proposal ? 1 : 0), ...(r.error ? { erreur: r.error } : {}) };
    }
    case "brain": {
      const { askBrain } = await import("@/lib/actions/adventum-actions");
      const r = await askBrain(texte);
      return { ok: r.ok, reponse: r.reply, cartes: (r.cartes?.length ?? 0) + r.proposals.length, ...(r.error ? { erreur: r.error } : {}) };
    }
    case "relance": {
      // Avant : `assistantNudge` (ancien moteur, sous le drapeau). Après : `relanceMoteurUnique` (module, `jouerTour`).
      if (process.env.ADAM_ANCIEN_MOTEUR === "1") {
        const { assistantNudge } = await import("@/lib/actions/assistant-actions");
        const r = await assistantNudge(`banc-${randomUUID()}`);
        return { ok: true, reponse: r.suggestion?.summary ?? "(aucune suggestion)", cartes: r.suggestion?.proposal ? 1 : 0 };
      }
      const { relanceMoteurUnique } = await import("@/modules/assistant-ia/actions");
      const r = await relanceMoteurUnique(`banc-${randomUUID()}`);
      if (!r.ok) return { ok: false, reponse: "", cartes: 0, erreur: r.erreur };
      return { ok: true, reponse: r.suggestion?.resume ?? "(aucune suggestion)", cartes: r.suggestion?.carte ? 1 : 0 };
    }
    case "voix":
      return tourVoix(sa, texte);
  }
}

async function mesurer(sa: CurrentUser, phase: string, entree: Entree, moteur: "ancien" | "unique"): Promise<Mesure> {
  if (depense >= BUDGET) throw new Error(`budget atteint (${depense.toFixed(3)} $ / ${BUDGET} $)`);
  if (moteur === "ancien") process.env.ADAM_ANCIEN_MOTEUR = "1"; else delete process.env.ADAM_ANCIEN_MOTEUR;
  const t0 = new Date(Date.now() - 50);
  const debut = Date.now();
  let r: { ok: boolean; reponse: string; cartes: number; erreur?: string };
  try {
    const issue = await executerHorsRequete(sa, "banc-i6", () => jouer(sa, entree));
    r = issue.resultat as typeof r;
  } catch (e) {
    r = { ok: false, reponse: "", cartes: 0, erreur: e instanceof Error ? e.message : String(e) };
  }
  const ms = Date.now() - debut;
  // Le journal des appels s'écrit en fin de tour, parfois juste après la réponse : on lui laisse un instant.
  await new Promise((ok) => setTimeout(ok, 1500));
  const lignes = await prisma.modelCallLog.findMany({
    where: { userId: sa.id, at: { gte: t0 } },
    select: { inputTokens: true, cachedInputTokens: true, outputTokens: true, costUsd: true },
  });
  const somme = (f: (l: (typeof lignes)[number]) => number) => lignes.reduce((s, l) => s + f(l), 0);
  const entreeJ = somme((l) => l.inputTokens);
  const cacheJ = somme((l) => l.cachedInputTokens);
  const sortieJ = somme((l) => l.outputTokens);
  // Le coût au tarif du banc (2 $ / 12 $ / 0,20 $ le million) — le même pour les deux moteurs.
  const cout = ((entreeJ - cacheJ) * 2 + cacheJ * 0.2 + sortieJ * 12) / 1_000_000;
  depense += cout;
  const m: Mesure = {
    phase, entree, moteur, ok: r.ok, ms, reponse: (r.reponse ?? "").slice(0, 600), cartes: r.cartes, appels: lignes.length,
    entree_jetons: entreeJ, cache_jetons: cacheJ, sortie_jetons: sortieJ, coutUsd: Number(cout.toFixed(5)),
    tauxCache: entreeJ ? Number((cacheJ / entreeJ).toFixed(3)) : 0, ...(r.erreur ? { erreur: r.erreur.slice(0, 300) } : {}),
  };
  console.log(`${phase.padEnd(8)} ${entree.padEnd(12)} ${moteur.padEnd(7)} ${r.ok ? "ok " : "KO "} ${String(ms).padStart(6)} ms · ${m.appels} appels · ${entreeJ} entrée (${cacheJ} cache, ${(m.tauxCache * 100).toFixed(0)} %) · ${sortieJ} sortie · ${m.coutUsd} $${m.erreur ? ` · ${m.erreur}` : ""}`);
  return m;
}

async function main() {
  garde();
  if (process.env.ADAM_SORTIE_INTERDITE !== "1") throw new Error("Refus : ADAM_SORTIE_INTERDITE=1 est exigé (aucun envoi réel).");
  for (const v of Object.keys(process.env)) if (/^(GOOGLE_|SMTP|WHATSAPP|VAPID|GITHUB_TOKEN|RENDER_)/.test(v)) throw new Error(`Refus : ${v} est posée dans ce processus.`);
  const S = lireSemis();
  if (!S) throw new Error("Semis absent : BENCH_SEED_ALLOW=1 npm run audit:assistant -- --semer");
  const sa = await sessionDe(S.users[COMPTE_JOUE.superadmin]);
  const autre = S.users[COMPTE_JOUE.commercial];
  // Brain et la relance : ouverts dans le Centre de contrôle IA, comme en production.
  await prisma.aiSetting.upsert({ where: { id: "global" }, update: { masterEnabled: true }, create: { id: "global", masterEnabled: true } as never });
  const mesures: Mesure[] = [];
  const ANCIEN: Entree[] = ["bureau-flux", "bureau-chat", "brain", "relance"];
  const UNIQUE: Entree[] = ["ecrit", "bureau-flux", "bureau-chat", "brain", "relance", "voix"];
  try {
    if (PHASES.includes("avant")) {
      for (const e of ANCIEN) {
        if (e === "relance") await semerMessageNonLu(sa, autre);
        mesures.push(await mesurer(sa, "avant", e, "ancien"));
      }
    }
    if (PHASES.includes("apres")) {
      for (const passage of ["apres-1", "apres-2"]) {
        for (const e of UNIQUE) {
          if (e === "relance") await semerMessageNonLu(sa, autre);
          mesures.push(await mesurer(sa, passage, e, "unique"));
        }
      }
    }
  } catch (e) {
    console.error("[banc-i6] arrêt :", e instanceof Error ? e.message : e);
  } finally {
    delete process.env.ADAM_ANCIEN_MOTEUR;
  }
  const resume = (xs: Mesure[]) => {
    const e = xs.reduce((s, m) => s + m.entree_jetons, 0);
    const c = xs.reduce((s, m) => s + m.cache_jetons, 0);
    const a = xs.reduce((s, m) => s + m.appels, 0);
    return { tours: xs.length, appels: a, jetonsEntreeParAppel: a ? Math.round(e / a) : 0, tauxCache: e ? Number((c / e).toFixed(3)) : 0, coutUsd: Number(xs.reduce((s, m) => s + m.coutUsd, 0).toFixed(4)), msMoyen: xs.length ? Math.round(xs.reduce((s, m) => s + m.ms, 0) / xs.length) : 0 };
  };
  const synthese = {
    avant: resume(mesures.filter((m) => m.phase === "avant")),
    apres: resume(mesures.filter((m) => m.phase.startsWith("apres"))),
    apresChaud: resume(mesures.filter((m) => m.phase === "apres-2")),
    depenseUsd: Number(depense.toFixed(4)),
  };
  fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
  fs.writeFileSync(SORTIE, JSON.stringify({ le: new Date().toISOString(), synthese, mesures }, null, 2));
  console.log(JSON.stringify(synthese, null, 2));
  await prisma.$disconnect();
}

void main();
