/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT K6 (décision 0036) — LA PREUVE SUR SERVEUR RÉEL : pièces reçues par WhatsApp et par mail.
 *
 * Prérequis : la base de banc `amd_bench` semée (`scripts/bench/seed-adam-bench.ts`), et le serveur de production lancé
 * DESSUS, en mode app, avec un faux Meta local pour les médias :
 *
 *   rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render
 *   APP_MODE=adventum-ia DATABASE_URL=…/amd_bench WHATSAPP_APP_SECRET=banc-k6 WHATSAPP_VERIFY_TOKEN=banc-k6-abonnement \
 *     WHATSAPP_TOKEN=banc WHATSAPP_PHONE_ID=106540352242922 WHATSAPP_BASE_URL=http://127.0.0.1:3999/v21.0 \
 *     MAIL_WEBHOOK_SECRET=banc-k6-mail MAIL_PROVIDER=postmark ASSISTANT_IA_MAIL=assistant@adventum-bench.dz \
 *     NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs" npx next start -p 3100
 *   DATABASE_URL=…/amd_bench npx tsx scripts/bench/canaux-k6.ts
 *
 * Ce que le script fait, sur iPhone 13 puis au bureau : se connecter (Super Admin du banc), ouvrir une conversation, DIRE
 * « je t'envoie la lettre du Dr Mansouri par WhatsApp » (VRAI passage du modèle : l'assistant doit ouvrir l'attente), puis
 * appeler le webhook WhatsApp en local (charge réelle de Meta, signature vraie), voir la pièce et la carte arriver dans la
 * conversation, CONFIRMER, et vérifier que la lettre est rangée dans la demande de sponsoring. Puis le mail. Captures dans
 * `bench-out/k6/`, erreurs de console comptées, coût du modèle lu dans `ModelCallLog`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { chromium, devices, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { signerCommeMeta } from "@/platform/ia/canaux/whatsapp";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { outilAttendrePieces } from "@/modules/assistant-ia/api";

const BASE = process.env.K6_BASE ?? "http://localhost:3100";
const SORTIE = path.join(process.cwd(), "bench-out", "k6");
const SUPER = "super@adventum-bench.dz";
const MDP = "Bench12345!";
const TELEPHONE = "0555 41 22 87";
const WA_ID = "213555412287";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% Lettre de demande de sponsoring — Dr Mansouri, CHU Mustapha, congrès de cardiologie\n%%EOF\n");
fs.mkdirSync(SORTIE, { recursive: true });

// ── Le faux Meta : l'URL du média, son contenu, et les réponses envoyées (gardées pour le rapport).
const envoyes: string[] = [];
const faux = http.createServer((req, res) => {
  const u = req.url ?? "";
  if (u.startsWith("/v21.0/MEDIA")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: `http://127.0.0.1:3999/cdn/${u.split("/").pop()}`, mime_type: "application/pdf", file_size: PDF.length }));
  } else if (u.startsWith("/cdn/")) {
    res.setHeader("content-type", "application/pdf");
    res.end(PDF);
  } else if (u.includes("/messages")) {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { envoyes.push((JSON.parse(b) as { text: { body: string } }).text.body); res.end("{}"); });
  } else { res.statusCode = 404; res.end(); }
});

let seq = 0;
async function whatsapp(de: string, nom: string, legende: string): Promise<unknown> {
  seq++;
  const corps = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "102290129340398", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
      contacts: [{ profile: { name: "Super Admin" }, wa_id: de }],
      messages: [{ from: de, id: `wamid.K6${Date.now()}${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "document",
        document: { filename: nom, caption: legende, mime_type: "application/pdf", sha256: "x", id: `MEDIA${seq}` } }],
    } }] }],
  });
  const r = await fetch(`${BASE}/api/canaux/whatsapp`, { method: "POST", body: corps, headers: { "content-type": "application/json", "x-hub-signature-256": signerCommeMeta(corps, process.env.WHATSAPP_APP_SECRET ?? "banc-k6") } });
  return { statut: r.status, corps: await r.json().catch(() => null) };
}

async function mail(de: string, nom: string): Promise<unknown> {
  const corps = JSON.stringify({
    MessageID: `k6-${Date.now()}`, From: de, FromFull: { Email: de }, To: "assistant@adventum-bench.dz", ToFull: [{ Email: "assistant@adventum-bench.dz" }],
    Subject: "Tr: programme du congrès", TextBody: "Ci-joint.", Headers: [], Attachments: [{ Name: nom, Content: PDF.toString("base64"), ContentType: "application/pdf" }],
  });
  const sig = createHmac("sha256", process.env.MAIL_WEBHOOK_SECRET ?? "banc-k6-mail").update(corps, "utf8").digest("hex");
  const r = await fetch(`${BASE}/api/mail/inbound`, { method: "POST", body: corps, headers: { "x-webhook-signature": sig } });
  return { statut: r.status, corps: await r.json().catch(() => null) };
}

async function preparer() {
  const sa = await prisma.user.update({ where: { email: SUPER }, data: { phone: TELEPHONE }, select: { id: true } });
  const ref = "SP-K6-001";
  const spo = await prisma.sponsoringRequest.upsert({
    where: { reference: ref },
    create: { reference: ref, institution: "Service de cardiologie — CHU Mustapha", doctor: "Dr Mansouri", type: "Congrès", requesterId: sa.id, createdById: sa.id, description: "Congrès national de cardiologie, Oran" },
    update: {},
  });
  await prisma.document.deleteMany({ where: { entityType: "SPONSORING", entityId: spo.id } });
  await prisma.assistantIaAttentePieces.updateMany({ where: { userId: sa.id }, data: { etat: "CLOSE" } });
  return { userId: sa.id, spo };
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/e-?mail/i).fill(SUPER);
  await page.getByLabel(/mot de passe/i).fill(MDP);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function scenario(nom: "iphone13" | "bureau", ctx: { userId: string; spo: { id: string; reference: string } }) {
  const navigateur = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const contexte = await navigateur.newContext(nom === "iphone13" ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } });
  const page = await contexte.newPage();
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  page.on("pageerror", (e) => erreurs.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400) erreurs.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const debut = new Date();
  await login(page);
  await page.goto(`${BASE}/ia`);
  await page.getByLabel("Votre message").waitFor({ timeout: 60_000 });

  // 1. L'annonce — VRAI passage du modèle : il doit ouvrir l'attente (`attendre_pieces`).
  const annonce = `Je vais t'envoyer par WhatsApp la lettre de demande du Dr Mansouri pour la demande de sponsoring ${ctx.spo.reference}. Attends-la.`;
  await page.getByLabel("Votre message").fill(annonce);
  await page.getByRole("button", { name: "Envoyer", exact: true }).click();
  const fil = page.getByTestId("fil");
  await fil.getByText(annonce).waitFor({ timeout: 30_000 });
  let attente = null;
  let parLeModele = true;
  for (let i = 0; i < 90 && !attente; i++) {
    attente = await prisma.assistantIaAttentePieces.findFirst({ where: { userId: ctx.userId, createdAt: { gte: debut }, etat: "OUVERTE" } });
    if (!attente) await page.waitForTimeout(1000);
  }
  if (!attente) {
    // Le modèle n'a pas ouvert l'attente (crédit épuisé, panne) : l'OUTIL est appelé tel que le modèle l'appellerait — dit au rapport.
    parLeModele = false;
    const u = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const moi = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    const conv = new URL(page.url()).searchParams.get("c");
    await outilAttendrePieces(moi, conv).run({ description: "lettre de demande du Dr Mansouri", canaux: "whatsapp", demande: ctx.spo.reference, natureDemande: "sponsoring" }, moi);
    attente = await prisma.assistantIaAttentePieces.findFirst({ where: { userId: ctx.userId, createdAt: { gte: debut }, etat: "OUVERTE" } });
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(SORTIE, `${nom}-1-annonce.png`), fullPage: false });

  // 2. La pièce arrive par WhatsApp (webhook local, signature vraie).
  const wa = await whatsapp(WA_ID, `Lettre Dr Mansouri ${nom}.pdf`, "la lettre pour le congrès");
  await fil.getByText(/J'ai reçu/).last().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SORTIE, `${nom}-2-piece-recue.png`), fullPage: false });

  // 3. Confirmer la carte → la lettre est rangée dans la demande.
  const bouton = page.getByRole("button", { name: /^(Confirmer|Signer)/ }).last();
  let range = 0;
  if (await bouton.isVisible().catch(() => false)) {
    await bouton.click();
    for (let i = 0; i < 30 && !range; i++) {
      range = await prisma.document.count({ where: { entityType: "SPONSORING", entityId: ctx.spo.id, name: `Lettre Dr Mansouri ${nom}.pdf` } });
      if (!range) await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SORTIE, `${nom}-3-rangee.png`), fullPage: false });
  }
  await navigateur.close();
  return { ecran: nom, attenteOuverteParLeModele: parLeModele && !!attente, attenteOuverte: !!attente, attente: attente?.description ?? null, cible: attente?.cibleLibelle ?? null, webhook: wa, rangeeDansLaDemande: range === 1, erreursConsole: erreurs };
}

async function main() {
  await new Promise<void>((r) => faux.listen(3999, "127.0.0.1", () => r()));
  const ctx = await preparer();
  const debut = new Date();
  const resultats = [];
  for (const e of ["iphone13", "bureau"] as const) resultats.push(await scenario(e, ctx));
  const inconnu = await whatsapp("213699000111", "Inconnu.pdf", "");
  const courrier = await mail(SUPER, "Programme du congrès.pdf");
  const appels = await prisma.modelCallLog.findMany({ where: { userId: ctx.userId, at: { gte: debut } }, select: { model: true, inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true } });
  const cout = appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0);
  const journal = await prisma.assistantIaReception.findMany({ where: { createdAt: { gte: debut } }, select: { canal: true, issue: true, expediteur: true, nom: true }, orderBy: { createdAt: "asc" } });
  const rapport = { resultats, inconnu, courrier, reponsesWhatsApp: envoyes, journal, modele: { appels: appels.length, jetonsEntree: appels.reduce((s, a) => s + a.inputTokens, 0), jetonsSortie: appels.reduce((s, a) => s + a.outputTokens, 0), coutUsd: Number(cout.toFixed(4)), modeles: [...new Set(appels.map((a) => a.model))] } };
  fs.writeFileSync(path.join(SORTIE, "rapport.json"), JSON.stringify(rapport, null, 2));
  console.log(JSON.stringify(rapport, null, 2));
  faux.close();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
