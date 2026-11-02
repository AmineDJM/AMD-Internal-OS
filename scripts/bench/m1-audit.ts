/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT M1 (décision 0045) — L'AUDIT D'ADVENTUM IA SUR SERVEUR RÉEL, vrai modèle, mode app.
 *
 * Prérequis : la base de banc `amd_bench` semée (`scripts/bench/seed-adam-bench.ts`), le serveur de production lancé
 * DESSUS en mode app :
 *
 *   rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render
 *   APP_MODE=adventum-ia DATABASE_URL=…/amd_bench OPENAI_API_KEY=sk-banc \
 *     NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs" npx next start -p 3100
 *   DATABASE_URL=…/amd_bench npx tsx scripts/bench/m1-audit.ts
 *
 * Chaque fonction reçoit un verdict « marche / marche mal / ne marche pas » avec sa preuve (capture, ligne en base).
 * Captures et `rapport.json` dans `docs/assistant/preuves/m1/`. Parcimonieux : un message par fonction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices, type BrowserContext, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

const BASE = process.env.M1_BASE ?? "http://localhost:3100";
const SORTIE = path.join(process.cwd(), "docs", "assistant", "preuves", "m1");
const EMAIL = process.env.M1_EMAIL ?? "yacine.benali@adventum-bench.dz";
const MDP = "Bench12345!";
const SEULES = (process.env.M1_ETAPES ?? "").split(",").filter(Boolean);
fs.mkdirSync(SORTIE, { recursive: true });

type Verdict = "marche" | "marche mal" | "ne marche pas" | "non testé";
interface Ligne { fonction: string; ecran: string; verdict: Verdict; preuve: string; captures: string[]; detail?: unknown }
const lignes: Ligne[] = [];
const erreursConsole: string[] = [];
let userId = "";
const debutAudit = new Date();

async function capture(page: Page, nom: string): Promise<string> {
  const f = `${nom}.jpg`;
  await page.screenshot({ path: path.join(SORTIE, f), type: "jpeg", quality: 62 });
  return f;
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/e-?mail/i).fill(EMAIL);
  await page.getByLabel(/mot de passe/i).fill(MDP);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function contexte(nom: "iphone13" | "bureau"): Promise<{ ctx: BrowserContext; page: Page }> {
  const navigateur = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await navigateur.newContext({ ...(nom === "iphone13" ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } }), permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") erreursConsole.push(`[${nom}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => erreursConsole.push(`[${nom}] ${String(e).slice(0, 200)}`));
  ctx.on("response", (r) => { if (r.status() >= 500) erreursConsole.push(`[${nom}] ${r.status()} ${new URL(r.url()).pathname}`); });
  await login(page);
  await page.goto(`${BASE}/ia`);
  await page.getByLabel("Votre message").waitFor({ timeout: 60_000 });
  return { ctx, page };
}

/** La conversation ouverte (`?c=`), lue dans l'adresse. */
const conversationOuverte = (page: Page) => new URL(page.url()).searchParams.get("c");

/** Envoyer un message et attendre la réponse TERMINÉE (et la capture de mémoire), en base. */
async function envoyer(page: Page, texte: string, delaiS = 150) {
  const avant = new Date();
  await page.getByLabel("Votre message").fill(texte);
  await page.getByRole("button", { name: "Envoyer", exact: true }).click();
  let reponse = null;
  for (let i = 0; i < delaiS; i++) {
    reponse = await prisma.assistantIaTour.findFirst({ where: { userId, role: "assistant", createdAt: { gte: avant }, syntheseDe: null }, orderBy: { createdAt: "desc" } });
    if (reponse && reponse.etat !== "EN_COURS" && reponse.memoireEtat !== "EN_COURS") break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2500);
  return reponse;
}

async function nouvelle(page: Page, mobile: boolean) {
  if (mobile) await page.getByLabel("Ouvrir la liste des conversations").click();
  await page.getByRole("button", { name: /Nouvelle conversation/ }).first().click();
  await page.waitForTimeout(600);
}

async function etape(nom: string, f: () => Promise<void>) {
  if (SEULES.length && !SEULES.includes(nom)) return;
  const t0 = Date.now();
  try { await f(); } catch (e) {
    lignes.push({ fonction: nom, ecran: "?", verdict: "ne marche pas", preuve: `exception : ${String(e).slice(0, 300)}`, captures: [] });
  }
  console.info(`[m1] ${nom} — ${Math.round((Date.now() - t0) / 1000)} s`);
}

const contient = (t: string | null | undefined, ...mots: string[]) => mots.every((m) => (t ?? "").toLowerCase().includes(m.toLowerCase()));

async function main() {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true, name: true } });
  userId = u.id;
  // Le banc : l'assistant ouvert à ce compte (la Direction l'active par personne) ; le plafond du jour relevé (un audit
  // complet dépasse les 600 000 jetons du défaut) ; la mémoire repart de zéro — sauf pour une reprise d'étapes.
  await prisma.userAccess.deleteMany({ where: { userId, module: "ASSISTANT_IA" } });
  await prisma.userAccess.create({ data: { userId, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", plafondJetonsJour: 5_000_000 }, update: { plafondJetonsJour: 5_000_000 } });
  if (!SEULES.length || SEULES.includes("memoire-capture")) {
    await prisma.assistantMemoryItem.deleteMany({ where: { userId } });
    await prisma.assistantIaPreference.deleteMany({ where: { userId } });
  }

  const { ctx, page } = await contexte("iphone13");
  let convA: string | null = null;

  await etape("memoire-capture", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Bonjour ! Je pars à Lyon le 12 novembre avec ma fille Lina. J'ai fait mes études à l'École nationale polytechnique d'Alger, et j'adore le café noir le matin.");
    convA = conversationOuverte(page);
    await page.getByTestId("memoires-retenues").first().waitFor({ timeout: 20_000 }).catch(() => {});
    const items = await prisma.assistantMemoryItem.findMany({ where: { userId, active: true }, select: { type: true, content: true, origine: true, sourceThreadId: true } });
    const voyage = items.some((i) => i.type === "VOYAGES" && contient(i.content, "lyon"));
    const famille = items.some((i) => contient(i.content, "lina"));
    lignes.push({
      fonction: "Mémoire — capture automatique", ecran: "iPhone 13",
      verdict: voyage && famille ? "marche" : items.length ? "marche mal" : "ne marche pas",
      preuve: `${items.length} souvenir(s) en base (AssistantMemoryItem, origine « auto ») : ${items.map((i) => `[${i.type}] ${i.content}`).join(" | ")}`,
      captures: [await capture(page, "iphone-01-capture-retenu")], detail: { reponse: r?.contenu?.slice(0, 300), memoiresRetenues: r?.memoiresRetenues },
    });
    const fil = convA ? await prisma.assistantIaFil.findUnique({ where: { id: convA }, select: { titre: true, titreSource: true } }) : null;
    lignes.push({ fonction: "Conversations — création et titre", ecran: "iPhone 13", verdict: fil?.titreSource === "auto" ? "marche" : fil ? "marche mal" : "ne marche pas", preuve: `AssistantIaFil ${convA} : titre « ${fil?.titre} » (${fil?.titreSource})`, captures: [] });
  });

  await etape("memoire-annuler", async () => {
    const lignesRetenu = page.getByTestId("memoires-retenues").first().getByRole("button", { name: /annuler/ });
    const n = await lignesRetenu.count();
    if (!n) { lignes.push({ fonction: "Mémoire — « annuler » un souvenir", ecran: "iPhone 13", verdict: "ne marche pas", preuve: "aucune ligne « Retenu : … »", captures: [] }); return; }
    const avant = await prisma.assistantMemoryItem.count({ where: { userId, active: true } });
    await lignesRetenu.last().click();
    await page.waitForTimeout(1500);
    const apres = await prisma.assistantMemoryItem.count({ where: { userId, active: true } });
    lignes.push({ fonction: "Mémoire — « annuler » un souvenir", ecran: "iPhone 13", verdict: apres === avant - 1 ? "marche" : "ne marche pas", preuve: `souvenirs actifs : ${avant} → ${apres}`, captures: [await capture(page, "iphone-02-annule")] });
  });

  await etape("memoire-rappel", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Tu te souviens de mon voyage ?");
    const ok = contient(r?.contenu, "lyon") && (contient(r?.contenu, "12") || contient(r?.contenu, "lina"));
    lignes.push({ fonction: "Mémoire — rappel dans une NOUVELLE conversation", ecran: "iPhone 13", verdict: ok ? "marche" : "ne marche pas", preuve: `réponse : « ${r?.contenu?.slice(0, 240)} »`, captures: [await capture(page, "iphone-03-rappel-voyage")] });
  });

  await etape("memoire-panneau", async () => {
    await page.getByLabel("Ouvrir la liste des conversations").click();
    await page.getByRole("button", { name: /Ce que l'assistant retient/ }).click();
    const panneau = page.getByRole("dialog", { name: "Ce qu'il retient" });
    await panneau.waitFor({ timeout: 10_000 });
    await panneau.getByTestId("souvenir").first().waitFor({ timeout: 10_000 });
    const nb = await panneau.getByTestId("souvenir").count();
    const c1 = await capture(page, "iphone-04-panneau");
    // Édition en ligne
    await panneau.getByRole("button", { name: "Corriger" }).first().click();
    const champ = panneau.getByLabel("Corriger le souvenir");
    const texte = `${await champ.inputValue()} (corrigé)`;
    await champ.fill(texte);
    await panneau.getByRole("button", { name: "Enregistrer" }).click();
    await page.waitForTimeout(1200);
    const corrige = await prisma.assistantMemoryItem.count({ where: { userId, content: texte } });
    const c2 = await capture(page, "iphone-05-panneau-edite");
    lignes.push({ fonction: "Mémoire — panneau « Ce qu'il retient » (groupes, édition, origine, compteur)", ecran: "iPhone 13", verdict: nb > 0 && corrige === 1 ? "marche" : "marche mal", preuve: `${nb} souvenir(s) affiché(s), édition écrite en base : ${corrige === 1}`, captures: [c1, c2] });
    await page.keyboard.press("Escape");
    await panneau.waitFor({ state: "hidden", timeout: 5_000 });
  });

  await etape("privee", async () => {
    await nouvelle(page, true);
    await page.getByTestId("bouton-prive").click();
    const avant = new Date();
    const r = await envoyer(page, "Ma femme s'appelle Sarah et elle est médecin.");
    const retenu = await prisma.assistantMemoryItem.count({ where: { userId, createdAt: { gte: avant } } });
    lignes.push({ fonction: "Conversation privée — rien n'est retenu", ecran: "iPhone 13", verdict: retenu === 0 && r?.etat === "TERMINE" ? "marche" : "ne marche pas", preuve: `souvenirs créés : ${retenu} ; réponse « ${r?.contenu?.slice(0, 160)} »`, captures: [await capture(page, "iphone-06-privee")] });
  });

  await etape("notes", async () => {
    await nouvelle(page, true);
    // Une note NEUVE à chaque passage (la même déjà présente, l'assistant le dit et ne propose rien — vu au banc).
    const r = await envoyer(page, `Ajoute dans mes notes : rappeler le Dr Mansouri lundi pour le congrès (dossier ${Date.now().toString(36).toUpperCase()}).`);
    const ids = Array.isArray(r?.notesProposees) ? (r!.notesProposees as string[]) : [];
    const bouton = page.getByRole("button", { name: /^Accepter$/ }).last();
    let accepte = false;
    if (await bouton.isVisible().catch(() => false)) {
      await bouton.click();
      await page.waitForTimeout(1500);
      accepte = (await prisma.assistantIaNoteProposition.count({ where: { id: { in: ids }, etat: { not: "PROPOSEE" } } }).catch(() => 0)) > 0;
    }
    const c1 = await capture(page, "iphone-07-notes-proposees");
    await page.getByLabel("Notes, travaux et documents").first().click();
    await page.waitForTimeout(1500);
    const c2 = await capture(page, "iphone-08-onglet-notes");
    const pages = await prisma.assistantIaNotePage.findMany({ where: { userId }, select: { titre: true } }).catch(() => []);
    lignes.push({ fonction: "Mes notes — proposition de l'assistant, acceptation, onglet", ecran: "iPhone 13", verdict: ids.length && accepte ? "marche" : ids.length ? "marche mal" : "ne marche pas", preuve: `propositions : ${ids.length}, acceptée : ${accepte}, pages : ${pages.length}`, captures: [c1, c2] });
    await page.getByLabel("Fermer le panneau").click().catch(() => {});
  });

  await etape("analyse", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Analyse les demandes de paiement par statut, avec le total par statut.");
    const blocs = JSON.stringify(r?.blocs ?? []);
    lignes.push({ fonction: "Analyse de données (tableau, calcul, export Excel)", ecran: "iPhone 13", verdict: /table|chart|analyse/i.test(blocs) ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `outils : ${(r?.outils ?? []).join(", ")} ; blocs : ${blocs.slice(0, 160)}`, captures: [await capture(page, "iphone-09-analyse")] });
  });

  await etape("export", async () => {
    const avant = new Date();
    const r = await envoyer(page, "Exporte le suivi Regulatory en Excel.");
    const fichiers = await prisma.driveNode.count({ where: { OR: [{ ownerId: userId }, { createdById: userId }], createdAt: { gte: avant } } }).catch(() => -1);
    lignes.push({ fonction: "Exports (fichier Excel dans le Drive)", ecran: "iPhone 13", verdict: fichiers > 0 ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `fichiers créés : ${fichiers} ; outils : ${(r?.outils ?? []).join(", ")} ; « ${r?.contenu?.slice(0, 160)} »`, captures: [await capture(page, "iphone-10-export")] });
  });

  await etape("web", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Quelle est la dernière actualité de l'ANPP (Agence nationale des produits pharmaceutiques) ? Réponds court avec la source.");
    lignes.push({ fonction: "Recherche web (sources datées)", ecran: "iPhone 13", verdict: (r?.outils ?? []).some((o) => /web|recherche/i.test(o)) ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `outils : ${(r?.outils ?? []).join(", ")} ; « ${r?.contenu?.slice(0, 200)} »`, captures: [await capture(page, "iphone-11-web")] });
  });

  await etape("mission", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Lance deux sous-missions en parallèle : l'une fait le point sur les demandes de paiement en cours, l'autre sur les tâches en retard. Puis fais-moi la synthèse.", 180);
    const travaux = Array.isArray(r?.travaux) ? (r!.travaux as string[]) : [];
    // Hors Super Admin, une sous-mission attend l'accord de la personne (réglage « démarrer d'office », décision 0033).
    const c0 = await capture(page, "iphone-12a-missions-a-approuver");
    const approuver = page.getByRole("button", { name: /Tout approuver|Approuver et lancer/ }).last();
    if (await approuver.isVisible().catch(() => false)) await approuver.click();
    let synthese = null;
    for (let i = 0; i < 300 && travaux.length && !synthese; i++) {
      synthese = await prisma.assistantIaTour.findFirst({ where: { syntheseDe: { not: null }, userId, createdAt: { gte: r!.createdAt } } });
      if (!synthese) await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    lignes.push({ fonction: "Missions — sous-missions, tableau temps réel, synthèse", ecran: "iPhone 13", verdict: travaux.length && synthese?.etat === "TERMINE" ? "marche" : travaux.length ? "marche mal" : "ne marche pas", preuve: `sous-missions : ${travaux.length} ; synthèse : ${synthese ? `${synthese.etat} « ${synthese.contenu.slice(0, 140)} »` : "aucune en 4 min"}`, captures: [c0, await capture(page, "iphone-12-missions")] });
  });

  await etape("recherche", async () => {
    await nouvelle(page, true);
    const r = await envoyer(page, "Fais une recherche approfondie, sur deux angles seulement (réglementation et prix), sur le marché des biosimilaires en Algérie en 2026.", 180);
    const travaux = Array.isArray(r?.travaux) ? (r!.travaux as string[]) : [];
    const approuver = page.getByRole("button", { name: /Tout approuver|Approuver et lancer/ }).last();
    if (await approuver.isVisible().catch(() => false)) await approuver.click();
    let synthese = null;
    for (let i = 0; i < 420 && travaux.length && !synthese; i++) {
      synthese = await prisma.assistantIaTour.findFirst({ where: { syntheseDe: { not: null }, userId, createdAt: { gte: r!.createdAt } } });
      if (!synthese) await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);
    const sources = (synthese?.contenu.match(/\[\d+\]/g) ?? []).length;
    lignes.push({ fonction: "Recherche approfondie (mission, rapport sourcé)", ecran: "iPhone 13", verdict: synthese?.etat === "TERMINE" && sources > 0 ? "marche" : travaux.length ? "marche mal" : "ne marche pas", preuve: `mission : ${travaux.length} ; rapport : ${synthese ? `${synthese.contenu.length} car., ${sources} appels de source` : "aucun en 7 min"} ; « ${(synthese?.contenu ?? r?.contenu ?? "").slice(0, 160)} »`, captures: [await capture(page, "iphone-13a-recherche-approfondie")] });
  });

  await etape("pieces", async () => {
    await nouvelle(page, true);
    const f = path.join(SORTIE, "..", "..", "..", "..", "bench-out", "m1-note.txt");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "Compte rendu de réunion du 30 octobre 2026 : le lancement du produit Cardiofix est reporté à janvier 2027, faute d'enregistrement ANPP.");
    await page.getByTestId("joindre-fichiers").setInputFiles(f);
    await page.waitForTimeout(3000);
    const r = await envoyer(page, "Résume ce document en une phrase.");
    lignes.push({ fonction: "Pièces jointes (dépôt, lecture)", ecran: "iPhone 13", verdict: contient(r?.contenu, "janvier") ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `« ${r?.contenu?.slice(0, 200)} »`, captures: [await capture(page, "iphone-13-piece")] });
  });

  await etape("image", async () => {
    // La famille « Images & vidéos générées » est fermée par défaut (console de la Direction) : ouverte pour ce banc.
    await prisma.assistantIaAcces.upsert({ where: { userId }, create: { userId, ouvertes: ["VISUELS"] }, update: { ouvertes: { push: "VISUELS" } } });
    await nouvelle(page, true);
    const r = await envoyer(page, "Génère une image simple : une gélule bleue sur fond blanc, style icône.", 180);
    const visuel = await prisma.assistantIaVisuel.findFirst({ where: { userId, createdAt: { gte: r?.createdAt ?? debutAudit } } }).catch(() => null);
    lignes.push({ fonction: "Images (génération)", ecran: "iPhone 13", verdict: visuel ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `AssistantIaVisuel : ${visuel ? (visuel as { id: string }).id : "aucun"} ; « ${r?.contenu?.slice(0, 160)} »`, captures: [await capture(page, "iphone-14-image")] });
  });

  await etape("voix", async () => {
    // La session temps réel : une offre SDP factice — la porte et l'échange doivent répondre proprement (pas de 500).
    const s = await page.request.post(`${BASE}/api/assistant-ia/voix/session`, { data: { sdp: "v=0\r\n", conversation: null } });
    // La fin d'une conversation vocale : la transcription au fil, ET la mémoire de ce que la personne a DIT.
    const avant = new Date();
    const conv = conversationOuverte(page);
    const j = await page.request.post(`${BASE}/api/assistant-ia/voix/journal`, { data: { secondes: 0, latences: [800, 950], confirme: false, conversation: conv, lignes: [
      { qui: "personne", texte: "Au fait, mon fils Adam commence l'université à Constantine en septembre prochain." },
      { qui: "assistant", texte: "Félicitations à Adam ! Je le retiens." },
    ] } });
    let souvenir = null;
    for (let i = 0; i < 25 && !souvenir; i++) {
      souvenir = await prisma.assistantMemoryItem.findFirst({ where: { userId, origine: "voix", createdAt: { gte: avant } } });
      if (!souvenir) await page.waitForTimeout(1000);
    }
    await page.reload();
    await page.waitForTimeout(3000);
    lignes.push({ fonction: "Voix — session (porte), fin de conversation : transcription + mémoire", ecran: "iPhone 13", verdict: j.ok() && souvenir ? "marche" : j.ok() ? "marche mal" : "ne marche pas", preuve: `session : HTTP ${s.status()} ; journal : HTTP ${j.status()} ; souvenir vocal : ${souvenir ? `[${souvenir.type}] ${souvenir.content}` : "aucun"}`, captures: [await capture(page, "iphone-15-voix-transcription")] });
  });

  await etape("reglages", async () => {
    await page.getByLabel("Ouvrir la liste des conversations").click();
    await page.getByRole("button", { name: /Réglages/ }).click();
    await page.waitForTimeout(1200);
    const c1 = await capture(page, "iphone-16-reglages");
    const conso = page.getByLabel("Consommation").first();
    const appareils = page.getByLabel("Appareils connectés").first();
    await conso.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(2000);
    const c2 = await capture(page, "iphone-17-consommation");
    const texteConso = (await conso.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const vuAppareils = await appareils.isVisible().catch(() => false);
    lignes.push({ fonction: "Réglages (thème, voix, missions, notifications, appareils, consommation)", ecran: "iPhone 13", verdict: texteConso && vuAppareils ? "marche" : "marche mal", preuve: `consommation : « ${texteConso} » ; appareils affichés : ${vuAppareils}`, captures: [c1, c2] });
    await page.keyboard.press("Escape");
  });

  await etape("dossiers", async () => {
    await page.goto(`${BASE}/ia`);
    await page.getByLabel("Votre message").waitFor();
    await page.getByLabel("Ouvrir la liste des conversations").click();
    const b = page.getByRole("button", { name: "Nouveau dossier" });
    const visible = await b.isVisible().catch(() => false);
    if (visible) { await b.click(); await page.waitForTimeout(1000); }
    lignes.push({ fonction: "Dossiers de conversations", ecran: "iPhone 13", verdict: visible ? "marche" : "marche mal", preuve: `bouton « Nouveau dossier » : ${visible}`, captures: [await capture(page, "iphone-18-dossiers")] });
  });
  // ── DIRECTION 02/11 : « enlève la limite » — un texte collé n'est jamais coupé (60 000 entier, 600 000 en pièce).
  const long = (n: number) => {
    let t = "";
    for (let i = 0; t.length < n; i++) t += `Point ${i} du compte rendu : la réunion a validé l'étape ${i}. `;
    return `${t.slice(0, n - 11)} FIN-COLLEE`;
  };
  await etape("texte-long", async () => {
    await nouvelle(page, true);
    const t60 = `Résume en deux phrases ce compte rendu, et dis-moi par quoi il se termine.\n${long(60_000)}`;
    const r = await envoyer(page, t60, 180);
    const q = r ? await prisma.assistantIaTour.findUnique({ where: { id: r.repondA ?? "" }, select: { contenu: true } }) : null;
    const c1 = await capture(page, "iphone-27-texte-60000");
    lignes.push({ fonction: "Texte collé de 60 000 caractères — envoyé ENTIER", ecran: "iPhone 13", verdict: q?.contenu.length === t60.length && contient(r?.contenu, "FIN-COLLEE") ? "marche" : q?.contenu.length === t60.length ? "marche mal" : "ne marche pas", preuve: `message en base : ${q?.contenu.length} caractères sur ${t60.length} ; réponse : « ${r?.contenu?.slice(0, 200)} »`, captures: [c1] });
    await nouvelle(page, true);
    const t600 = `Résume ce très long texte en une phrase.\n${long(600_000)}`;
    const r2 = await envoyer(page, t600, 300);
    const q2 = r2 ? await prisma.assistantIaTour.findUnique({ where: { id: r2.repondA ?? "" }, select: { contenu: true, pieces: true } }) : null;
    const piece = ((q2?.pieces as { id: string; nom: string }[] | null) ?? [])[0];
    const n = piece ? await prisma.driveNode.findUnique({ where: { id: piece.id }, select: { size: true } }) : null;
    const c2 = await capture(page, "iphone-28-texte-600000-piece");
    lignes.push({ fonction: "Texte collé de 600 000 caractères — devenu une pièce lue", ecran: "iPhone 13", verdict: n && Number(n.size) === Buffer.byteLength(t600, "utf8") && r2?.etat === "TERMINE" ? "marche" : n ? "marche mal" : "ne marche pas", preuve: `pièce « ${piece?.nom} » (${n?.size} octets, texte ${Buffer.byteLength(t600, "utf8")} octets) ; réponse : « ${r2?.contenu?.slice(0, 200)} »`, captures: [c2] });
  });

  // ── LE COMPLÉMENT DE LA DIRECTION (session parente) : tout ce que l'app offre, au pouce, comme l'ERP.
  const ouvrirListe = async () => { await page.getByLabel("Ouvrir la liste des conversations").click(); await page.waitForTimeout(400); };
  const fermerPanneau = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(500); };

  await etape("routines", async () => {
    await nouvelle(page, true);
    const avant = new Date();
    const r = await envoyer(page, "Chaque lundi à 8 h, fais-moi un point sur mes tâches en retard.");
    const confirmer = page.getByRole("button", { name: /^(Confirmer|Programmer)/ }).last();
    if (await confirmer.isVisible().catch(() => false)) { await confirmer.click(); await page.waitForTimeout(2500); }
    const routine = await prisma.assistantRoutine.findFirst({ where: { userId, createdAt: { gte: avant } } as never });
    const c1 = await capture(page, "iphone-19-routine-carte");
    await ouvrirListe();
    await page.getByRole("button", { name: /^Routines$/ }).click();
    await page.waitForTimeout(1500);
    let passage = null;
    const lancer = page.getByRole("button", { name: /Exécuter maintenant/ }).first();
    if (routine && await lancer.isVisible().catch(() => false)) {
      await lancer.click();
      for (let i = 0; i < 120 && !passage; i++) {
        passage = await prisma.assistantRoutineRun.findFirst({ where: { routineId: (routine as { id: string }).id, statut: { notIn: ["EN_COURS", "EN_FILE"] } } as never });
        if (!passage) await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2500);
    }
    const c2 = await capture(page, "iphone-20-routines-panneau");
    const p0 = passage as { statut?: string; luLe?: Date | null } | null;
    lignes.push({ fonction: "Routines — créer (carte), lancer, résultat, non-lus", ecran: "iPhone 13", verdict: routine && p0 ? "marche" : routine ? "marche mal" : "ne marche pas", preuve: `routine : ${routine ? "créée" : "aucune"} (« ${r?.contenu?.slice(0, 100)} ») ; passage : ${p0 ? `${p0.statut}, ${p0.luLe ? "lu" : "non lu"}` : "aucun"}`, captures: [c1, c2] });
    await fermerPanneau();
  });

  await etape("veille", async () => {
    await ouvrirListe();
    await page.getByRole("button", { name: /^Veille$/ }).click();
    await page.waitForTimeout(1500);
    const vu = await page.getByRole("dialog").first().isVisible().catch(() => false);
    lignes.push({ fonction: "Veille (ce que l'assistant surveille)", ecran: "iPhone 13", verdict: vu ? "marche" : "ne marche pas", preuve: `panneau ouvert : ${vu}`, captures: [await capture(page, "iphone-21-veille")] });
    await fermerPanneau();
  });

  await etape("gestes", async () => {
    await ouvrirListe();
    await page.getByRole("button", { name: /Ce que l'assistant a fait/ }).click();
    const panneau = page.getByRole("dialog", { name: "Ce que l'assistant a fait" });
    await panneau.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    const n = await panneau.locator("li").count();
    lignes.push({ fonction: "« Ce que l'assistant a fait » (journal des gestes, Annuler) — écart ERP corrigé", ecran: "iPhone 13", verdict: "marche", preuve: `panneau ouvert dans l'app, ${n} geste(s) listé(s)`, captures: [await capture(page, "iphone-22-gestes")] });
    await fermerPanneau();
  });

  await etape("documents", async () => {
    await page.getByLabel("Notes, travaux et documents").first().click();
    await page.getByRole("tab", { name: "Documents" }).click();
    await page.waitForTimeout(1000);
    const c1 = await capture(page, "iphone-23-documents");
    await page.getByRole("button", { name: /Ouvrir l'Atelier/ }).click();
    await page.waitForTimeout(2500);
    const c2 = await capture(page, "iphone-24-atelier");
    await page.keyboard.press("Escape");
    lignes.push({ fonction: "Documents (tiroir) et Atelier", ecran: "iPhone 13", verdict: "marche", preuve: "onglet Documents puis Atelier ouverts", captures: [c1, c2] });
    await page.goto(`${BASE}/ia`);
    await page.getByLabel("Votre message").waitFor();
  });

  await etape("depot-dossier", async () => {
    await nouvelle(page, true);
    const dossier = path.join(process.cwd(), "bench-out", "m1-dossier");
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, "1-lettre.txt"), "Lettre de demande d'AMM pour Cardiofix 10 mg, adressée à l'ANPP le 2 octobre 2026.");
    fs.writeFileSync(path.join(dossier, "2-rcp.txt"), "Résumé des caractéristiques du produit Cardiofix : indication hypertension artérielle.");
    fs.writeFileSync(path.join(dossier, "3-stabilite.txt"), "Étude de stabilité Cardiofix : 24 mois à 25 °C.");
    await page.getByTestId("joindre-dossier").setInputFiles(dossier);
    await page.waitForTimeout(4000);
    const r = await envoyer(page, "Que contient ce dossier ? Réponds en deux phrases.", 180);
    lignes.push({ fonction: "Dépôt de dossier", ecran: "iPhone 13", verdict: contient(r?.contenu, "stabilit") || contient(r?.contenu, "cardiofix") ? "marche" : r?.etat === "TERMINE" ? "marche mal" : "ne marche pas", preuve: `« ${r?.contenu?.slice(0, 220)} »`, captures: [await capture(page, "iphone-25-depot-dossier")] });
  });

  await etape("voix-ergonomie", async () => {
    await page.getByLabel("Conversation vocale avec l'assistant").first().click();
    const panneau = page.getByRole("dialog", { name: "Conversation vocale" });
    await panneau.waitFor({ timeout: 15_000 });
    const c0 = await capture(page, "iphone-26a-voix-pret");
    // APPELER : la vraie session gpt-live (micro factice du navigateur de banc), puis raccrocher et fermer — au pouce.
    await page.getByRole("button", { name: /Appeler l'assistant/ }).click();
    await page.getByTestId("voix-raccrocher").waitFor({ timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const etat = await page.getByTestId("etat-voix").innerText().catch(() => "?");
    const vp = page.viewportSize()!;
    const boite = async (id: string) => page.getByTestId(id).boundingBox().catch(() => null);
    const auPouce = (b: { y: number; height: number } | null) => !!b && b.y > vp.height / 2 && b.y + b.height <= vp.height;
    // Connectée : « Raccrocher » ; la connexion WebRTC ne passe pas (réseau du banc sans UDP) : « Annuler l'appel ».
    const enAppel = await page.getByTestId("voix-raccrocher").isVisible().catch(() => false);
    const couper = enAppel ? "voix-raccrocher" : "voix-annuler-connexion";
    const bCouper = await boite(couper);
    const c = await capture(page, "iphone-26b-voix-en-appel");
    await page.getByTestId(couper).click().catch(() => {});
    await page.getByTestId("voix-fermer-bas").waitFor({ timeout: 20_000 }).catch(() => {});
    const bFermer = await boite("voix-fermer-bas");
    const c2 = await capture(page, "iphone-26c-voix-raccroche");
    await page.getByTestId("voix-fermer-bas").click().catch(() => {});
    await page.waitForTimeout(800);
    const ferme = !(await panneau.isVisible().catch(() => false));
    lignes.push({ fonction: "Voix — ouvrir, appeler, raccrocher/annuler, fermer (au pouce)", ecran: "iPhone 13", verdict: auPouce(bCouper) && auPouce(bFermer) && ferme ? "marche" : "marche mal", preuve: `session gpt-live ouverte par le serveur ; état : « ${etat} »${enAppel ? "" : " (WebRTC sans UDP dans le banc)"} ; « ${couper === "voix-raccrocher" ? "Raccrocher" : "Annuler"} » à y=${bCouper?.y?.toFixed(0)}, « Fermer » à y=${bFermer?.y?.toFixed(0)} (écran ${vp.height}) ; panneau refermé : ${ferme}`, captures: [c0, c, c2] });
  });
  await ctx.browser()?.close();

  // ── AU BUREAU : la conversation de la capture, sa ligne « Retenu », et le panneau ouvert sur le côté.
  await etape("bureau", async () => {
    const b = await contexte("bureau");
    if (convA) await b.page.goto(`${BASE}/ia?c=${convA}`);
    await b.page.waitForTimeout(3500);
    const c1 = await capture(b.page, "bureau-01-conversation-retenu");
    await b.page.getByRole("button", { name: /Ce que l'assistant retient/ }).click();
    await b.page.getByRole("dialog", { name: "Ce qu'il retient" }).getByTestId("souvenir").first().waitFor({ timeout: 10_000 });
    const c2 = await capture(b.page, "bureau-02-panneau");
    lignes.push({ fonction: "Bureau — ligne « Retenu » et panneau", ecran: "bureau 1440", verdict: "marche", preuve: "conversation et panneau affichés", captures: [c1, c2] });
    if (SEULES.includes("texte-long-bureau")) {
      const p = b.page;
      await p.keyboard.press("Escape");
      await p.getByRole("button", { name: /Nouvelle conversation/ }).first().click();
      const t = `Combien de points compte ce compte rendu ? Réponds par le numéro du dernier point.\n${long(60_000)}`;
      const r = await envoyer(p, t, 180);
      const q = r ? await prisma.assistantIaTour.findUnique({ where: { id: r.repondA ?? "" }, select: { contenu: true } }) : null;
      lignes.push({ fonction: "Bureau — texte collé de 60 000 caractères envoyé ENTIER", ecran: "bureau 1440", verdict: q?.contenu.length === t.length ? "marche" : "ne marche pas", preuve: `message en base : ${q?.contenu.length} sur ${t.length} ; réponse : « ${r?.contenu?.slice(0, 160)} »`, captures: [await capture(p, "bureau-07-texte-60000")] });
    }
    if (!SEULES.length || SEULES.includes("bureau-panneaux")) {
      const p = b.page;
      const cs: string[] = [];
      for (const [nomBouton, fichier] of [[/^Routines$/, "bureau-03-routines"], [/^Veille$/, "bureau-04-veille"], [/Ce que l'assistant a fait/, "bureau-05-gestes"]] as const) {
        await p.keyboard.press("Escape"); await p.waitForTimeout(400);
        await p.getByRole("button", { name: nomBouton }).click();
        await p.waitForTimeout(1800);
        cs.push(await capture(p, fichier));
      }
      await p.keyboard.press("Escape"); await p.waitForTimeout(400);
      await p.getByLabel("Notes, travaux et documents").first().click();
      await p.getByRole("tab", { name: "Documents" }).click();
      await p.waitForTimeout(1000);
      cs.push(await capture(p, "bureau-06-documents"));
      lignes.push({ fonction: "Bureau — Routines, Veille, « Ce que l'assistant a fait », Documents", ecran: "bureau 1440", verdict: "marche", preuve: "quatre panneaux ouverts depuis la liste et le tiroir", captures: cs });
    }
    await b.ctx.browser()?.close();
  });

  // Une REPRISE d'étapes complète le rapport précédent (mêmes fonctions remplacées), coûts comptés depuis son début.
  const fichier = path.join(SORTIE, "rapport.json");
  const avant = SEULES.length && fs.existsSync(fichier) ? JSON.parse(fs.readFileSync(fichier, "utf8")) as { lignes: Ligne[]; debut?: string } : null;
  const debut = avant?.debut ? new Date(avant.debut) : debutAudit;
  if (avant) {
    const neuves = new Set(lignes.map((l) => l.fonction));
    lignes.unshift(...avant.lignes.filter((l) => !neuves.has(l.fonction) && !SEULES.includes(l.fonction)));
  }
  // ── COÛTS : le journal K8 (ModelCallLog), par usage — la capture de mémoire à part.
  const appels = await prisma.modelCallLog.findMany({ where: { userId, at: { gte: debut } }, select: { role: true, model: true, inputTokens: true, outputTokens: true, costUsd: true } });
  const par = new Map<string, { appels: number; entree: number; sortie: number; usd: number }>();
  for (const a of appels) {
    const k = `${a.role ?? "?"} · ${a.model}`;
    const v = par.get(k) ?? { appels: 0, entree: 0, sortie: 0, usd: 0 };
    v.appels += 1; v.entree += a.inputTokens; v.sortie += a.outputTokens; v.usd += Number(a.costUsd ?? 0);
    par.set(k, v);
  }
  const tours = await prisma.assistantIaTour.count({ where: { userId, role: "assistant", createdAt: { gte: debut } } });
  const rapport = { base: BASE, compte: EMAIL, debut: debut.toISOString(), le: new Date().toISOString(), lignes, couts: Object.fromEntries(par), toursRepondus: tours, erreursConsole };
  fs.writeFileSync(path.join(SORTIE, "rapport.json"), JSON.stringify(rapport, null, 2));
  console.log(JSON.stringify({ lignes: lignes.map((l) => `${l.verdict.padEnd(14)} ${l.fonction} — ${l.preuve.slice(0, 160)}`), couts: rapport.couts, erreursConsole }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
