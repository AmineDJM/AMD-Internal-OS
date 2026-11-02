/**
 * PREUVES DU LOT A1 (décision 0055) — « un seul assistant : Adam », sur un SERVEUR RÉEL et la base LOCALE.
 *
 *   DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_internal_os BASE=http://localhost:3100 npx tsx scripts/e2e/a1-adam.ts
 *
 * 1. Sème trois comptes de démonstration (Super Admin, deux déléguées médicales à qui Adam est ouvert, une sans Adam) et une
 *    mission confiée à Adam par chacune des deux — le moteur réel (`proposerTravail`), aucune donnée simulée en mémoire.
 * 2. Se connecte avec chacun, en iPhone et en bureau, et ASSERTE ce que l'écran montre (menu, onglets, missions, refus) avant
 *    d'écrire la capture dans `docs/assistant/preuves/a1/`. Une assertion qui tombe arrête le script : pas de capture fausse.
 * Aucun envoi réel : ADAM_SORTIE_INTERDITE=1 est attendu côté serveur ; rien ne part de ce script.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { proposerTravail } from "@/lib/missions/travaux/service";
import { PERSONA_ASSISTANT_IA } from "@/modules/assistant-ia/api";

const BASE = process.env.BASE ?? "http://localhost:3100";
const SORTIE = join(process.cwd(), "docs/assistant/preuves/a1");
const MDP = "Preuve-A1-2026!";
const DOMAINE = "@preuve-a1.local";

type Compte = { cle: string; nom: string; role: "SUPER_ADMIN" | "MEDICAL_DELEGATE"; adam: boolean };
const COMPTES: Compte[] = [
  { cle: "samia", nom: "Samia Benali", role: "SUPER_ADMIN", adam: true },
  { cle: "amina", nom: "Amina Kaci", role: "MEDICAL_DELEGATE", adam: true },
  { cle: "bilal", nom: "Bilal Haddad", role: "MEDICAL_DELEGATE", adam: true },
  { cle: "chafia", nom: "Chafia Mansouri", role: "MEDICAL_DELEGATE", adam: false },
];
const email = (c: Compte) => `${c.cle}${DOMAINE}`;

async function semer(): Promise<Record<string, { id: string; mission?: string }>> {
  const hash = await bcrypt.hash(MDP, 10);
  const out: Record<string, { id: string; mission?: string }> = {};
  for (const c of COMPTES) {
    const u = await prisma.user.upsert({
      where: { email: email(c) },
      update: { name: c.nom, role: c.role, passwordHash: hash, mustChangePassword: false, mustOnboard: false },
      create: { email: email(c), name: c.nom, role: c.role, passwordHash: hash, mustChangePassword: false, mustOnboard: false },
      select: { id: true },
    });
    await prisma.userAccess.deleteMany({ where: { userId: u.id, module: "ASSISTANT_IA" } });
    if (c.adam && c.role !== "SUPER_ADMIN") {
      await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    }
    out[c.cle] = { id: u.id };
  }
  // Une mission confiée à Adam par Amina, une par Bilal, une par le Super Admin — idempotent (par titre).
  for (const [cle, titre] of [
    ["amina", "Synthèse des visites de la semaine — Oran"],
    ["bilal", "Relance des pharmacies d'Annaba sans commande"],
    ["samia", "Point consolidé des paiements en attente"],
  ] as const) {
    const existante = await prisma.mission.findFirst({ where: { ownerId: out[cle]!.id, title: titre }, select: { id: true } });
    if (existante) { out[cle]!.mission = existante.id; continue; }
    const r = await proposerTravail(out[cle]!.id, PERSONA_ASSISTANT_IA, {
      titre, objectif: titre,
      etapes: [{ cle: "e0", type: "LIVRABLE", titre: "Note de synthèse", consigne: "Une note courte.", format: "md" }],
    }, { origine: "preuves-a1" });
    if (!r.ok) throw new Error(r.fautes.join(" "));
    out[cle]!.mission = r.travailId;
  }
  return out;
}

function attendre(cond: boolean, message: string) {
  if (!cond) throw new Error(`ASSERTION : ${message}`);
  console.log(`  ✓ ${message}`);
}

async function connecter(page: Page, c: Compte) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/e-?mail/i).fill(email(c));
  await page.getByLabel(/mot de passe/i).fill(MDP);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function capture(page: Page, nom: string) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SORTIE, `${nom}.png`), fullPage: false });
  console.log(`  📸 ${nom}.png`);
}

/** Le menu tel que la barre latérale le montre (bureau) — les liens de la navigation. */
async function liensDuMenu(page: Page): Promise<string[]> {
  return page.locator("aside a[href], nav a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
}

async function parcours(browser: Browser, ids: Record<string, { id: string; mission?: string }>, appareil: "iphone" | "bureau") {
  const contexte = () => browser.newContext(appareil === "iphone" ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } });
  const [samia, amina, , chafia] = COMPTES;

  // ── EMPLOYÉE AVEC ADAM ──────────────────────────────────────────────────────────────────
  {
    console.log(`[${appareil}] Amina (déléguée, Adam ouvert)`);
    const ctx = await contexte();
    const page = await ctx.newPage();
    await connecter(page, amina!);
    if (appareil === "bureau") {
      await page.goto(`${BASE}/mon-espace`);
      const liens = await liensDuMenu(page);
      attendre(liens.includes("/assistant"), "le menu d'Amina porte Adam (/assistant)");
      attendre(liens.includes("/centre-de-missions"), "le menu d'Amina porte « Missions d'Adam »");
      attendre(!liens.some((l) => l.startsWith("/chief-of-staff")), "aucun « My Chief of Staff » dans son menu");
      attendre(await page.getByRole("link", { name: "Adam", exact: true }).first().isVisible(), "l'entrée s'appelle « Adam »");
      await capture(page, `${appareil}-employe-menu`);
    }
    await page.goto(`${BASE}/assistant`);
    await page.waitForLoadState("networkidle").catch(() => {});
    attendre(await page.getByText("Je suis Adam, l'assistant d'Amina").first().isVisible(), "l'accueil : « Je suis Adam, l'assistant d'Amina »");
    attendre((await page.getByTestId("onglets-adam").count()) === 0, "pas d'onglets du Super Admin pour Amina");
    await capture(page, `${appareil}-employe-adam`);

    await page.goto(`${BASE}/centre-de-missions`);
    attendre(await page.getByText("Synthèse des visites de la semaine — Oran").first().isVisible(), "Amina voit SA mission");
    attendre((await page.getByText("Relance des pharmacies d'Annaba sans commande").count()) === 0, "Amina ne voit PAS la mission de Bilal");
    attendre((await page.getByTestId("vue-globale-missions").count()) === 0, "pas de vue globale pour Amina");
    await capture(page, `${appareil}-employe-missions`);

    const r = await page.goto(`${BASE}/missions/${ids.bilal!.mission}`);
    attendre(r?.status() === 404, "la fiche de la mission de Bilal rend 404 à Amina");
    const r2 = await page.goto(`${BASE}/chief-of-staff`);
    attendre(r2?.status() === 404, "/chief-of-staff reste introuvable pour Amina (refus inchangé)");

    await page.goto(`${BASE}/mon-espace/missions`);
    attendre(await page.getByRole("heading", { name: "Missions terrain" }).first().isVisible(), "« Mon espace › Missions terrain »");
    await capture(page, `${appareil}-employe-missions-terrain`);
    await ctx.close();
  }

  // ── EMPLOYÉE SANS ADAM ──────────────────────────────────────────────────────────────────
  if (appareil === "bureau") {
    console.log(`[${appareil}] Chafia (déléguée, SANS Adam)`);
    const ctx = await contexte();
    const page = await ctx.newPage();
    await connecter(page, chafia!);
    await page.goto(`${BASE}/mon-espace`);
    const liens = await liensDuMenu(page);
    attendre(!liens.includes("/assistant") && !liens.includes("/centre-de-missions"), "sans Adam : ni Adam ni ses missions au menu");
    const r = await page.goto(`${BASE}/centre-de-missions`);
    attendre(r?.status() === 404, "/centre-de-missions introuvable sans Adam");
    await ctx.close();
  }

  // ── SUPER ADMIN ─────────────────────────────────────────────────────────────────────────
  {
    console.log(`[${appareil}] Samia (Super Admin)`);
    const ctx = await contexte();
    const page = await ctx.newPage();
    await connecter(page, samia!);
    if (appareil === "bureau") {
      await page.goto(`${BASE}/mon-espace`);
      const liens = await liensDuMenu(page);
      attendre(liens.includes("/assistant") && liens.includes("/centre-de-missions"), "le menu du SA porte Adam et ses missions");
      attendre(!liens.some((l) => l.startsWith("/chief-of-staff")), "« My Chief of Staff » quitte aussi le menu du SA");
      await capture(page, `${appareil}-sa-menu`);
    }
    await page.goto(`${BASE}/chief-of-staff`);
    await page.waitForURL((u) => u.pathname === "/assistant", { timeout: 30_000 });
    attendre(new URL(page.url()).pathname === "/assistant", "/chief-of-staff mène le SA à l'écran d'Adam");
    attendre(await page.getByTestId("onglets-adam").isVisible(), "les onglets du SA sont là");
    for (const o of ["Conversation", "Boîte de réception", "Réglages d'Adam", "Bureau d'Adam"]) {
      attendre(await page.getByTestId("onglets-adam").getByRole("link", { name: o }).first().isVisible(), `onglet « ${o} »`);
    }
    await capture(page, `${appareil}-sa-adam-onglets`);

    await page.goto(`${BASE}/chief-of-staff/inbox`);
    await page.waitForURL((u) => u.pathname === "/adam/boite", { timeout: 30_000 });
    attendre(true, "/chief-of-staff/inbox → /adam/boite");
    await capture(page, `${appareil}-sa-boite`);
    await page.goto(`${BASE}/chief-of-staff/reglages`);
    await page.waitForURL((u) => u.pathname === "/adam/reglages", { timeout: 30_000 });
    attendre(true, "/chief-of-staff/reglages → /adam/reglages");
    await capture(page, `${appareil}-sa-reglages`);
    await page.goto(`${BASE}/adam/bureau`);
    attendre(await page.getByTestId("onglets-adam").isVisible(), "le bureau d'Adam s'ouvre dans son onglet");
    await capture(page, `${appareil}-sa-bureau`);

    await page.goto(`${BASE}/centre-de-missions`);
    attendre(await page.getByTestId("vue-globale-missions").isVisible(), "la vue globale du SA");
    const globale = page.getByTestId("vue-globale-missions");
    attendre(await globale.getByText("Amina Kaci").first().isVisible(), "la vue globale nomme Amina");
    attendre(await globale.getByText("Bilal Haddad").first().isVisible(), "la vue globale nomme Bilal");
    await capture(page, `${appareil}-sa-missions`);
    const r = await page.goto(`${BASE}/missions/${ids.amina!.mission}`);
    attendre(r?.status() === 200, "le SA lit la fiche de la mission d'Amina");
    attendre(await page.getByTestId("mission-lecture-seule").isVisible(), "… en lecture seule");
    await capture(page, `${appareil}-sa-fiche-autrui`);
    await ctx.close();
  }
}

async function main() {
  mkdirSync(SORTIE, { recursive: true });
  const ids = await semer();
  // Le Chromium préinstallé du conteneur quand la version de Playwright du projet n'a pas le sien (`PW_CHROMIUM`).
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    await parcours(browser, ids, "bureau");
    await parcours(browser, ids, "iphone");
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
  console.log("Preuves A1 : toutes les assertions tiennent.");
}

main().catch((e) => { console.error(e); process.exit(1); });
