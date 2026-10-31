/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC UX DU LOT K3 (décision 0033) — SUR SERVEUR RÉEL : sous-missions en arrière-plan, tableau de bord en temps
 * réel, dépôt d'office. Pilote Chromium (Playwright) contre `next start` (APP_MODE=adventum-ia) et le worker à côté.
 *
 *   rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render
 *   APP_MODE=adventum-ia DATABASE_URL=…/amd_bench npx next start -p 3100
 *   TACHES_DE_FOND=les-deux DATABASE_URL=…/amd_bench npx tsx scripts/worker.ts
 *   npm run bench:live -- scripts/bench/k3-missions-ux.ts            (BASE=http://localhost:3100, SORTIE=dossier des captures)
 *
 * 1. BUREAU 1280 px — un message lance TROIS sous-missions (lecture + analyse + livrable), vrai modèle ; la carte se met
 *    à jour ; le tableau de bord suit les étapes (latence MESURÉE : l'instant où l'écran montre un changement d'étape,
 *    face à l'instant écrit en base) ; un second message reçoit sa réponse PENDANT que les sous-missions tournent ;
 *    la synthèse arrive dans la conversation.
 * 2. IPHONE 13 (390 px), clair et sombre — le tableau plein écran, l'indicateur ; aucun débordement horizontal.
 * 3. DÉPÔT D'OFFICE — 20 fichiers joints : la puce « 20 fichiers : tout lire en arrière-plan », l'envoi, la lecture
 *    complète par la Bibliothèque (lot : 20 lus).
 * Le coût réel (journal de consommation) est dit à la fin. Base de banc locale seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { prisma, estUneBaseDeBancOuDEssai } from "@/lib/prisma";

const BASE = process.env.BASE ?? "http://localhost:3100";
const SORTIE = process.env.SORTIE ?? path.resolve("bench-k3");
const EMAIL = process.env.EMAIL ?? "super@adventum-bench.dz";
const MDP = process.env.MDP ?? "Bench12345!";
const MESSAGE = "Lance en arrière-plan trois sous-missions en parallèle, sans attendre : (1) une LECTURE de mes tâches en cours, (2) une ANALYSE des demandes Ad & Pro de l'année (montants, retards), (3) un LIVRABLE : une note d'une page sur les dossiers réglementaires. Trois appels séparés de lancer_un_travail, puis on continue de discuter.";
const SECOND = "Pendant que ça tourne : rappelle-moi en une phrase ce que fait une sous-mission.";

const erreurs: string[] = [];
const mesures: Record<string, unknown> = {};
fs.mkdirSync(SORTIE, { recursive: true });
const capture = async (p: Page, nom: string) => { await p.screenshot({ path: path.join(SORTIE, `${nom}.png`) }); console.log(`📸 ${nom}.png`); };

async function connexion(b: Browser, opts: Parameters<Browser["newContext"]>[0]): Promise<Page> {
  const ctx = await b.newContext({ ...opts, baseURL: BASE });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") erreurs.push(`[${opts?.viewport?.width ?? "?"}] ${m.text().slice(0, 300)}`); });
  p.on("pageerror", (e) => erreurs.push(`[pageerror] ${e.message.slice(0, 300)}`));
  p.on("response", (r) => { if (r.status() >= 400) erreurs.push(`[${r.status()}] ${r.url().replace(BASE, "")}`); });
  await p.goto("/login");
  await p.fill("input[name=email]", EMAIL);
  await p.fill("input[name=password]", MDP);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }), p.click("button[type=submit]")]);
  await p.goto("/ia");
  await p.waitForSelector("[data-testid=adventum-ia]", { timeout: 60_000 });
  return p;
}

async function largeurOk(p: Page, nom: string) {
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  mesures[`largeur:${nom}`] = r;
  if (r.sw > r.w) erreurs.push(`[${nom}] débordement horizontal : scrollWidth ${r.sw} > ${r.w}`);
}

async function envoyer(p: Page, texte: string) {
  await p.fill("#aia-message", texte);
  await p.click("button[aria-label=Envoyer]");
}

/** L'observateur posé dans la page : chaque changement d'état d'une étape, à l'instant où l'écran le montre (une chaîne :
 *  le code transpilé d'une fonction ne passerait pas tel quel dans la page). */
const OBSERVER = `(() => {
  window.__k3 = [];
  const vus = new Map();
  const lire = () => {
    document.querySelectorAll("[data-testid=mission]").forEach((m) => {
      m.querySelectorAll("[data-etape]").forEach((e) => {
        const cle = m.dataset.mission + "|" + e.dataset.etape;
        if (vus.get(cle) !== e.dataset.etat) { vus.set(cle, e.dataset.etat || ""); window.__k3.push({ m: m.dataset.mission || "", e: e.dataset.etape || "", etat: e.dataset.etat || "", t: Date.now() }); }
      });
    });
  };
  new MutationObserver(lire).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-etat"] });
  lire();
})()`;

const FINIS = ["COMPLETED", "CANCELLED", "FAILED", "PARTIAL", "BLOCKED"];
const lireTransitions = (p: Page) => p.evaluate("window.__k3 ? window.__k3.splice(0) : []") as Promise<{ m: string; e: string; etat: string; t: number }[]>;

async function bureau(b: Browser) {
  const p = await connexion(b, { viewport: { width: 1280, height: 820 } });
  const moi = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } });
  await largeurOk(p, "bureau-accueil");
  // ── 1. Le message qui lance trois sous-missions ─────────────────────────────────────────────
  await envoyer(p, MESSAGE);
  const t0 = Date.now();
  await p.waitForSelector("[data-testid=carte-sous-missions] [data-testid=sous-mission]", { timeout: 240_000 });
  mesures.tourLancementS = Math.round((Date.now() - t0) / 1000);
  const ids = await p.$$eval("[data-testid=sous-mission]", (xs) => xs.map((x) => (x as HTMLElement).dataset.mission ?? ""));
  mesures.sousMissions = ids.length;
  // Celles qui attendent un accord (démarrage d'office coupé) : « Tout approuver » — sinon rien à faire.
  await p.waitForTimeout(1_500);
  const tout = p.getByRole("button", { name: /Tout approuver|Approuver et lancer/ });
  if (await tout.count()) await tout.first().click({ timeout: 5_000 }).catch(() => undefined);
  mesures.boutonApprouverVisible = await tout.count();

  // ── 2. La discussion continue AUSSITÔT, pendant que les sous-missions tournent ─────────────────
  const tours = () => prisma.assistantIaTour.count({ where: { userId: moi.id, role: "assistant", etat: "TERMINE", syntheseDe: null } });
  const avant = await tours();
  const t1 = new Date();
  await envoyer(p, SECOND);
  await capture(p, "01-bureau-carte-sous-missions-et-second-message");
  const limiteReponse = Date.now() + 180_000;
  while ((await tours()) <= avant && Date.now() < limiteReponse) await p.waitForTimeout(500);
  const t2 = new Date();
  mesures.reponsePendantMissionsS = Math.round((t2.getTime() - t1.getTime()) / 100) / 10;
  // Ce que les sous-missions ont fait PENDANT que la réponse s'écrivait (base, horodatages du moteur).
  mesures.etapesFaitesPendantLaReponse = await prisma.missionStep.count({ where: { missionId: { in: ids }, OR: [{ startedAt: { gte: t1, lte: t2 } }, { completedAt: { gte: t1, lte: t2 } }] } });
  await p.waitForTimeout(1200);
  await capture(p, "02-bureau-discussion-continue");

  // ── 3. Le tableau de bord, en temps réel ─────────────────────────────────────────────────────
  await p.click("[data-testid=indicateur-missions]");
  await p.waitForSelector("[data-testid=tableau-missions] [data-testid=mode-flux][data-mode=direct]", { timeout: 30_000 });
  for (const id of ids) await p.click(`[data-testid=mission][data-mission="${id}"] > button`).catch(() => undefined);
  await capture(p, "03-bureau-tableau-en-mouvement");
  const limite = Date.now() + 10 * 60_000;
  while (Date.now() < limite) {
    const ms = await prisma.mission.findMany({ where: { id: { in: ids } }, select: { status: true } });
    if (ms.length && ms.every((m) => FINIS.includes(m.status))) break;
    await p.waitForTimeout(2_000);
  }
  await p.waitForTimeout(2_000);
  const onglet = p.getByRole("tab", { name: /Terminées/ });
  await onglet.click();
  for (const id of ids) await p.click(`[data-testid=mission][data-mission="${id}"] > button`).catch(() => undefined);
  await capture(p, "04-bureau-tableau-termine");

  // EN PARALLÈLE ? Les fenêtres d'exécution des étapes de missions DIFFÉRENTES se chevauchent-elles ?
  const etapes = await prisma.missionStep.findMany({ where: { missionId: { in: ids }, startedAt: { not: null } }, select: { missionId: true, startedAt: true, completedAt: true, updatedAt: true } });
  let chevauchements = 0;
  for (const a of etapes) for (const c of etapes) {
    if (a.missionId >= c.missionId) continue;
    const fa = (a.completedAt ?? a.updatedAt).getTime(); const fc = (c.completedAt ?? c.updatedAt).getTime();
    if (a.startedAt!.getTime() < fc && c.startedAt!.getTime() < fa) chevauchements++;
  }
  mesures.parallele = { pairesDEtapesSimultanees: chevauchements };

  // ── 4. La synthèse dans la conversation ─────────────────────────────────────────────────────
  await p.click("[data-testid=tableau-missions] button[aria-label=Fermer]").catch(() => undefined);
  const synthese = await p.waitForFunction(() => /sous-missions sont finies|mission « .* » est/i.test(document.querySelector("[data-testid=adventum-ia] main")?.textContent ?? ""), undefined, { timeout: 120_000 }).then(() => true).catch(() => false);
  mesures.syntheseDansLaConversation = synthese;
  await p.mouse.move(700, 400);
  await p.mouse.wheel(0, -900);
  await p.waitForTimeout(500);
  await capture(p, "05-bureau-synthese-haut");
  await p.mouse.wheel(0, 4000);
  await p.waitForTimeout(500);
  await capture(p, "06-bureau-synthese-bas");
  const statuts = await prisma.mission.findMany({ where: { id: { in: ids } }, select: { title: true, status: true, costUsd: true, startedAt: true, updatedAt: true } });
  mesures.missions = statuts.map((m) => ({ titre: m.title, statut: m.status, coutUsd: m.costUsd, dureeS: m.startedAt ? Math.round((m.updatedAt.getTime() - m.startedAt.getTime()) / 1000) : null }));
  await largeurOk(p, "bureau-fin");

  // ── 5. LA LATENCE D'AFFICHAGE, mesurée sur une SONDE : une mission de 6 étapes dont le banc change l'état en base
  //       toutes les 1,5 s (hors moteur : ni bail, ni modèle) ; l'écran note l'instant où il montre chaque changement.
  const sonde = await prisma.mission.create({
    data: {
      kind: "TRAVAIL", ownerId: moi.id, principalId: moi.id, persona: "ASSISTANT_IA", title: "Sonde de latence du tableau", objective: "Mesurer la latence d'affichage.",
      status: "RUNNING", startedAt: new Date(), planVersion: 1,
      steps: { create: Array.from({ length: 6 }, (_, k) => ({ key: `s${k + 1}`, title: `Étape sonde ${k + 1}`, nodeType: "CAPABILITY", status: "PENDING" })) },
    },
    select: { id: true },
  });
  await p.click("[data-testid=indicateur-missions]");
  await p.getByRole("tab", { name: /En cours/ }).click();
  await p.waitForSelector(`[data-testid=mission][data-mission="${sonde.id}"]`, { timeout: 20_000 });
  await p.click(`[data-testid=mission][data-mission="${sonde.id}"] > button`);
  await p.evaluate(OBSERVER);
  const ecrits: { e: string; etat: string; t: number }[] = [];
  for (let k = 1; k <= 6; k++) {
    for (const [statut, etat] of [["RUNNING", "EN_COURS"], ["DONE", "FAITE"]] as const) {
      await p.waitForTimeout(1_500);
      const t = new Date();
      await prisma.missionStep.update({ where: { missionId_key: { missionId: sonde.id, key: `s${k}` } }, data: { status: statut, ...(statut === "RUNNING" ? { startedAt: t } : { completedAt: t }) } });
      ecrits.push({ e: `s${k}`, etat, t: t.getTime() });
      if (k === 3 && statut === "RUNNING") { await p.waitForTimeout(600); await capture(p, "07-bureau-tableau-sonde-en-mouvement"); }
    }
  }
  await p.waitForTimeout(3_000);
  const vus = (await lireTransitions(p)).filter((x) => x.m === sonde.id);
  const lat = ecrits.map((w) => { const v = vus.find((x) => x.e === w.e && x.etat === w.etat); return v ? v.t - w.t : null; }).filter((x): x is number => x !== null).sort((a, c) => a - c);
  const q = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))];
  mesures.latenceAffichageMs = { changements: ecrits.length, vus: lat.length, mediane: q(0.5), p95: q(0.95), max: lat[lat.length - 1] };
  await prisma.mission.delete({ where: { id: sonde.id } });
  await p.context().close();
}

async function iphone(b: Browser, sombre: boolean) {
  const nom = sombre ? "iphone-sombre" : "iphone-clair";
  const p = await connexion(b, { ...devices["iPhone 13"], colorScheme: sombre ? "dark" : "light" });
  await largeurOk(p, `${nom}-accueil`);
  await capture(p, `10-${nom}-entete-indicateur`);
  await p.click("[data-testid=indicateur-missions]");
  await p.waitForSelector("[data-testid=tableau-missions]");
  await p.waitForTimeout(1500);
  const onglet = p.getByRole("tab", { name: /Terminées/ });
  if (await onglet.count()) await onglet.click();
  const premiere = p.locator("[data-testid=mission] > button").first();
  if (await premiere.count()) await premiere.click();
  await p.waitForTimeout(600);
  await largeurOk(p, `${nom}-tableau`);
  await capture(p, `11-${nom}-tableau-plein-ecran`);
  // Les cibles tactiles du tableau : ≥ 44 px.
  const petites = await p.$$eval("[data-testid=tableau-missions] button", (bs) => bs.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5 && !x.closest("summary"); }).map((x) => `${x.textContent?.trim().slice(0, 30)} (${Math.round(x.getBoundingClientRect().height)} px)`));
  if (petites.length) mesures[`ciblesPetites:${nom}`] = petites;
  await p.context().close();
}

async function depotDOffice(b: Browser) {
  // Des noms PROPRES À CE PASSAGE : la même liste redéposée serait une REPRISE du lot d'avant (rien à relire).
  const passage = Date.now().toString(36);
  const dossier = path.join(SORTIE, `depot-20-${passage}`);
  fs.mkdirSync(dossier, { recursive: true });
  const fichiers = Array.from({ length: 20 }, (_, i) => {
    const f = path.join(dossier, `piece-${String(i + 1).padStart(2, "0")}-${passage}.txt`);
    fs.writeFileSync(f, `Pièce ${i + 1} du dépôt K3.\nProduit : Paracétamol ${100 + i} mg.\nObjet : variation de type IB n° ${i + 1}, déposée le ${i + 1} octobre 2026.\n`);
    return f;
  });
  const p = await connexion(b, { ...devices["iPhone 13"] });
  await p.setInputFiles("[data-testid=joindre-fichiers]", fichiers);
  await p.waitForSelector("[data-testid=puce-dossier]");
  mesures.libelleDepot = await p.textContent("[data-testid=libelle-depot]");
  await largeurOk(p, "iphone-depot");
  await capture(p, "20-iphone-depot-d-office-puce");
  const t0 = Date.now();
  const depuis = new Date().toISOString();
  await envoyer(p, "Lis tout ce dépôt et dis-moi quelles variations il contient.");
  // Le lot : 20 fichiers lus en entier par la Bibliothèque (8 min au plus).
  let lot: { annonces: number; lus: number; echoues: number } | null = null;
  while (Date.now() - t0 < 8 * 60_000) {
    await p.waitForTimeout(4_000);
    lot = await p.evaluate(async (d) => {
      const r = await fetch("/api/assistant-ia/depot-dossier", { cache: "no-store" });
      const b2 = (await r.json()) as { lots: { annonces: number; lus: number; echoues: number; createdAt: string }[] };
      return b2.lots.filter((l) => l.createdAt >= d).sort((a, c) => c.createdAt.localeCompare(a.createdAt))[0] ?? null;
    }, depuis);
    if (lot && lot.annonces === 20 && lot.lus + lot.echoues >= 20) break;
  }
  mesures.depot = { ...lot, dureeS: Math.round((Date.now() - t0) / 1000) };
  await capture(p, "21-iphone-depot-d-office-lu");
  await p.context().close();
}

async function main() {
  if (!estUneBaseDeBancOuDEssai(process.env.DATABASE_URL ?? "")) throw new Error("Refus : base de banc locale uniquement.");
  const debut = new Date();
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const etapes = (process.env.ETAPES ?? "bureau,iphone,depot").split(",");
  try {
    if (etapes.includes("bureau")) await bureau(b);
    if (etapes.includes("iphone")) { await iphone(b, false); await iphone(b, true); }
    if (etapes.includes("depot")) await depotDOffice(b);
  } finally {
    await b.close();
  }
  const u = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  const conso = await prisma.modelCallLog.aggregate({ where: { userId: u?.id, at: { gte: debut } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true });
  mesures.coutReel = { appels: conso._count, usd: Number(conso._sum.costUsd ?? 0), jetonsEntree: conso._sum.inputTokens, jetonsSortie: conso._sum.outputTokens };
  mesures.erreursConsole = erreurs;
  fs.writeFileSync(path.join(SORTIE, "mesures.json"), JSON.stringify(mesures, null, 2));
  console.log(JSON.stringify(mesures, null, 2));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
