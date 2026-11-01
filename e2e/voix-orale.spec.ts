import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE (lot K9, décision 0039) — serveur RÉEL (mode app `APP_MODE=adventum-ia`), au bureau et sur
 * iPhone 13 (390 × 844).
 *
 * Le média WebRTC ne passe pas le conteneur et le crédit du fournisseur est épuisé : la connexion GPT-Live est REMPLACÉE
 * dans le navigateur (un faux `RTCPeerConnection` dont le canal d'événements est piloté par le test), la réponse SDP
 * aussi ; TOUT LE RESTE EST RÉEL — nos routes `/voix/delegation`, `/voix/travail`, le fil, la base. On rejoue un
 * scénario oral : la personne parle, GPT-Live délègue, notre serveur rend AUSSITÔT « je regarde, je te préviens », le
 * navigateur suit le travail, et la voix reçoit d'elle-même la suite (ici l'échec dit — aucun modèle ne répond dans
 * cette suite). 0 erreur console.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
test.use({
  permissions: ["microphone"],
  launchOptions: {
    executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const prisma = new PrismaClient();
test.afterAll(async () => {
  await prisma.assistantIaVoixSession.deleteMany({ where: { id: { startsWith: "live_e2e_" } } });
  await prisma.$disconnect();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Le faux GPT-Live du navigateur : la connexion réussit, le canal d'événements est piloté par `window.__voix`. */
function fauxGptLive() {
  type Canal = { readyState: string; onmessage: ((m: { data: string }) => void) | null; onclose: (() => void) | null; send: (s: string) => void; close: () => void };
  const etat = { envoyes: [] as Record<string, unknown>[], canal: null as Canal | null };
  (window as unknown as { __voix: unknown }).__voix = {
    etat,
    emettre: (e: Record<string, unknown>) => etat.canal?.onmessage?.({ data: JSON.stringify(e) }),
  };
  class FauxPc {
    iceGatheringState = "complete";
    localDescription: { sdp: string } | null = null;
    ontrack: unknown = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    createDataChannel() {
      const c: Canal = { readyState: "open", onmessage: null, onclose: null, send: (s) => etat.envoyes.push(JSON.parse(s)), close: () => { c.readyState = "closed"; } };
      etat.canal = c;
      return c;
    }
    async createOffer() { return { type: "offer", sdp: "v=0 offre-e2e" }; }
    async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
    async setRemoteDescription() {}
    close() {}
  }
  (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FauxPc;
}

const commentaires = (page: Page) => page.evaluate(() => (window as unknown as { __voix: { etat: { envoyes: { type: string; content?: string }[] } } }).__voix.etat.envoyes
  .filter((e) => e.type === "session.commentary.append").map((e) => String(e.content ?? "")));

for (const ecran of [{ nom: "bureau", largeur: 1440, hauteur: 900 }, { nom: "iphone13", largeur: 390, hauteur: 844 }] as const) {
  test(`voix orale (${ecran.nom}) — la délégation ne bloque pas, le résultat revient de lui-même, 0 erreur console`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: ecran.largeur, height: ecran.hauteur });
    const erreurs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.addInitScript(fauxGptLive);

    const moi = await prisma.user.findUniqueOrThrow({ where: { email: E2E.superAdminEmail }, select: { id: true } });
    const session = `live_e2e_${ecran.nom}_${Date.now().toString(36)}`;
    // La session que notre serveur aurait ouverte chez le fournisseur (l'échange SDP est la seule chose simulée).
    await prisma.assistantIaVoixSession.create({ data: { id: session, userId: moi.id } });
    await page.route("**/api/assistant-ia/voix/session", (r) => r.fulfill({ status: 201, json: { session, sdp: "v=0 reponse-e2e", modele: "gpt-live-1", reprises: [] } }));

    await login(page);
    await page.goto("/ia");
    await expect(page.getByTestId("accueil")).toBeVisible({ timeout: 30_000 });
    const panneau = page.getByRole("dialog", { name: "Conversation vocale" });
    // Le bouton est rendu avant l'hydratation : on clique jusqu'à ce que le panneau s'ouvre.
    await expect(async () => {
      await page.getByTestId("voix-temps-reel").first().click();
      await expect(panneau).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(panneau.getByText(/Tout se fait à l.oral/)).toBeVisible();
    await expect(panneau.getByText(/à l.écran|confirmez/i)).toHaveCount(0);
    await panneau.getByRole("button", { name: /Appeler l'assistant|Parler à l'assistant/ }).click();
    await page.waitForFunction(() => !!(window as unknown as { __voix: { etat: { canal: unknown } } }).__voix.etat.canal);

    const emettre = (e: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __voix: { emettre: (e: unknown) => void } }).__voix.emettre(x), e);
    await emettre({ type: "session.started", session: { id: session } });
    await expect(page.getByTestId("etat-voix")).toContainText("À l'écoute");
    await emettre({ type: "session.input_transcript.delta", delta: "Combien de visites j'ai demain ?", start_ms: 0, end_ms: 1400 });
    await emettre({ type: "session.delegation.created", offset_ms: 1500, delegation: { id: "deleg_1", type: "delegation", target: "client" } });

    // AUSSITÔT : « je regarde, je te préviens » — la voix n'attend pas la recherche.
    await expect.poll(async () => (await commentaires(page))[0] ?? "", { timeout: 20_000 }).toContain("préviens dès que c'est prêt");
    await page.screenshot({ path: `e2e-screenshots/voix-orale-${ecran.nom}-1-attente.png` });

    // Puis, sans rien demander, la suite du travail revient à la voix (ici : aucun modèle ne répond dans cette suite).
    await expect.poll(async () => (await commentaires(page)).length, { timeout: 90_000 }).toBeGreaterThan(1);
    const suite = (await commentaires(page))[1];
    expect(suite).toMatch(/n'a pas pu répondre|.+/);
    expect(suite).not.toMatch(/écran/);
    await page.screenshot({ path: `e2e-screenshots/voix-orale-${ecran.nom}-2-resultat.png` });

    // Le panneau tient à la largeur du téléphone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await panneau.getByRole("button", { name: "Raccrocher" }).click();
    expect(erreurs, erreurs.join("\n")).toEqual([]);
  });
}
